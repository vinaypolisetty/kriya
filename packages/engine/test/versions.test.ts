import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir, loadText } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Decision, type Executors, type Graph, type StepContext } from "../src/index.js";

/** The series' locked context the Mohalla Mitra recipes inherit. */
const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };

/** A fake Library where every facet exists at v1. */
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const example = (id: string) => graphs.find((g) => g.graph === id)!;

type Calls = Record<string, StepContext[]>;

/** Fakes that remember what each step and screen was given. A decision of `undefined` means "no answer yet". */
function fakes(
  outputs: Record<string, (c: StepContext) => Record<string, unknown>[]>,
  decisions: Record<string, (c: StepContext) => Decision | undefined> = {},
): Executors & { calls: Calls } {
  const calls: Calls = {};
  return {
    calls,
    produce(node, ctx) {
      (calls[node.id] ??= []).push(ctx);
      return outputs[node.id]?.(ctx) ?? [{ done: true }];
    },
    decide(node, ctx) {
      (calls[`screen:${node.id}`] ??= []).push(ctx);
      const d = decisions[node.id];
      if (!d && node.name?.startsWith("Approve '")) return { action: "approve" }; // generated approvals (D-42)
      if (!d) throw new Error(`no decision for '${node.id}'`);
      return d(ctx);
    },
  };
}

function start(g: Graph, exec: Executors, inputs: Record<string, unknown> = {}) {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(g, rec, exec, graphs, LIBRARY);
  s.start("a".repeat(64), inputs, SERIES);
  s.run();
  return { s, rec, events: () => readRun(log, "run1") };
}

const id = (c: StepContext) => (c.inputs.item as { id: string }).id;
const panels = (c: StepContext) => [1, 2, 3].map((i) => ({ image: `img:${id(c)}:a${c.visit}c${i}` }));
const edited = (c: StepContext) => [{ image: `${(c.parent!.output as { image: string }).image}+${c.instruction}` }];

describe("edits become new versions of the step they refine (D-44)", () => {
  const shot = { item: { id: "P3-04", animate: false } };

  it("the edited panel is draw's next version, with its parent and instruction", () => {
    const exec = fakes({ draw: panels, edit: edited }, { pick: (c) => (c.visit === 1 ? { action: "edit", selection: ["1.3"], note: "add the gamcha" } : { action: "lock", selection: [c.shows!.at(-1)!.version] }) });
    const { rec } = start(example("shot_recipe"), exec, shot);
    const draw = rec.state.nodes.draw!;
    expect(draw.versions["2.1"]).toMatchObject({ parents: ["1.3"], instruction: "add the gamcha", madeBy: "edit", output: { image: "img:P3-04:a1c3+add the gamcha" } });
    expect(draw.locked?.version).toBe("2.1");
    expect(rec.state.nodes.edit?.versions).toEqual({}); // edit keeps no versions of its own
  });

  it("the pick screen shows the edited panel the second time", () => {
    const exec = fakes({ draw: panels, edit: edited }, { pick: (c) => (c.visit === 1 ? { action: "edit", selection: ["1.3"], note: "add the gamcha" } : { action: "lock", selection: [c.shows!.at(-1)!.version] }) });
    start(example("shot_recipe"), exec, shot);
    const [first, second] = exec.calls["screen:pick"]!;
    expect(first!.shows!.map((s) => s.version)).toEqual(["1.1", "1.2", "1.3"]);
    expect(second!.shows).toEqual([{ version: "2.1", value: "img:P3-04:a1c3+add the gamcha" }]);
  });

  it("the edit step gets the panel it starts from and the instruction", () => {
    const exec = fakes({ draw: panels, edit: edited }, { pick: (c) => (c.visit === 1 ? { action: "edit", selection: ["1.2"], note: "warmer light" } : { action: "lock", selection: [c.shows!.at(-1)!.version] }) });
    start(example("shot_recipe"), exec, shot);
    const ctx = exec.calls.edit![0]!;
    expect(ctx.parent).toEqual({ version: "1.2", output: { image: "img:P3-04:a1c2" } });
    expect(ctx.instruction).toBe("warmer light");
  });

  it("a too-long line's faster take is what listen plays and locks", () => {
    const exec = fakes(
      { speak: () => [{ audio: "slow.wav", seconds: 9 }], too_long: () => [{ audio: "fast.wav", seconds: 7 }] },
      { listen: () => ({ action: "approve" }) },
    );
    const { rec } = start(example("voice_recipe"), exec, { item: { id: "L1" } });
    expect(exec.calls["screen:listen"]![0]!.shows).toEqual([{ version: "2.1", value: "fast.wav" }]);
    const speak = rec.state.nodes.speak!;
    expect(speak.locked?.version).toBe("2.1");
    expect(speak.versions["2.1"]).toMatchObject({ parents: ["1.1"], madeBy: "too_long" });
  });
});

