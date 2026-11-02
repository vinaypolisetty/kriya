import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@kriya/store";
import type { Chat } from "@kriya/adapters";
import { main, openRun } from "../src/commands.js";
import { chatBrief, talk } from "../src/chat.js";
import { loadProject } from "../src/project.js";

/** Talking to a step (D-87), from the terminal, with the fake chat (no key, no cost). */

async function kriya(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A fake Part 3 waiting on its shots' picks. */
async function part(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kriya-chat-"));
  expect((await kriya(dir, "init", "p3", "--example", "mohalla-mitra")).code).toBe(0);
  const cwd = join(dir, "p3");
  await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
  await kriya(cwd, "decide", "1", "approve");
  return cwd;
}

const DRAW = "per_shot[S1].draw";

describe("kriya chat", () => {
  it("answers a question, records both sides, and changes nothing", async () => {
    const cwd = await part();
    const r = await kriya(cwd, "chat", "part_recipe-1", DRAW, "why", "is", "v2", "darker?");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("kriya: (fake chat) Draw the shot has 3 versions. You said: why is v2 darker?");
    expect((await kriya(cwd, "chat", "part_recipe-1", DRAW)).out).toBe("you: why is v2 darker?\nkriya: (fake chat) Draw the shot has 3 versions. You said: why is v2 darker?");
    expect((await kriya(cwd, "show", "part_recipe-1", DRAW)).out).not.toContain("2.1");
  });

  it("makes a new version from the one you name, and the pick shows it", async () => {
    const cwd = await part();
    const r = await kriya(cwd, "chat", "part_recipe-1", DRAW, "make v2 at night");
    expect(r.out).toContain("· making a new version from v2 with edit: make v2 at night");
    expect((await kriya(cwd, "inbox")).out).toMatch(/per_shot\[S1\]\.pick: Pick one panel\n\s+2\.1\s+fake:\/\/image\/per_shot\[S1\]\.edit/);
  });

  it("locks by word: the waiting pick is answered with that version and your reason", async () => {
    const cwd = await part();
    const r = await kriya(cwd, "chat", "part_recipe-1", DRAW, "lock v3, the sky is right");
    expect(r.out).toContain("· locked v3");
    expect((await kriya(cwd, "status", "part_recipe-1")).out).toContain(`${DRAW} · locked 1.3`);
    expect((await kriya(cwd, "inbox")).out).not.toContain("per_shot[S1].pick");
    expect((await kriya(cwd, "log", "part_recipe-1", "per_shot[S1].pick")).out).toContain("the sky is right");
  });

  it("a finished run is frozen: the chat talks, but locks nothing", async () => {
    const cwd = await part();
    while (!(await kriya(cwd, "inbox")).out.startsWith("Nothing is waiting on you.")) {
      const inbox = (await kriya(cwd, "inbox")).out;
      const button = /buttons: (\w+)/.exec(inbox)![1]!;
      const pick = /^\s+(\d+\.\d+)\s/m.exec(inbox)?.[1];
      await kriya(cwd, "decide", "1", button, ...(pick ? ["--pick", pick] : []));
    }
    const r = await kriya(cwd, "chat", "part_recipe-1", DRAW, "lock v3");
    expect(r.out).toContain("· didn't lock anything: this run is finished, so it stays as it is");
    expect((await kriya(cwd, "status", "part_recipe-1")).out).toContain("part_recipe-1 · part_recipe · completed");
    expect((await kriya(cwd, "status", "part_recipe-1")).out).toContain(`${DRAW} · locked 1.1`);
  });

  it("says plainly when the step isn't there, or has nothing of its own to talk about", async () => {
    const cwd = await part();
    expect((await kriya(cwd, "chat", "part_recipe-1", "per_shot[S1].drwa", "hi")).err).toContain("there's no step 'per_shot[S1].drwa' in part_recipe-1 yet. Did you mean 'per_shot[S1].draw'?");
    expect((await kriya(cwd, "chat", "part_recipe-1", "per_shot[S1].pick", "hi")).err).toContain("talk to the step it shows: per_shot[S1].draw");
  });
});

describe("what the chat is told and what it may do", () => {
  it("the brief numbers versions, says why each exists, and names media instead of pasting them", async () => {
    const cwd = await part();
    const project = loadProject(cwd);
    const store = openStore(join(cwd, ".kriya"));
    try {
      const { rec } = await openRun(project, store, "part_recipe-1", { out: () => {}, err: () => {}, cwd }, { readOnly: true });
      const b = chatBrief(project, rec.state, DRAW, "hi");
      expect(b.versions.map((v) => [v.n, v.intention, v.locked])).toEqual([[1, "from recipe", false], [2, "from recipe", false], [3, "from recipe", false]]);
      expect(b.canEdit).toBe(true);
      expect(b.step.asks).toContain("{{item.action}}");
      expect(b.story.locked.find((x) => x.key === "shot_list")).toBeDefined();
      expect(JSON.stringify(b.story.locked)).not.toContain("fake://");
    } finally {
      store.close();
    }
  });

  it("a lock's why is only ever the creator's own words (D-29)", async () => {
    const cwd = await part();
    const project = loadProject(cwd);
    const store = openStore(join(cwd, ".kriya"));
    try {
      const { rec, s } = await openRun(project, store, "part_recipe-1", { out: () => {}, err: () => {}, cwd }, { readOnly: true });
      const chat: Chat = async () => ({ text: "Locked.", actions: [{ do: "lock", version: 2, why: "it has the best composition" }], model: "test", cost_usd: 0.02 });
      const { did } = await talk(project, s, () => rec.state, chat, DRAW, "go with v2");
      expect(did).toEqual(["locked v2"]);
      expect(rec.state.nodes[DRAW]!.locked).toEqual({ version: "1.2", by: "human" });
      expect(rec.state.nodes[DRAW]!.thread.at(-1)).toMatchObject({ by: "kriya", did: ["locked v2"], model: "test", costUsd: 0.02 });
    } finally {
      store.close();
    }
  });

  it("an action that can't be done is said, not thrown", async () => {
    const cwd = await part();
    const project = loadProject(cwd);
    const store = openStore(join(cwd, ".kriya"));
    try {
      const { rec, s } = await openRun(project, store, "part_recipe-1", { out: () => {}, err: () => {}, cwd }, { readOnly: true });
      const chat: Chat = async () => ({ text: "Sure.", actions: [{ do: "lock", version: 9, why: "" }, { do: "make", from: 0, instruction: "  ", how: "redo" }], model: "test", cost_usd: 0 });
      const { did } = await talk(project, s, () => rec.state, chat, DRAW, "lock v9 and redo it");
      expect(did).toEqual(["couldn't lock v9: there's no v9", "couldn't make a new version: say what to change, e.g. \"make it night\""]);
    } finally {
      store.close();
    }
  });
});
