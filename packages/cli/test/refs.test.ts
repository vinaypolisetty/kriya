import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@kriya/store";
import { main, openRun } from "../src/commands.js";
import { pointables, pointsIn } from "../src/refs.js";
import { loadProject } from "../src/project.js";

/** Pointing at things with @ in a step's chat (D-96): what can be picked, and what the chat is shown. */

async function kriya(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A fake Part 3 waiting on its shots' picks, with Mitra and the Chai stall in the Library. */
async function part(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kriya-refs-"));
  expect((await kriya(dir, "init", "p3", "--example", "mohalla-mitra")).code).toBe(0);
  const cwd = join(dir, "p3");
  writeFileSync(join(cwd, "library", "mitra.yaml"), "name: Mitra\nkind: character\nlook: { image: sheets/mitra.png, words: a thin 60-year-old bald man }\nvoice: Charon\n");
  writeFileSync(join(cwd, "library", "chai-stall.yaml"), "name: Chai stall\nkind: place\nlook: { words: a blue tin stall under a neem tree }\n");
  await kriya(cwd, "run", "part_recipe", "--input", "part_no=3", "--input", "story_pages=x");
  await kriya(cwd, "decide", "1", "approve");
  return cwd;
}

const DRAW = "per_shot[S1].draw";

async function withRun<T>(cwd: string, fn: (a: { project: ReturnType<typeof loadProject>; state: Awaited<ReturnType<typeof openRun>>["rec"]["state"] }) => T): Promise<T> {
  const project = loadProject(cwd);
  const store = openStore(join(cwd, ".kriya"));
  try {
    const { rec } = await openRun(project, store, "part_recipe-1", { out: () => {}, err: () => {}, cwd });
    return fn({ project, state: rec.state });
  } finally {
    store.close();
  }
}

describe("@ in a step's chat", () => {
  it("lists the Library, then the run's steps nearest first, then the for-each items: not this step, not reviews", async () => {
    const cwd = await part();
    await withRun(cwd, ({ project, state }) => {
      const refs = pointables(project, state, DRAW);
      expect(refs.slice(0, 4).map((p) => [p.ref, p.kind])).toEqual([["Library", "library"], ["Chai stall", "entity"], ["Mitra", "entity"], ["shot_list", "step"]]);
      expect(refs.find((p) => p.ref === "Mitra")!.label).toBe("character: look, voice");
      expect(refs.find((p) => p.ref === "shot_list")!.label).toMatch(/: 1 version, v1 locked$/);
      const keys = refs.map((p) => p.ref);
      expect(keys).toContain("per_shot[S2].draw");
      expect(keys).toContain("per_shot[S2]");
      expect(keys).not.toContain(DRAW); // this step
      expect(keys).not.toContain("per_shot[S1]"); // the item it's in
      expect(keys).not.toContain("approve_shots"); // a review has no versions to show
      expect(keys).not.toContain("per_shot[S2].pick");
    });
  });

  it("shows the chat what's pointed at: an entity as it reads in this run, a step's locked version, a version by number", async () => {
    const cwd = await part();
    await withRun(cwd, ({ project, state }) => {
      const points = pointsIn(project, state, DRAW, "@Chai stall at dusk, like @per_shot[S2].draw v2, and @Mitra's look. Is @shot_list right?");
      expect(points.map((p) => p.ref)).toEqual(["@Chai stall", "@per_shot[S2].draw v2", "@Mitra", "@shot_list"]);
      expect(points[0]).toMatchObject({ what: "Chai stall, a place in the Library, as it reads in this run", value: { look: { words: "a blue tin stall under a neem tree" } }, images: [] });
      expect(points[1]!.what).toMatch(/^the step .+ \(per_shot\[S2\]\.draw\), v2 \(not locked\); made from recipe$/);
      expect(points[2]!.images).toEqual(["sheets/mitra.png"]);
      expect(points[3]!.what).toContain("(shot_list), v1 (locked)");
      expect(points[3]!.value).toEqual(state.nodes.shot_list!.versions[state.nodes.shot_list!.locked!.version]!.output);
    });
  });

  it("reads this step and its own versions too, and an item as each of its steps", async () => {
    const cwd = await part();
    await withRun(cwd, ({ project, state }) => {
      const [self, item] = pointsIn(project, state, DRAW, "is @draw v3 like (@voices[L2])?");
      expect(self!.ref).toBe("@draw v3");
      expect(item).toMatchObject({ ref: "@voices[L2]", what: "voices[L2]: each of its steps' locked version, else its latest" });
      expect(Object.keys(item!.value as object)).toEqual(["speak"]);
    });
  });

  it("an email address, a lone @ or a repeat isn't a new point", async () => {
    const cwd = await part();
    await withRun(cwd, ({ project, state }) => {
      expect(pointsIn(project, state, DRAW, "mail a@b.com at @ 5pm")).toEqual([]);
      expect(pointsIn(project, state, DRAW, "@Mitra and @mitra")).toHaveLength(1);
    });
  });

  it("a ref that names nothing, or a version that isn't there, is an error with the nearest names", async () => {
    const cwd = await part();
    await withRun(cwd, ({ project, state }) => {
      expect(() => pointsIn(project, state, DRAW, "like @Mitr.")).toThrow("there's nothing called @Mitr in this run or the Library. Did you mean @Mitra? Type @ in the browser for a list");
      expect(() => pointsIn(project, state, DRAW, "@Mitras")).toThrow("nothing called @Mitras");
      expect(() => pointsIn(project, state, DRAW, "@shot_list v4")).toThrow(/has no v4: it has v1 to v1/);
    });
  });

  it("works from the terminal, and a bad ref records nothing", async () => {
    const cwd = await part();
    const r = await kriya(cwd, "chat", "part_recipe-1", DRAW, "same light as @per_shot[S2].draw?");
    expect(r.code).toBe(0);
    expect(r.out).toContain("You pointed at: @per_shot[S2].draw (the step");
    const bad = await kriya(cwd, "chat", "part_recipe-1", "per_shot[S2].draw", "like @nobody");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("there's nothing called @nobody");
    expect((await kriya(cwd, "chat", "part_recipe-1", "per_shot[S2].draw")).out).toContain("Nothing said to per_shot[S2].draw yet");
  });
});
