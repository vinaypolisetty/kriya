import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir } from "../src/load.js";
import { intention, numbers, Recorder, readRun, replay, Scheduler, type Decision, type Executors, type Graph, type StepContext } from "../src/index.js";

/** A step's conversation (D-87): versions by number, new versions outside the recipe's flow, locks by word. */

const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const shotRecipe = graphs.find((g) => g.graph === "shot_recipe")!;
const SHOT = { item: { id: "P3-04", animate: false } };

type Calls = Record<string, StepContext[]>;

function fakes(
  outputs: Record<string, (c: StepContext) => Record<string, unknown>[] | { ticket: string }>,
  decisions: Record<string, (c: StepContext) => Decision | undefined> = {},
): Executors & { calls: Calls } {
  const calls: Calls = {};
  return {
    calls,
    produce(node, ctx) {
      (calls[node.id] ??= []).push(ctx);
      return outputs[node.id]?.(ctx) ?? [{ done: true }];
    },
    check: (_n, _c, cands) => cands.map((c) => ({ version: c.version, pass: true, issues: [] })),
    decide(node, ctx) {
      (calls[`screen:${node.id}`] ??= []).push(ctx);
      return decisions[node.id]?.(ctx);
    },
  };
}

function start(g: Graph, exec: Executors, inputs: Record<string, unknown> = {}) {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(g, rec, exec, graphs, LIBRARY);
  s.start("a".repeat(64), inputs, SERIES);
  s.run();
  return { s, rec, log, events: () => readRun(log, "run1") };
}

const panels = (c: StepContext) => [1, 2, 3].map((i) => ({ image: `panel:a${c.visit}c${i}${c.instruction ? `:${c.instruction}` : ""}` }));
const edited = (c: StepContext) => [{ image: `${String(c.uses["pick.selected"])}+${String(c.uses["pick.note"])}` }];

/** A shot whose panel 1.2 was picked and locked: the run is finished. */
function finishedShot(outputs: Parameters<typeof fakes>[0] = {}) {
  const exec = fakes({ draw: panels, edit: edited, ...outputs }, { pick: (c) => (c.visit === 1 ? { action: "lock", selection: ["1.2"] } : undefined) });
  return { exec, ...start(shotRecipe, exec, SHOT) };
}

describe("versions are numbered v1, v2… and say why they exist (D-87)", () => {
  it("numbers follow the order versions were made, across branches", () => {
    const exec = fakes({ draw: panels, edit: edited }, { pick: () => undefined });
    const { s, rec } = start(shotRecipe, exec, SHOT);
    s.branch("draw", "night", "1.1");
    s.make("draw", { from: "1.1", instruction: "night" });
    s.run();
    const draw = rec.state.nodes.draw!;
    expect(numbers(draw)).toEqual({ "1.1": 1, "1.2": 2, "1.3": 3, "2.1": 4 });
    expect(draw.versions["2.1"]!.branch).toBe("night");
  });

  it("each version's intention is one line: recipe, an instruction, where it came from", () => {
    const { s, rec } = finishedShot();
    s.make("draw", { from: "1.2", instruction: "make him smile" });
    s.run();
    const draw = rec.state.nodes.draw!;
    expect(intention(draw, draw.versions["1.1"]!)).toBe("from recipe");
    expect(intention(draw, draw.versions["2.1"]!)).toBe('from v2: "make him smile"');
    expect(intention(draw, { ...draw.versions["2.1"]!, parents: ["1.3", "1.1"] })).toBe('v3 + v1: "make him smile"');
    expect(intention(draw, { ...draw.versions["1.1"]!, attempt: 2 })).toBe("made again");
  });
});

