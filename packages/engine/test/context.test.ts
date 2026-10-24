import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir, loadText } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Assets, type Decision, type Executors, type Graph, type StepContext } from "../src/index.js";

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const example = (id: string) => graphs.find((g) => g.graph === id)!;
const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };

/** A Library you can change mid-test: entity.facet → [version, value]. */
class Library implements Assets {
  constructor(public readonly facets: Record<string, [string, unknown]> = {}) {}
  facet(entity: string, facet: string) {
    const f = this.facets[`${entity}.${facet}`];
    return f ? { version: f[0], value: f[1] } : undefined;
  }
}

const SHOTS = [
  { id: "P3-01", action: "Mitra pours chai", characters: ["Mitra"], place: "stall", animate: false },
  { id: "P3-02", action: "Bheem runs", characters: ["Bheem"], place: "stall", animate: false },
];
const fullLibrary = () =>
  new Library({ "Mitra.look": ["v1", "mitra-sheet.png"], "Bheem.look": ["v1", "bheem-sheet.png"], "stall.look": ["v1", "stall.png"], "Mitra.voice": ["v1", "warm"], "Mitra.speech": ["v1", "calls people beta"] });

function part(library: Library, pick?: (c: StepContext) => Decision | undefined) {
  const seen: Record<string, StepContext[]> = {};
  const exec: Executors = {
    produce(node, c) {
      (seen[c.key] ??= []).push(c);
      const id = (c.inputs.item as { id?: string } | undefined)?.id;
      switch (node.id) {
        case "shot_list": return [{ shots: SHOTS, lines: [{ id: "L1", speaker: "Mitra" }], hook: "" }];
        case "draw": return [{ image: `img:${id}` }];
        case "edit": return [{ image: `${(c.parent?.output as { image?: string } | undefined)?.image}+edit` }];
        case "speak": return [{ audio: `wav:${id}`, seconds: 4 }];
        default: return [{ done: true }];
      }
    },
    decide(node, c): Decision | undefined {
      if (node.id === "pick") return pick ? pick(c) : { action: "lock", selection: [c.shows!.at(-1)!.version] };
      return { action: "approve" };
    },
  };
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(example("part_recipe"), rec, exec, graphs, { assets: library });
  s.start("a".repeat(64), { story_pages: "…", part_no: 3 }, SERIES);
  s.run();
  return { s, rec, seen, events: () => readRun(log, "run1") };
}

describe("inherited context (D-47)", () => {
  it("a shot's draw step receives the series style it declares", () => {
    const { seen, rec } = part(fullLibrary());
    expect(rec.state.status).toBe("completed");
    expect(seen["per_shot[P3-01].draw"]![0]!.uses["series.style"]).toBe("2D cartoon, flat colors");
  });

  it("refuses to start without the context a recipe inherits", () => {
    const s = new Scheduler(example("part_recipe"), Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "r"), { produce: () => [], decide: () => undefined }, graphs);
    expect(() => s.start("a".repeat(64), {}, {})).toThrow("recipe 'part_recipe' reads from 'series', but the run wasn't given any 'series' context");
  });

  it("changing the series style makes only work that read it stale", () => {
    const { s } = part(fullLibrary());
    s.updateContext("series", { ...SERIES.series, style: "watercolour" });
    const stale = s.stale().map((x) => x.key);
    expect(stale).toEqual(["per_shot", "per_shot[P3-01].draw", "per_shot[P3-02].draw", "assemble"]);
    expect(stale).not.toContain("shot_list"); // it reads the rules and cast, not the style
  });
});

describe("asset facets", () => {
  it("draw receives each character's look, with its version, and the version is kept for lineage", () => {
    const { seen, rec } = part(fullLibrary());
    expect(seen["per_shot[P3-01].draw"]![0]!.uses["item.characters@look"]).toEqual([{ entity: "Mitra", facet: "look", version: "v1", value: "mitra-sheet.png" }]);
    const v = rec.state.nodes["per_shot[P3-01].draw"]!.versions["1.1"]!;
    expect(seen["per_shot[P3-01].draw"]![0]!.assets).toEqual({ "Mitra.look": "v1", "stall.look": "v1" });
    expect(v.inputs!["uses:item.characters@look"]).toBeDefined();
  });

  it("a new look for Bheem makes only Bheem's shot stale", () => {
    const lib = fullLibrary();
    const { s } = part(lib);
    lib.facets["Bheem.look"] = ["v2", "bheem-sheet-v2.png"];
    s.assetsChanged();
    expect(s.stale().map((x) => x.key)).toEqual(["per_shot", "per_shot[P3-02].draw", "assemble"]);
  });

  it("a missing look blocks the shot, plainly, until it exists", () => {
    const lib = fullLibrary();
    delete lib.facets["Bheem.look"];
    const { s, rec } = part(lib);
    expect(rec.state.status).toBe("running");
    expect(rec.state.nodes["per_shot[P3-02].draw"]).toMatchObject({ status: "blocked", blockedReason: "@Bheem has no look yet; add it to the Library" });
    expect(rec.state.nodes["per_shot[P3-01].draw"]?.status).not.toBe("blocked"); // the other shot carries on

    lib.facets["Bheem.look"] = ["v1", "bheem-sheet.png"];
    expect(s.unblock()).toEqual(["per_shot[P3-02].draw"]);
    s.run();
    expect(rec.state.status).toBe("completed");
  });
});

