import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir } from "../src/load.js";
import { applyEdits, Recorder, readRun, replay, Scheduler, type Decision, type Edit, type Executors, type PatchShape, type StepContext } from "../src/index.js";

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const part = graphs.find((g) => g.graph === "part_recipe")!;
const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };

const shot = (id: string, action: string) => ({ id, characters: ["Mitra"], place: "Reservoir", action, lines: [], animate: false, music: "main" });
const SHOTS = [shot("P3-01", "Tanker arrives"), shot("P3-02", "Mitra spots the valve"), shot("P3-03", "Bheem runs")];
const OUTPUT = { shots: SHOTS, lines: [{ id: "L1", speaker: "Mitra", hinglish: "Arre!", emotion: "surprised", caption_en: "Hey!" }], hook: "Who will close the valve?" };
const SHAPE: PatchShape = {
  out: part.nodes.find((n) => n.id === "shot_list")!.kind === "model" ? (part.nodes.find((n) => n.id === "shot_list") as { out: Record<string, string> }).out : {},
  types: part.types,
  keyOf: () => "id",
  names: (kind) => (kind === "character" ? ["Mitra", "Bheem"] : kind === "place" ? ["Reservoir", "Mitra's chai stall"] : []),
};
const ids = (o: Record<string, unknown>) => (o.shots as { id: string }[]).map((s) => s.id);

describe("applying edits by key", () => {
  it("adds an item after another and copies every other item exactly", () => {
    const { output, did } = applyEdits(OUTPUT, [{ op: "add", field: "shots", after: "P3-02", item: shot("P3-02a", "Mitra notices the leak") }], SHAPE);
    expect(ids(output)).toEqual(["P3-01", "P3-02", "P3-02a", "P3-03"]);
    expect((output.shots as unknown[]).filter((s) => (s as { id: string }).id !== "P3-02a")).toEqual(SHOTS);
    expect(output.lines).toBe(OUTPUT.lines);
    expect(did).toEqual(["added P3-02a after P3-02"]);
  });

  it("changes only the fields it names, and leaves the version it started from alone", () => {
    const { output } = applyEdits(OUTPUT, [{ op: "update", field: "shots", key: "P3-03", set: { action: "Bheem runs, at dusk" } }], SHAPE);
    expect((output.shots as typeof SHOTS)[2]).toEqual({ ...SHOTS[2], action: "Bheem runs, at dusk" });
    expect(OUTPUT.shots[2]!.action).toBe("Bheem runs");
  });

  it("removes, moves, and sets a field that isn't a list, in order", () => {
    const edits: Edit[] = [
      { op: "remove", field: "shots", key: "P3-01" },
      { op: "move", field: "shots", key: "P3-03", before: "P3-02" },
      { op: "set", field: "hook", value: "Who left the valve open?" },
    ];
    const { output, did } = applyEdits(OUTPUT, edits, SHAPE);
    expect(ids(output)).toEqual(["P3-03", "P3-02"]);
    expect(output.hook).toBe("Who left the valve open?");
    expect(did).toEqual(["removed P3-01", "moved P3-03 before P3-02", "set hook"]);
  });

  it("never edits an item's key in place: that's a new item", () => {
    expect(() => applyEdits(OUTPUT, [{ op: "update", field: "shots", key: "P3-02", set: { id: "P3-02b" } }], SHAPE)).toThrow(/'id' is what P3-02 is known by.*add a new item and remove this one/);
  });

  it("refuses what the recipe's types wouldn't accept, saying where", () => {
    const { music: _, ...noMusic } = shot("P3-04", "x");
    expect(() => applyEdits(OUTPUT, [{ op: "add", field: "shots", item: noMusic }], SHAPE)).toThrow("edit 1 (add shots): the new shots item is missing 'music'");
    expect(() => applyEdits(OUTPUT, [{ op: "update", field: "shots", key: "P3-01", set: { animate: "yes" } }], SHAPE)).toThrow("P3-01's animate should be true or false");
    expect(() => applyEdits(OUTPUT, [{ op: "update", field: "shots", key: "P3-01", set: { place: "Resevoir" } }], SHAPE)).toThrow("the Library has no place 'Resevoir'. Did you mean 'Reservoir'?");
    expect(() => applyEdits(OUTPUT, [{ op: "update", field: "shots", key: "P3-01", set: { acton: "x" } }], SHAPE)).toThrow("a shot has no 'acton'. Did you mean 'action'?");
    expect(() => applyEdits(OUTPUT, [{ op: "set", field: "shots", value: [] }], SHAPE)).toThrow("'shots' is a list");
  });

  it("names the nearest item or field when one is misspelled, and refuses a key twice", () => {
    expect(() => applyEdits(OUTPUT, [{ op: "remove", field: "shots", key: "P3-1" }], SHAPE)).toThrow("there's no 'P3-1' in shots. Did you mean 'P3-01'?");
    expect(() => applyEdits(OUTPUT, [{ op: "remove", field: "shot", key: "P3-01" }], SHAPE)).toThrow("this step makes no 'shot'. Did you mean 'shots'?");
    expect(() => applyEdits(OUTPUT, [{ op: "add", field: "shots", item: shot("P3-01", "again") }], SHAPE)).toThrow("shots already has 'P3-01'");
  });

  it("works on a list of plain names, where the item is its own key (D-74)", () => {
    const shape: PatchShape = { out: { tickers: "list<text>" }, types: {}, keyOf: () => "id" };
    const { output } = applyEdits({ tickers: ["AAPL", "MSFT"] }, [{ op: "add", field: "tickers", item: "NVDA", before: "MSFT" }, { op: "remove", field: "tickers", key: "AAPL" }], shape);
    expect(output.tickers).toEqual(["NVDA", "MSFT"]);
  });
});