describe("waiting for a person", () => {
  it("a screen with no answer yet keeps the run open, and answer() continues it", () => {
    const exec = fakes({ draw: panels }, { pick: () => undefined });
    const { s, rec } = start(example("shot_recipe"), exec, { item: { id: "P3-04", animate: false } });
    expect(rec.state.status).toBe("running");
    expect(rec.state.nodes.pick?.status).toBe("awaiting_human");

    s.answer("pick", { action: "lock", selection: ["1.2"] });
    s.run();
    expect(rec.state.status).toBe("completed");
    expect(rec.state.nodes.draw?.locked?.version).toBe("1.2");
  });

  it("says plainly when a step isn't waiting", () => {
    const exec = fakes({ draw: panels }, { pick: () => undefined });
    const { s } = start(example("shot_recipe"), exec, { item: { id: "P3-04", animate: false } });
    expect(() => s.answer("draw", { action: "lock" })).toThrow("step 'draw' isn't waiting for an answer");
  });
});

describe("replay_change (D-30)", () => {
  const shots = [
    { id: "P3-01", animate: false },
    { id: "P3-02", animate: false },
    { id: "P3-03", animate: false },
  ];
  const part = () => {
    // P3-01 gets the gamcha fix and is locked; the other two wait on their pick screens.
    const exec = fakes(
      { shot_list: () => [{ shots, lines: [], hook: "" }], draw: panels, edit: edited },
      {
        approve_shots: () => ({ action: "approve" }),
        pick: (c) => (id(c) !== "P3-01" ? undefined : c.visit === 1 ? { action: "edit", selection: ["1.1"], note: "add the gamcha" } : { action: "lock", selection: [c.shows!.at(-1)!.version] }),
      },
    );
    return { exec, ...start(example("part_recipe"), exec, { story_pages: "…", part_no: 3 }) };
  };

  it("re-applies one shot's fix to other shots, each from its own panel", () => {
    const { s, rec, exec } = part();
    const made = s.replayChange("per_shot[P3-01].draw", "2.1", ["per_shot[P3-02].draw", "per_shot[P3-03].draw"]);
    expect(made).toEqual({ "per_shot[P3-02].draw": ["2.1"], "per_shot[P3-03].draw": ["2.1"] });

    const v = rec.state.nodes["per_shot[P3-02].draw"]!.versions["2.1"]!;
    expect(v).toMatchObject({ instruction: "add the gamcha", replayedFrom: "per_shot[P3-01].draw@2.1", madeBy: "per_shot[P3-02].edit", parents: ["1.3"] });
    expect(v.output).toEqual({ image: "img:P3-02:a1c3+add the gamcha" });
    expect(exec.calls.edit!.at(-1)!.instruction).toBe("add the gamcha");
  });

  it("locks nothing: the replayed versions wait for you", () => {
    const { s, rec } = part();
    s.replayChange("per_shot[P3-01].draw", "2.1", ["per_shot[P3-02].draw"]);
    expect(rec.state.nodes["per_shot[P3-02].draw"]?.locked).toBeUndefined();
    s.answer("per_shot[P3-02].pick", { action: "lock", selection: ["2.1"] });
    expect(rec.state.nodes["per_shot[P3-02].draw"]?.locked?.version).toBe("2.1");
  });

  it("refuses a version with no instruction", () => {
    const { s } = part();
    expect(() => s.replayChange("per_shot[P3-01].draw", "1.2", ["per_shot[P3-02].draw"])).toThrow(
      "version 1.2 of 'per_shot[P3-01].draw' wasn't made from an instruction, so there's nothing to replay",
    );
  });

  it("replays to the same state", () => {
    const { s, rec, events } = part();
    s.replayChange("per_shot[P3-01].draw", "2.1", ["per_shot[P3-02].draw", "per_shot[P3-03].draw"]);
    expect(replay(events())).toEqual(rec.state);
  });
});

