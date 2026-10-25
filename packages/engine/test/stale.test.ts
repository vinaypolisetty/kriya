import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Decision, type Executors, type StepContext } from "../src/index.js";

/** The series' locked context the Mohalla Mitra recipes inherit. */
const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };

/** A fake Library where every facet exists at v1. */
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const part = graphs.find((g) => g.graph === "part_recipe")!;

type Shot = { id: string; action: string; animate: boolean };
const SHOTS: Shot[] = [
  { id: "P3-01", action: "Tanker arrives", animate: false },
  { id: "P3-02", action: "Mitra spots the valve", animate: false },
  { id: "P3-03", action: "Bheem runs", animate: true },
];
const LINES = [{ id: "L1", speaker: "Mitra" }];

/** A whole Part with fakes that log every model/tool call, so tests can see exactly what re-ran. */
function finishedPart() {
  const calls: string[] = [];
  const item = (c: StepContext) => (c.inputs.item as { id: string }).id;
  const exec: Executors = {
    produce(node, c) {
      calls.push(c.key);
      switch (node.id) {
        case "shot_list": return [{ shots: SHOTS, lines: LINES, hook: "Who will close the valve?" }];
        case "draw": return [{ image: `img:${item(c)}:${(c.inputs.item as Shot).action}` }];
        case "animate": return [{ clip: `clip:${item(c)}` }];
        case "speak": return [{ audio: `wav:${item(c)}`, seconds: 4 }];
        case "assemble": return [{ reel: `reel#${calls.filter((k) => k === "assemble").length}` }];
        default: return [{ done: true }];
      }
    },
    // The example shot recipe has a rubric; a judge that passes everything (checks.test.ts covers judging).
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
  const changeShots = (shots: Shot[]) => s.lock("shot_list", s.writeVersion("shot_list", { shots, lines: LINES, hook: "Who will close the valve?" }, "rewrite"));
  return { s, rec, calls, changeShots, events: () => readRun(log, "run1") };
}

const changed = (id: string, action: string) => SHOTS.map((x) => (x.id === id ? { ...x, action } : x));

describe("changing one shot marks only its work stale", () => {
  it("marks P3-02's steps, the map and what comes after it, and nothing else", () => {
    const { s, changeShots } = finishedPart();
    changeShots(changed("P3-02", "Mitra spots the valve, at dusk"));
    const stale = s.stale().map((x) => x.key);
    expect(stale).toEqual(["per_shot", "per_shot[P3-02].draw", "assemble"]);
    expect(stale.some((k) => k.includes("P3-01") || k.includes("P3-03") || k.startsWith("voices"))).toBe(false);
  });

  it("says why each one is stale", () => {
    const { s, changeShots } = finishedPart();
    changeShots(changed("P3-02", "at dusk"));
    expect(s.stale()).toEqual([
      { key: "per_shot", reason: "'shot_list.shots' changed" },
      { key: "per_shot[P3-02].draw", reason: "its item changed" },
      { key: "assemble", reason: "'shot_list.shots' changed; 'per_shot' changed" }, // the Reel reads the shot list too (D-62)
    ]);
  });

  it("stale work leaves context: the Reel no longer sees P3-02's old panel", () => {
    const { rec, changeShots } = finishedPart();
    changeShots(changed("P3-02", "at dusk"));
    expect(rec.state.nodes["per_shot[P3-02].draw"]?.status).toBe("stale");
    expect(rec.state.nodes["per_shot[P3-01].draw"]?.status).not.toBe("stale");
  });

  it("rebuilding redoes only P3-02's panel and the Reel; the other shots and voices are reused", () => {
    const { s, rec, calls, changeShots } = finishedPart();
    changeShots(changed("P3-02", "at dusk"));
    s.rebuild();
    s.run();
    expect(calls).toEqual(["per_shot[P3-02].draw", "assemble"]);
    expect(rec.state.status).toBe("completed");
    expect(s.stale()).toEqual([]);
    const panels = rec.state.nodes.per_shot!.versions[rec.state.nodes.per_shot!.locked!.version]!.output.panel;
    expect(panels).toEqual(["img:P3-01:Tanker arrives", "img:P3-02:at dusk", "img:P3-03:Bheem runs"]);
  });

  it("re-locking the original restores everything, with nothing redone", () => {
    const { s, calls, changeShots } = finishedPart();
    changeShots(changed("P3-02", "at dusk"));
    expect(s.stale().length).toBeGreaterThan(0);
    s.lock("shot_list", "1.1");
    expect(s.stale()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a new shot runs, a removed shot is parked, the rest are kept", () => {
    const { s, rec, calls, changeShots } = finishedPart();
    changeShots([SHOTS[0]!, SHOTS[2]!, { id: "P3-04", action: "Tiwari arrives", animate: false }]);
    s.rebuild();
    s.run();
    expect(calls).toEqual(["per_shot[P3-04].draw", "assemble"]);
    const out = rec.state.nodes.per_shot!.versions[rec.state.nodes.per_shot!.locked!.version]!.output;
    expect(out.panel).toEqual(["img:P3-01:Tanker arrives", "img:P3-03:Bheem runs", "img:P3-04:Tiwari arrives"]);
    expect(rec.state.nodes["per_shot[P3-02].draw"]?.locked).toBeDefined(); // parked: kept in history
  });

  it("a shot that's no longer animated leaves its old clip parked, not in the Reel", () => {
    const { s, rec, calls, changeShots } = finishedPart();
    changeShots(SHOTS.map((x) => (x.id === "P3-03" ? { ...x, animate: false } : x)));
    s.rebuild();
    s.run();
    expect(calls).toEqual(["per_shot[P3-03].draw", "assemble"]); // animate isn't re-run: the recipe no longer goes there
    const out = rec.state.nodes.per_shot!.versions[rec.state.nodes.per_shot!.locked!.version]!.output;
    expect(out.clip).toEqual([null, null, null]);
    expect(rec.state.nodes["per_shot[P3-03].animate"]?.status).toBe("stale");
  });

  it("editing a finished run reopens it, on the record", () => {
    const { rec, changeShots, events } = finishedPart();
    changeShots(changed("P3-02", "at dusk"));
    expect(rec.state.status).toBe("running");
    expect(events().find((e) => e.type === "RunReopened")).toEqual({ type: "RunReopened", reason: "'shot_list' got a new version" });
  });

  it("rebuilding a run that settled with stale work reopens it", () => {
    const { s, rec, changeShots, events } = finishedPart();
    changeShots(changed("P3-02", "at dusk"));
    s.run(); // nothing is ready, so the run settles with its stale work parked
    expect(rec.state.status).toBe("completed");
    s.rebuild();
    expect(events().at(-2)).toEqual({ type: "RunReopened", reason: "rebuilding stale work" });
    s.run();
    expect(rec.state.status).toBe("completed");
    expect(s.stale()).toEqual([]);
  });

  it("replays to the same state after a rebuild", () => {
    const { s, rec, changeShots, events } = finishedPart();
    changeShots(changed("P3-02", "at dusk"));
    s.rebuild();
    s.run();
    expect(replay(events())).toEqual(rec.state);
  });
});

describe("moving a lock by hand", () => {
  it("a picked panel follows a lock you move later, so the work after it goes stale", () => {
    const { s, rec } = finishedPart();
    const draw = "per_shot[P3-01].draw";
    const extra = s.writeVersion(draw, { image: "img:P3-01:redrawn" }, "redrawn by hand");
    s.lock(draw, extra);
    expect(rec.state.nodes[draw]?.locked?.version).toBe(extra);
    expect(s.stale().map((x) => x.key)).toEqual(["per_shot", "assemble"]);
  });
});

describe("what counts as a change", () => {
  it("renaming a step's label doesn't make it stale (rule 4)", () => {
    const { s, rec } = finishedPart();
    const g = { ...part, nodes: part.nodes.map((n) => (n.id === "assemble" ? { ...n, name: "Make the Reel" } : n)) };
    const s2 = new Scheduler(g, rec, { produce: () => [], decide: () => undefined }, graphs, LIBRARY);
    expect(s2.stale()).toEqual([]);
    expect(s.stale()).toEqual([]);
  });
});
