import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@kriya/store";
import type { RunChat } from "@kriya/adapters";
import { main, openRun } from "../src/commands.js";
import { runChatBrief, talkRun } from "../src/chat.js";
import { loadProject } from "../src/project.js";

/** Talking to the whole run (D-95), from the terminal, with the fake chat (no key, no cost). */

async function kriya(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A fake Part 3 with its shot list approved, waiting on its shots' picks. */
async function part(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kriya-run-chat-"));
  expect((await kriya(dir, "init", "p3", "--example", "mohalla-mitra")).code).toBe(0);
  const cwd = join(dir, "p3");
  await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x", "--id", "p3");
  await kriya(cwd, "decide", "p3:approve_shots", "approve");
  return cwd;
}

async function opened<T>(cwd: string, f: (o: Awaited<ReturnType<typeof openRun>>, project: ReturnType<typeof loadProject>) => Promise<T> | T): Promise<T> {
  const project = loadProject(cwd);
  const store = openStore(join(cwd, ".kriya"));
  try {
    return await f(await openRun(project, store, "p3", { out: () => {}, err: () => {}, cwd }), project);
  } finally {
    store.close();
  }
}

describe("kriya chat <run>", () => {
  it("talks to the whole run when no step is named, and keeps the conversation on the run", async () => {
    const cwd = await part();
    const r = await kriya(cwd, "chat", "p3", "where are we?");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^kriya: \(fake chat\) p3 has \d+ steps going\. You said: where are we\?/);
    expect((await kriya(cwd, "chat", "p3")).out).toMatch(/^you: where are we\?\nkriya: \(fake chat\) p3 has/);
    expect((await kriya(cwd, "chat", "p3", "shot_list")).out).toBe('Nothing said to shot_list yet. Say something: kriya chat p3 shot_list "why is v2 darker?"');
  });

  it("does what it asks on the step it names, the way that step's chat would", async () => {
    const cwd = await part();
    const r = await kriya(cwd, "chat", "p3", "per_shot[S1].draw: lock v3, the sky is right");
    expect(r.out).toContain("· Draw the shot: locked v3");
    expect((await kriya(cwd, "status", "p3")).out).toContain("per_shot[S1].draw · locked 1.3");
    expect((await kriya(cwd, "log", "p3", "per_shot[S1].pick")).out).toContain("the sky is right");
    await opened(cwd, ({ rec }) => expect(rec.state.nodes["per_shot[S1].draw"]!.thread).toEqual([]));
  });

  it("patches the shot list from anywhere: one shot added, the others kept, nothing locked (D-89)", async () => {
    const cwd = await part();
    const first = await opened(cwd, ({ rec }) => (rec.state.nodes.shot_list!.versions["1.1"]!.output.shots as Record<string, unknown>[])[0]!);
    const edits = JSON.stringify([{ op: "add", field: "shots", after: "S1", item: { ...first, id: "S1a", action: "Mitra notices the leak" } }]);
    const r = await kriya(cwd, "chat", "p3", `shot_list: patch v1 ${edits}`);
    expect(r.out).toContain("· Break it into shots: made v2 from v1: added S1a after S1. Nothing is locked yet");
    expect((await kriya(cwd, "status", "p3")).out).toContain("shot_list · locked 1.1");
  });

  it("an action on a step that isn't there, or has no versions, is said, not done", async () => {
    const cwd = await part();
    expect((await kriya(cwd, "chat", "p3", "per_shot[S1].drwa: lock v2")).out).toContain("· couldn't lock v2 in per_shot[S1].drwa: there's no step 'per_shot[S1].drwa' in this run yet. Did you mean 'per_shot[S1].draw'?");
    expect((await kriya(cwd, "chat", "p3", "per_shot[S1].pick: lock v2")).out).toContain("talk to the step it shows: per_shot[S1].draw");
  });

  it("a mistyped step is still a mistyped step, not a message to the run", async () => {
    const cwd = await part();
    expect((await kriya(cwd, "chat", "p3", "per_shot[S1].drwa", "hi")).err).toContain("there's no step 'per_shot[S1].drwa' in p3 yet. Did you mean 'per_shot[S1].draw'?");
  });
});

describe("what the run's chat is told (D-95)", () => {
  it("every step in a line, the run's own steps whole, a for-each's items only in their line, the rest as the story", async () => {
    const cwd = await part();
    await opened(cwd, ({ rec }, project) => {
      const b = runChatBrief(project, rec.state, "p3", "hi");
      expect(b.run).toEqual({ id: "p3", recipe: "part_recipe" });
      expect(b.steps).toContain("- shot_list: Break it into shots (model) · locked · v1 · locked v1");
      expect(b.steps).toContain("- per_shot[S1].draw: Draw the shot (model) · done · v1–v3");
      expect(b.steps).toContain("- per_shot[S1].pick: Pick one panel (screen) · waiting for you");
      expect(b.whole.map((w) => w.step.key)).toEqual(["shot_list"]);
      expect(b.whole[0]!.shapes[0]).toMatch(/^shot: id \(text\), characters/);
      expect(b.story.locked.find((x) => x.key === "shot_list")).toBeUndefined(); // shown whole already
    });
  });

  it("a lock's why is only ever the creator's own words, and the answer is recorded on the run with its cost (D-29)", async () => {
    const cwd = await part();
    await opened(cwd, async ({ rec, s }, project) => {
      const chat: RunChat = async () => ({ text: "Locked.", actions: [{ step: "per_shot[S1].draw", do: "lock", version: 2, why: "best composition" }], model: "test", cost_usd: 0.03 });
      const { did } = await talkRun(project, s, chat, "p3", "go with v2 for the first shot");
      expect(did).toEqual(["Draw the shot: locked v2"]);
      expect(rec.state.nodes["per_shot[S1].draw"]!.locked).toEqual({ version: "1.2", by: "human" });
      expect(rec.state.thread.at(-1)).toMatchObject({ by: "kriya", did: ["Draw the shot: locked v2"], model: "test", costUsd: 0.03 });
    });
  });

  it("a finished run is frozen: the run's chat talks, but locks nothing", async () => {
    const cwd = await part();
    while (!(await kriya(cwd, "inbox")).out.startsWith("Nothing is waiting on you.")) {
      const inbox = (await kriya(cwd, "inbox")).out;
      const button = /buttons: (\w+)/.exec(inbox)![1]!;
      const pick = /^\s+(v\d+)\s/m.exec(inbox)?.[1];
      const r = await kriya(cwd, "decide", "1", button, ...(pick ? ["--pick", pick] : []));
      expect(r.code, r.err).toBe(0);
    }
    const r = await kriya(cwd, "chat", "p3", "per_shot[S1].draw: lock v3");
    expect(r.out).toContain("· Draw the shot: didn't lock anything: this run is finished, so it stays as it is");
    expect((await kriya(cwd, "status", "p3")).out).toContain("per_shot[S1].draw · locked 1.1");
  });
});
