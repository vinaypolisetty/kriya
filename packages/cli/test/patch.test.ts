import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@kriya/store";
import { main, openRun } from "../src/commands.js";
import { chatBrief } from "../src/chat.js";
import { loadProject } from "../src/project.js";

/** Patching a version by key (D-89) from the terminal and the step chat, with fake models (no key, no cost). */

async function kriya(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A fake Part 3 with its shot list approved. */
async function part(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kriya-patch-"));
  expect((await kriya(dir, "init", "p3", "--example", "mohalla-mitra")).code).toBe(0);
  const cwd = join(dir, "p3");
  await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x", "--id", "p3");
  await kriya(cwd, "decide", "p3:approve_shots", "approve");
  return cwd;
}

/** The shot list's versions as they are recorded: id → shot ids in order. */
async function shotLists(cwd: string): Promise<Record<string, { ids: string[]; shots: Record<string, unknown>[] }>> {
  const project = loadProject(cwd);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec } = await openRun(project, store, "p3", { out: () => {}, err: () => {}, cwd });
    return Object.fromEntries(
      Object.values(rec.state.nodes.shot_list!.versions).map((v) => {
        const shots = v.output.shots as Record<string, unknown>[];
        return [v.id, { ids: shots.map((s) => String(s.id)), shots }];
      }),
    );
  } finally {
    store.close();
  }
}

describe("kriya patch", () => {
  it("adds a shot after another from a file, keeps every other shot exactly, and locks nothing", async () => {
    const cwd = await part();
    const before = (await shotLists(cwd))["1.1"]!;
    const s1a = { ...before.shots[0], id: "S1a", action: "Mitra notices the leak" };
    writeFileSync(join(cwd, "leak.yaml"), JSON.stringify([{ op: "add", field: "shots", after: "S1", item: s1a }]));
    const r = await kriya(cwd, "patch", "p3", "shot_list", "v1", "@leak.yaml", "--note", "see the leak before the reveal");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("✓ Made v2 of shot_list from v1 (2.1), at no cost:\n    added S1a after S1\n  Nothing is locked yet. To use it: kriya lock p3 shot_list 2.1");
    const after = (await shotLists(cwd))["2.1"]!;
    expect(after.ids).toEqual(["S1", "S1a", ...before.ids.slice(1)]);
    expect(after.shots.filter((x) => x.id !== "S1a")).toEqual(before.shots);
    expect((await kriya(cwd, "status", "p3")).out).toContain("shot_list · locked 1.1");
  });

  it("says plainly what's wrong: a misspelt shot, unreadable edits, a version that isn't there", async () => {
    const cwd = await part();
    const remove = (key: string) => JSON.stringify({ op: "remove", field: "shots", key });
    expect((await kriya(cwd, "patch", "p3", "shot_list", "v1", remove("S7"))).err).toContain("edit 1 (remove shots): there's no 'S7' in shots. Did you mean 'S1'?");
    expect((await kriya(cwd, "patch", "p3", "shot_list", "v1", "[{op: cut}]")).err).toContain("edit 1 doesn't look right");
    expect((await kriya(cwd, "patch", "p3", "shot_list", "v9", remove("S1"))).err).toContain("there's no version 'v9'; this step has v1 (1.1)");
    expect((await kriya(cwd, "patch", "p3", "shot_lst", "v1", remove("S1"))).err).toContain("Did you mean 'shot_list'?");
  });
});

describe("the step chat patches instead of making the list again", () => {
  it("cuts a shot by its id, and says what it did", async () => {
    const cwd = await part();
    const r = await kriya(cwd, "chat", "p3", "shot_list", `patch v1 [{"op":"remove","field":"shots","key":"S3"}]`);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("· made v2 from v1: removed S3. Nothing is locked yet");
    expect((await shotLists(cwd))["2.1"]!.ids).toEqual(["S1", "S2"]);
  });

  it("is told what the step's lists hold, so it can write a whole new item", async () => {
    const cwd = await part();
    const project = loadProject(cwd);
    const store = openStore(join(project.root, ".kriya"));
    try {
      const { rec } = await openRun(project, store, "p3", { out: () => {}, err: () => {}, cwd });
      const brief = chatBrief(project, rec.state, "shot_list", "add a shot");
      expect(brief.shapes[0]).toBe("shot: id (text), characters (list<library.character>), place (library.place), action (text), lines (list<line>), animate (boolean), music (text)");
      expect(brief.shapes[1]).toMatch(/^line: id \(text\), speaker \(library\.character\)/);
    } finally {
      store.close();
    }
  });
});