describe("a version asked for from the chat (D-87)", () => {
  it("an edit goes to the edit step, from the named version, with the chat's words, not the last pick's", () => {
    const { s, rec, exec, events } = finishedShot();
    expect(s.make("draw", { from: "1.3", instruction: "make it night" })).toBe("edit");
    s.run();
    const v = rec.state.nodes.draw!.versions["2.1"]!;
    expect(v).toMatchObject({ parents: ["1.3"], instruction: "make it night", madeBy: "edit", output: { image: "panel:a1c3+make it night" } });
    expect(exec.calls.edit![0]!.parent).toEqual({ version: "1.3", output: { image: "panel:a1c3" } });
    expect(replay(events())).toEqual(rec.state);
  });

  it("goes back to rest: nothing is locked, no arrow is followed, the pick screen isn't asked again", () => {
    const { s, rec, exec } = finishedShot();
    const edges = { ...rec.state.edges };
    s.make("draw", { from: "1.3", instruction: "make it night" });
    s.run();
    expect(rec.state.nodes.draw!.locked?.version).toBe("1.2");
    expect(rec.state.edges).toEqual(edges);
    expect(exec.calls["screen:pick"]).toHaveLength(1);
    expect(rec.state.nodes.edit!.status).toBe("completed");
    expect(rec.state.status).toBe("completed");
  });

  it("a redo is made by the step itself, with the words as its instruction", () => {
    const { s, rec } = finishedShot();
    expect(s.make("draw", { from: "1.1", instruction: "wider shot", redo: true })).toBe("draw");
    s.run();
    const draw = rec.state.nodes.draw!;
    expect(Object.keys(draw.versions)).toEqual(["1.1", "1.2", "1.3", "2.1", "2.2", "2.3"]);
    expect(draw.versions["2.1"]).toMatchObject({ parents: ["1.1"], instruction: "wider shot", output: { image: "panel:a2c1:wider shot" } });
    expect(draw.versions["2.1"]!.madeBy).toBeUndefined();
  });

  it("waits on a slow job like any attempt, and a crash mid-job asks again with the same key", () => {
    let ticket = 0;
    const { s, rec, log } = finishedShot({ edit: () => ({ ticket: `job${++ticket}` }) });
    s.make("draw", { from: "1.1", instruction: "rain" });
    s.run();
    expect(rec.state.nodes.edit!.status).toBe("waiting_external");

    // A new process: the same run, replayed, then recovered.
    const exec2 = fakes({ edit: () => ({ ticket: "job1" }) });
    const rec2 = Recorder.resume(log, "run1");
    const s2 = new Scheduler(shotRecipe, rec2, exec2, graphs, LIBRARY);
    s2.recover();
    expect(exec2.calls.edit![0]!.idempotencyKey).toBe("run1/edit#1");
    expect(exec2.calls.edit![0]!.instruction).toBe("rain");

    s2.deliver("job1", [{ image: "rainy" }]);
    s2.run();
    expect(rec2.state.nodes.draw!.versions["2.1"]).toMatchObject({ parents: ["1.1"], instruction: "rain", output: { image: "rainy" } });
    expect(rec2.state.nodes.draw!.locked?.version).toBe("1.2");
    expect(rec2.state.status).toBe("completed");
    expect(replay(readRun(log, "run1"))).toEqual(rec2.state);
  });

  it("says plainly what's wrong with a request", () => {
    const { s } = finishedShot();
    expect(() => s.make("draw", { from: "9.9", instruction: "x" })).toThrow("'draw' has no version 9.9");
    expect(() => s.make("draw", { instruction: "  " })).toThrow("say what to change");
    expect(() => s.make("pick", { instruction: "x" })).toThrow("'pick' is a screen step");
    expect(() => s.make("edit", { instruction: "x" })).toThrow("there's no step 'edit' in this run yet");
  });

  it("refuses a step that's busy", () => {
    const exec = fakes({ draw: panels }, { pick: () => undefined });
    const { s } = start(shotRecipe, exec, SHOT);
    s.make("draw", { from: "1.1", instruction: "rain", redo: true });
    expect(() => s.make("draw", { from: "1.1", instruction: "snow", redo: true })).toThrow("'draw' is busy right now (ready)");
  });
});

describe("locking from the chat (D-87)", () => {
  it("answers the waiting screen with the version, so the recipe carries on down its arrow", () => {
    const exec = fakes({ draw: panels }, { pick: () => undefined });
    const { s, rec, events } = start(shotRecipe, exec, SHOT);
    s.choose("draw", "1.3", "the smile reads");
    s.run();
    expect(rec.state.nodes.draw!.locked).toEqual({ version: "1.3", by: "human", why: "the smile reads" });
    expect(rec.state.nodes.pick!.decisions.at(-1)).toMatchObject({ action: "lock", selection: ["1.3"], note: "the smile reads", by: "human" });
    expect(rec.state.status).toBe("completed");
    expect(replay(events())).toEqual(rec.state);
  });

  it("with no screen waiting, it's a direct lock", () => {
    const { s, rec } = finishedShot();
    s.make("draw", { from: "1.3", instruction: "night" });
    s.run();
    s.choose("draw", "2.1");
    expect(rec.state.nodes.draw!.locked).toEqual({ version: "2.1", by: "human" });
  });
});

describe("the conversation itself (D-87)", () => {
  it("is kept per step, with the branch it was said on, and talking leaves a finished run finished", () => {
    const { s, rec, events } = finishedShot();
    s.said("draw", "why is v2 flatter than v3?");
    s.answered("draw", { text: "v2 has no rim light.", did: [], model: "claude-opus-5-5", cost_usd: 0.01 });
    expect(rec.state.status).toBe("completed");
    expect(rec.state.nodes.draw!.thread).toEqual([
      { by: "you", text: "why is v2 flatter than v3?", branch: "main" },
      { by: "kriya", text: "v2 has no rim light.", branch: "main", did: [], model: "claude-opus-5-5", costUsd: 0.01 },
    ]);
    expect(rec.state.costUsd).toBeCloseTo(0.01);
    expect(replay(events())).toEqual(rec.state);
  });

  it("can't start on a step that hasn't run", () => {
    const { s } = finishedShot();
    expect(() => s.said("animate", "hello")).toThrow("step 'animate' hasn't started");
  });
});