describe("context modes", () => {
  const editOnce = (c: StepContext): Decision =>
    c.visit === 1 ? { action: "edit", selection: [c.shows![0]!.version], note: "add the gamcha" } : { action: "lock", selection: [c.shows!.at(-1)!.version] };

  it("a local edit gets the panel it edits and its own inputs: no style line, no character sheets (D-55)", () => {
    const { seen } = part(fullLibrary(), editOnce);
    const edit = seen["per_shot[P3-01].edit"]![0]!;
    expect(Object.keys(edit.uses).sort()).toEqual(["pick.note", "pick.selected"]);
    expect(edit.parent?.output).toEqual({ image: "img:P3-01" });
  });

  it("a mention is saved with the step: it goes stale, and the rebuild receives it", () => {
    const { s, seen, rec } = part(fullLibrary());
    s.mention("per_shot[P3-01].draw", "@Bheem.look", "Bheem waves from the back");
    expect(rec.state.nodes["per_shot[P3-01].draw"]!.mentions).toEqual([{ ref: "@Bheem.look", note: "Bheem waves from the back" }]);
    expect(s.stale().map((x) => x.key)).toEqual(["per_shot", "per_shot[P3-01].draw", "assemble"]);
    s.rebuild();
    s.run();
    expect(seen["per_shot[P3-01].draw"]!.at(-1)!.uses["@Bheem.look"]).toEqual({ entity: "Bheem", facet: "look", version: "v1", value: "bheem-sheet.png" });
  });

  it("an isolated step gets only its mentions", () => {
    const g: Graph = loadText(`graph: g
level: part
nodes:
  - { id: a, kind: tool, tool: t }
  - { id: b, kind: model, capability: llm.write, context: isolated, trust: always, uses: [a.done] }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`).graphs[0]!;
    const got: StepContext[] = [];
    const s = new Scheduler(g, Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "r"), { produce: (n, c) => (got.push(c), [{ done: true }]), decide: () => undefined }, []);
    s.start("a".repeat(64));
    s.run();
    expect(got[1]!.uses).toEqual({});
  });

  it("the fingerprint covers only what the step receives: a local edit doesn't go stale when the style changes", () => {
    const { s, rec } = part(fullLibrary(), editOnce);
    expect(rec.state.nodes["per_shot[P3-01].draw"]!.locked!.version).toBe("2.1"); // made by edit
    s.updateContext("series", { ...SERIES.series, style: "watercolour" });
    const stale = s.stale().map((x) => x.key);
    expect(stale).not.toContain("per_shot[P3-01].draw");
  });
});

describe("removed defaults and overrides", () => {
  it("removing the style from one shot's draw makes just that shot stale, and the rebuild leaves it out", () => {
    const { s, seen } = part(fullLibrary());
    s.removeDefault("per_shot[P3-02].draw", "series.style");
    expect(s.stale().map((x) => x.key)).toEqual(["per_shot", "per_shot[P3-02].draw", "assemble"]);
    s.rebuild();
    s.run();
    expect(seen["per_shot[P3-02].draw"]!.at(-1)!.uses["series.style"]).toBeUndefined();
  });

  it("an episode override changes Mitra's look for this run only; a step override beats it", () => {
    const lib = fullLibrary();
    const { s, seen } = part(lib);
    s.override("run", "Mitra", "look", "mitra-with-a-cold.png");
    expect(s.stale().map((x) => x.key)).toEqual(["per_shot", "per_shot[P3-01].draw", "assemble"]);
    s.override("per_shot[P3-01].draw", "Mitra", "look", "mitra-in-a-raincoat.png");
    s.rebuild();
    s.run();
    const used = seen["per_shot[P3-01].draw"]!.at(-1)!.uses["item.characters@look"] as { value: string }[];
    expect(used[0]!.value).toBe("mitra-in-a-raincoat.png");
    expect(lib.facets["Mitra.look"]![1]).toBe("mitra-sheet.png"); // the Library is untouched
  });

  it("replays to the same state after context changes", () => {
    const { s, rec, events } = part(fullLibrary());
    s.override("run", "Mitra", "look", "x.png");
    s.removeDefault("per_shot[P3-02].draw", "series.style");
    s.updateContext("series", { ...SERIES.series, style: "watercolour" });
    s.rebuild();
    s.run();
    expect(replay(events())).toEqual(rec.state);
  });
});

describe("validating references (fixes B-1, B-2)", () => {
  const errs = (yaml: string) => loadText(`graph: g\nlevel: part\n${yaml}`).problems.filter((p) => p.severity === "error").map((p) => p.message);

  it("a level the recipe doesn't inherit", () => {
    expect(errs(`nodes:\n  - { id: a, kind: model, capability: llm.write, uses: [series.style] }\n`)[0]).toBe(
      "'series.style' reads from 'series', which this recipe doesn't inherit; add inherits: [series] to the recipe",
    );
  });
  it("a typo in uses suggests the step", () => {
    expect(errs(`nodes:\n  - { id: draw, kind: tool, tool: t }\n  - { id: b, kind: model, capability: llm.write, uses: [drw.image] }\n`)[0]).toMatch(/'drw.image' refers to 'drw'.*Did you mean 'draw'/);
  });
  it("show, beside and prompt references are checked too", () => {
    const e = errs(`nodes:\n  - { id: a, kind: model, capability: llm.write, prompt: "{{ghost.x}}" }\n  - { id: s, kind: screen, review: approve, show: nope.x, beside: [zap.y], actions: [{ id: ok }] }\n`);
    expect(e).toHaveLength(3);
  });
  it("an inherited level passes", () => {
    expect(errs(`inherits: [watchlist]\nnodes:\n  - { id: a, kind: model, capability: llm.write, uses: [watchlist.thesis] }\n`)).toEqual([]);
  });
});