/** A finished Part 3 whose fakes log every call, so a test sees exactly what ran again. */
function finishedPart() {
  const calls: string[] = [];
  const item = (c: StepContext) => (c.inputs.item as { id: string }).id;
  const exec: Executors = {
    produce(node, c) {
      calls.push(c.key);
      switch (node.id) {
        case "shot_list": return [OUTPUT];
        case "draw": return [{ image: `img:${item(c)}` }];
        case "animate": return [{ clip: `clip:${item(c)}` }];
        case "speak": return [{ audio: `wav:${item(c)}`, seconds: 4 }];
        case "assemble": return [{ reel: `reel#${calls.filter((k) => k === "assemble").length}` }];
        default: return [{ done: true }];
      }
    },
    check: (_n, _c, cands) => cands.map((c) => ({ version: c.version, pass: true, issues: [] })),
    decide(node, ctx): Decision {
      if (node.id === "pick") return { action: "lock", selection: [ctx.shows!.at(-1)!.version] };
      return { action: "approve" };
    },
  };
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(part, rec, exec, graphs, LIBRARY);
  s.start("a".repeat(64), { story_pages: "pages 7–9", part_no: 3 }, SERIES);
  s.run();
  expect(rec.state.status).toBe("completed");
  calls.length = 0;
  return { s, rec, calls, events: () => readRun(log, "run1") };
}

describe("a patched version in a run (D-89)", () => {
  const addLeak: Edit[] = [{ op: "add", field: "shots", after: "P3-02", item: shot("P3-02a", "Mitra notices the leak") }];

  it("is a new version from the one it started from, made by code: nothing spent, nothing locked", () => {
    const { s, rec, calls, events } = finishedPart();
    const locked = rec.state.nodes.shot_list!.locked!.version;
    const { version, did } = s.patch("shot_list", locked, addLeak, { note: "people should see the leak before the reveal" });
    const v = rec.state.nodes.shot_list!.versions[version]!;
    expect(v.parents).toEqual([locked]);
    expect(v.costUsd).toBe(0);
    expect(v.instruction).toBe("people should see the leak before the reveal");
    expect(v.inputs).toEqual(rec.state.nodes.shot_list!.versions[locked]!.inputs);
    expect(rec.state.nodes.shot_list!.locked!.version).toBe(locked);
    expect(did).toEqual(["added P3-02a after P3-02"]);
    expect(calls).toEqual([]);
    expect(replay(events())).toEqual(rec.state);
  });

  it("once locked, a rebuild makes only the new shot and the Reel: the other shots keep their work", () => {
    const { s, rec, calls, events } = finishedPart();
    const { version } = s.patch("shot_list", rec.state.nodes.shot_list!.locked!.version, addLeak);
    s.lock("shot_list", version);
    expect(s.stale().map((x) => x.key)).toEqual(["per_shot", "assemble"]);
    s.rebuild();
    s.run();
    expect(rec.state.status).toBe("completed");
    expect(calls.filter((k) => k.startsWith("per_shot[")).every((k) => k.startsWith("per_shot[P3-02a]."))).toBe(true);
    expect(calls).toContain("per_shot[P3-02a].draw");
    expect(calls).toContain("assemble");
    expect(replay(events())).toEqual(rec.state);
  });

  it("says when its id is unknown, and refuses a step that's working", () => {
    const { s } = finishedPart();
    expect(() => s.patch("shot_list", "9.9", addLeak)).toThrow("'shot_list' has no version 9.9");
    expect(() => s.patch("per_shot", "1.1", addLeak)).toThrow("'per_shot' is a map step");
  });

  it("names Library entries the project really has, when told them", () => {
    const { s, rec } = finishedPart();
    const bad: Edit[] = [{ op: "update", field: "shots", key: "P3-01", set: { place: "Resevoir" } }];
    expect(() => s.patch("shot_list", rec.state.nodes.shot_list!.locked!.version, bad, { names: SHAPE.names! })).toThrow("Did you mean 'Reservoir'?");
  });
});