describe("talking to the whole run (D-95)", () => {
  it("is kept on the run, not on any step, costs count, and a finished run stays finished", () => {
    const { s, rec, events } = finishedShot();
    s.said(undefined, "add a shot after P3-05");
    s.answered(undefined, { text: "Added P3-05a.", did: ["Break it into shots: made v2 from v1"], model: "claude-opus-5-5", cost_usd: 0.02 });
    expect(rec.state.status).toBe("completed");
    expect(rec.state.thread).toEqual([
      { by: "you", text: "add a shot after P3-05" },
      { by: "kriya", text: "Added P3-05a.", did: ["Break it into shots: made v2 from v1"], model: "claude-opus-5-5", costUsd: 0.02 },
    ]);
    expect(Object.values(rec.state.nodes).every((n) => n.thread.length === 0)).toBe(true);
    expect(rec.state.costUsd).toBeCloseTo(0.02);
    expect(replay(events())).toEqual(rec.state);
  });
});

describe("a finished run keeps the Library it was made with (D-88)", () => {
  it("a new facet version leaves it alone; reopened, it catches up", () => {
    let look = "v1";
    const assets = { facet: (entity: string, facet: string) => ({ version: facet === "look" ? look : "v1", value: `${entity}:${facet}` }) };
    const exec = fakes({ draw: panels }, { pick: (c) => (c.visit === 1 ? { action: "lock", selection: ["1.2"] } : undefined) });
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(shotRecipe, rec, exec, graphs, { assets });
    s.start("a".repeat(64), { item: { id: "P3-04", animate: false, characters: ["Mitra"], place: "Tap" } }, SERIES);
    s.run();
    expect(rec.state.status).toBe("completed");

    look = "v2"; // Mitra's look is redrawn in the Library
    s.assetsChanged();
    expect(rec.state.status).toBe("completed");
    expect(readRun(log, "run1").filter((e) => e.type === "MarkedStale")).toEqual([]);

    s.lock("draw", "1.3"); // the creator works on it again: now it reads today's Library
    expect(rec.state.nodes.draw!.status).toBe("stale");
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });
});

describe("a change reaches takes still waiting for you (D-90)", () => {
  /** A shot of Mitra whose three panels wait for a pick, and a Library whose look can be redrawn. */
  function waitingShot() {
    const lib = { look: "v1" };
    const version = (entity: string, facet: string) => (entity === "Mitra" && facet === "look" ? lib.look : "v1");
    const assets = { facet: (entity: string, facet: string) => ({ version: version(entity, facet), value: `${entity}:${facet}:${version(entity, facet)}` }) };
    const exec = fakes({ draw: panels }, { pick: () => undefined });
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(shotRecipe, rec, exec, graphs, { assets });
    s.start("a".repeat(64), { item: { id: "P3-04", animate: false, characters: ["Mitra"], place: "Tap" } }, SERIES);
    s.run();
    expect(rec.state.nodes.pick!.status).toBe("awaiting_human");
    return { s, rec, exec, lib, events: () => readRun(log, "run1") };
  }

  it("they aren't stale (nothing was locked), but they're out of date, and a rebuild makes them again", () => {
    const { s, rec, exec, lib, events } = waitingShot();
    lib.look = "v2"; // Mitra's look is redrawn
    s.assetsChanged();
    expect(s.stale()).toEqual([]);
    expect(s.outdated()).toEqual([{ key: "draw", reason: "Mitra's look changed" }]);

    expect(s.rebuild()).toEqual(["draw"]);
    s.run();
    const draw = rec.state.nodes.draw!;
    expect(Object.keys(draw.versions)).toEqual(["1.1", "1.2", "1.3", "2.1", "2.2", "2.3"]);
    expect(exec.calls.draw![1]!.assets).toMatchObject({ "Mitra.look": "v2" }); // made with the new look
    expect(exec.calls.draw![1]!.instruction).toBeUndefined();
    expect(intention(draw, draw.versions["2.1"]!)).toBe("made again");
    // The pick still waits, now on the new panels; nothing was locked or chosen for you.
    expect(rec.state.nodes.pick!.status).toBe("awaiting_human");
    expect(draw.locked).toBeUndefined();
    expect(s.outdated()).toEqual([]);
    expect(replay(events())).toEqual(rec.state);
  });

  it("takes behind stale work wait for it: they're redone when it is", () => {
    const exec = fakes(
      { shot_list: () => [{ shots: [{ id: "P3-01", action: "Tanker", animate: false }, { id: "P3-02", action: "Valve", animate: false }], lines: [], hook: "?" }], draw: panels },
      { approve_shots: () => ({ action: "approve" }), pick: () => undefined },
    );
    const part = graphs.find((g) => g.graph === "part_recipe")!;
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(part, rec, exec, graphs, LIBRARY);
    s.start("a".repeat(64), { story_pages: "pages", part_no: 3 }, SERIES);
    s.run();
    expect(rec.state.nodes["per_shot[P3-01].pick"]!.status).toBe("awaiting_human");
    // The series' rules (the shot list reads them) and style (the panels read it) both change.
    s.updateContext("series", { ...SERIES.series, style: "watercolour", rules: "no songs at all" });
    expect(s.stale().map((x) => x.key)).toContain("shot_list");
    expect(s.outdated()).toEqual([]);
  });
});