describe("branches", () => {
  const paused = () => {
    const exec = fakes({ draw: panels, edit: edited }, { pick: () => undefined });
    return start(example("shot_recipe"), exec, { item: { id: "P3-04", animate: false } });
  };

  it("new versions go on the branch you switched to; the others are kept", () => {
    const { s, rec } = paused();
    s.branch("draw", "darker", "1.2");
    s.answer("pick", { action: "edit", selection: ["1.2"], note: "darker sky" });
    s.run(); // edit runs, pick waits again
    const draw = rec.state.nodes.draw!;
    expect(draw.branches.darker).toEqual({ from: "1.2" });
    expect(draw.versions["2.1"]?.branch).toBe("darker");
    expect(draw.versions["1.1"]?.branch).toBe("main");

    s.switchBranch("draw", "main");
    expect(rec.state.nodes.draw?.branch).toBe("main");
    s.lock("draw", "2.1", "the darker one");
    expect(rec.state.nodes.draw?.locked).toEqual({ version: "2.1", by: "human", why: "the darker one" });
  });

  it("refuses a duplicate branch, an unknown branch and a bad name", () => {
    const { s } = paused();
    s.branch("draw", "darker", "1.2");
    expect(() => s.branch("draw", "darker", "1.1")).toThrow("there's already a branch called 'darker'");
    expect(() => s.switchBranch("draw", "brighter")).toThrow("there's no branch called 'brighter'");
    expect(() => s.branch("draw", "Darker Sky", "1.1")).toThrow(/lowercase letters/);
  });

  it("replays to the same state", () => {
    const { s, rec, events } = paused();
    s.branch("draw", "darker", "1.2");
    s.answer("pick", { action: "edit", selection: ["1.2"], note: "darker sky" });
    s.run();
    expect(replay(events())).toEqual(rec.state);
  });
});

describe("validating refines", () => {
  const errs = (yaml: string) => loadText(`graph: g\nlevel: part\n${yaml}`).problems.filter((p) => p.severity === "error").map((p) => p.message);
  const base = `  - { id: draw, kind: model, capability: image.generate, out: { image: image } }\n`;

  it("needs a step that exists", () => expect(errs(`nodes:\n${base}  - { id: edit, kind: model, capability: image.edit, refines: drw }\n`)[0]).toMatch(/refines 'drw', which isn't a step\. Did you mean 'draw'/));
  it("can't refine itself", () => expect(errs(`nodes:\n  - { id: draw, kind: model, capability: image.generate, refines: draw }\n`)[0]).toBe("a step can't refine itself"));
  it("can't refine a screen", () => expect(errs(`nodes:\n  - { id: s, kind: screen, review: approve, actions: [{ id: ok }] }\n  - { id: edit, kind: model, capability: image.edit, refines: s }\n`)[0]).toMatch(/'s' is a screen step; only model, agent and tool steps make versions/));
  it("outputs must match", () => {
    const e = errs(`nodes:\n${base}  - { id: voice, kind: model, capability: audio.speech, refines: draw, out: { image: audio } }\n`);
    expect(e[0]).toBe("'image' is audio here but image in 'draw'");
  });
  it("can't add outputs the refined step doesn't have", () => {
    const e = errs(`nodes:\n${base}  - { id: edit, kind: model, capability: image.edit, refines: draw, out: { imag: image } }\n`);
    expect(e[0]).toMatch(/'draw' has no output 'imag'.*Did you mean 'image'/);
  });
});
