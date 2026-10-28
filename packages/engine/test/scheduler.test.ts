import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir, loadText } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Decision, type Executors, type Graph, type Node, type StepContext } from "../src/index.js";

/** The series' locked context the Mohalla Mitra recipes inherit. */
const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };

/** A fake Library where every facet exists at v1. */
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };

const EXAMPLES = resolve(__dirname, "../../../examples");
const { graphs } = loadDir(EXAMPLES);
const graph = (id: string) => graphs.find((g) => g.graph === id)!;
const RELEASE = "a".repeat(64);

/** Fakes driven by small scripts: outputs per step per visit, decisions per screen per visit. */
function fakes(
  outputs: Record<string, (ctx: StepContext) => Record<string, unknown>> = {},
  decisions: Record<string, (ctx: StepContext) => Decision> = {},
): Executors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    produce(node: Node, ctx) {
      calls.push(`${node.id}#${ctx.visit}`);
      return [outputs[node.id]?.(ctx) ?? { done: true }];
    },
    // The example shot recipe has a rubric; a judge that passes everything (checks.test.ts covers judging).
    check: (_n, _c, cands) => cands.map((c) => ({ version: c.version, pass: true, issues: [] })),
    decide(node, ctx) {
      calls.push(`${node.id}#${ctx.visit}`);
      const d = decisions[node.id];
      // Generated approvals (D-42) for steps no screen shows: approve unless the test says otherwise.
      if (!d && node.show === node.id) return { action: "approve" };
      if (!d) throw new Error(`test has no decision for '${node.id}'`);
      return d(ctx);
    },
  };
}

function run(g: Graph, exec: Executors, inputs: Record<string, unknown> = {}) {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(g, rec, exec, graphs, LIBRARY);
  s.start(RELEASE, inputs, SERIES);
  const state = s.run();
  const events = readRun(log, "run1");
  const path = events.filter((e) => e.type === "EdgeFollowed").map((e) => `${e.from}→${e.to}`);
  return { state, events, path, rec };
}

describe("voice recipe: a branch", () => {
  it("takes the 'too long' branch when the line runs over 8 seconds", () => {
    const exec = fakes(
      { speak: () => ({ seconds: 9 }), too_long: () => ({ seconds: 7 }) },
      { listen: () => ({ action: "approve" }) },
    );
    const { state, path } = run(graph("voice_recipe"), exec);
    expect(path).toEqual(["speak→too_long", "too_long→listen", "listen→END"]);
    expect(state.status).toBe("completed");
  });

  it("goes straight to review when the line is short enough", () => {
    const exec = fakes({ speak: () => ({ seconds: 6 }) }, { listen: () => ({ action: "approve" }) });
    const { state, path } = run(graph("voice_recipe"), exec);
    expect(path).toEqual(["speak→listen", "listen→END"]);
    expect(state.nodes.too_long).toBeUndefined();
  });
});

describe("voice recipe: a capped loop", () => {
  it("lets the creator ask for a redo, then approves", () => {
    const exec = fakes({ speak: () => ({ seconds: 5 }) }, { listen: (c) => ({ action: c.visit < 3 ? "redo" : "approve", note: "warmer" }) });
    const { state, path } = run(graph("voice_recipe"), exec);
    expect(path.filter((p) => p === "listen→speak")).toHaveLength(2);
    expect(state.nodes.speak?.attempts).toBe(3);
    expect(state.status).toBe("completed");
  });

  it("stops at max_loops instead of looping forever", () => {
    const exec = fakes({ speak: () => ({ seconds: 5 }) }, { listen: () => ({ action: "redo", note: "warmer" }) });
    const { state, path } = run(graph("voice_recipe"), exec);
    expect(path.filter((p) => p === "listen→speak")).toHaveLength(4); // max_loops: 4
    expect(state.nodes.speak?.attempts).toBe(5);
    expect(state.nodes.listen?.status).toBe("failed");
    expect(state.nodes.listen?.failure).toMatch(/went back to 'speak' 4 times, the limit/);
    expect(state.status).toBe("failed");
  });
});

describe("shot recipe", () => {
  const pick = (actions: string[]) => (c: StepContext) => ({ action: actions[c.visit - 1]!, selection: ["1.1"], note: "add the gamcha" });

  it("edits once, then locks and animates a shot marked animate", () => {
    const exec = fakes({}, { pick: pick(["edit", "lock"]) });
    const { state, path } = run(graph("shot_recipe"), exec, { item: { id: "P3-04", animate: true } });
    expect(path).toEqual(["draw→pick", "pick→edit", "edit→pick", "pick→animate", "animate→END"]);
    expect(state.status).toBe("completed");
  });

  it("skips animation for a still shot", () => {
    const exec = fakes({}, { pick: pick(["lock"]) });
    const { path, state } = run(graph("shot_recipe"), exec, { item: { id: "P3-05", animate: false } });
    expect(path).toEqual(["draw→pick", "pick→END"]);
    expect(state.nodes.animate).toBeUndefined();
  });
});

describe("joins", () => {
  const diamond = loadText(`graph: g
level: part
nodes:
  - { id: a, kind: tool, tool: t }
  - { id: b, kind: tool, tool: t }
  - { id: d, kind: tool, tool: t }
  - { id: c, kind: tool, tool: t }
edges:
  - { from: a, to: b }
  - { from: a, to: c }
  - { from: [b, c], to: d, wait: all }
  - { from: d, to: END }
`).graphs[0]!;

  it("fans out, then waits for every branch before the join runs, once", () => {
    const exec = fakes();
    // d is declared before c, so a join that fired early would run d before c.
    const { state, path } = run(diamond, exec);
    expect(exec.calls).toEqual(["a#1", "b#1", "c#1", "d#1"]);
    expect(path.filter((p) => p.endsWith("→d"))).toEqual(["c→d"]);
    expect(state.status).toBe("completed");
  });
});

describe("determinism", () => {
  it("the same recipe and the same recorded results take the same path, event for event", () => {
    const make = () => fakes({ speak: (c) => ({ seconds: c.visit === 1 ? 9 : 5 }), too_long: () => ({ seconds: 7 }) }, { listen: (c) => ({ action: c.visit < 2 ? "redo" : "approve", note: "again" }) });
    const a = run(graph("voice_recipe"), make());
    const b = run(graph("voice_recipe"), make());
    expect(a.events).toEqual(b.events);
  });

  it("the final state is exactly what replaying the log gives", () => {
    const exec = fakes({}, { pick: (c) => ({ action: ["retry", "edit", "lock"][c.visit - 1]!, note: "n", selection: ["1.1"] }) });
    const { state, events } = run(graph("shot_recipe"), exec, { item: { id: "P3-01", animate: true } });
    expect(replay(events)).toEqual(state);
  });
});

describe("for-each (map) and join: the whole Part", () => {
  const shots = [
    { id: "P3-01", animate: true, lines: [] },
    { id: "P3-02", animate: false, lines: [] },
    { id: "P3-03", animate: true, lines: [] },
  ];
  const lines = [
    { id: "L1", speaker: "Mitra" },
    { id: "L2", speaker: "Bheem" },
  ];

  const part = (overrides: { pick?: (c: StepContext) => Decision } = {}) =>
    fakes(
      {
        shot_list: () => ({ shots, lines, hook: "Who will close the valve?" }),
        draw: (c) => ({ image: `img:${(c.inputs.item as { id: string }).id}` }),
        animate: (c) => ({ clip: `clip:${(c.inputs.item as { id: string }).id}` }),
        speak: (c) => ({ audio: `wav:${(c.inputs.item as { id: string }).id}`, seconds: 4 }),
        assemble: () => ({ reel: "reel.mp4" }),
      },
      {
        approve_shots: () => ({ action: "approve" }),
        pick: overrides.pick ?? (() => ({ action: "lock", selection: ["1.1"] })),
        listen: () => ({ action: "approve", selection: ["1.1"] }),
        watch: () => ({ action: "approve" }),
      },
    );

  it("runs part_recipe end to end with fakes", () => {
    const exec = part();
    const { state } = run(graph("part_recipe"), exec, { story_pages: "pages 7–9", part_no: 3 });
    expect(state.status).toBe("completed");
    expect(exec.calls.filter((c) => c === "assemble#1")).toHaveLength(1);
    expect(state.nodes.watch?.decisions[0]?.action).toBe("approve");
  });

  it("gives every item's steps a stable key", () => {
    const { state } = run(graph("part_recipe"), part(), { story_pages: "…", part_no: 3 });
    expect(state.nodes.per_shot?.items?.keys).toEqual(["P3-01", "P3-02", "P3-03"]);
    expect(Object.keys(state.nodes)).toEqual(
      expect.arrayContaining(["per_shot[P3-01].draw", "per_shot[P3-02].pick", "per_shot[P3-03].animate", "voices[L2].listen"]),
    );
    expect(state.nodes["per_shot[P3-02].animate"]).toBeUndefined(); // a still shot is never animated
  });

  it("collects map outputs as lists in shot-list order, null where an item made nothing", () => {
    const { state } = run(graph("part_recipe"), part(), { story_pages: "…", part_no: 3 });
    const out = state.nodes.per_shot!.versions["1.1"]!.output;
    expect(out.clip).toEqual(["clip:P3-01", null, "clip:P3-03"]);
    expect(out.panel).toEqual(["img:P3-01", "img:P3-02", "img:P3-03"]);
    // `listen.selected` is the approved audio itself (D-42), not version ids.
    expect(state.nodes.voices!.versions["1.1"]!.output.audio).toEqual(["wav:L1", "wav:L2"]);
  });

  it("each item counts its own loops", () => {
    // Every shot is retried twice before locking: 3 shots × 2 retries, each well under max_loops 4.
    const exec = part({ pick: (c) => ({ action: c.visit <= 2 ? "retry" : "lock", selection: ["1.1"], note: "again" }) });
    const { state } = run(graph("part_recipe"), exec, { story_pages: "…", part_no: 3 });
    expect(state.status).toBe("completed");
    expect(state.nodes["per_shot[P3-03].draw"]?.attempts).toBe(3);
  });

  it("names the items that didn't finish, and never assembles a partial set", () => {
    const exec = part({ pick: (c) => ({ action: (c.inputs.item as { id: string }).id === "P3-02" ? "retry" : "lock", selection: ["1.1"], note: "again" }) });
    const { state } = run(graph("part_recipe"), exec, { story_pages: "…", part_no: 3 });
    expect(state.nodes["per_shot[P3-02].pick"]?.status).toBe("failed");
    expect(state.nodes["per_shot[P3-03].animate"]?.status).toBe("completed"); // the other items carry on
    expect(state.nodes.per_shot?.failure).toBe("item P3-02 didn't finish");
    expect(state.nodes.assemble).toBeUndefined();
    expect(state.status).toBe("failed");
  });

  it("is deterministic and replays exactly", () => {
    const a = run(graph("part_recipe"), part(), { story_pages: "…", part_no: 3 });
    const b = run(graph("part_recipe"), part(), { story_pages: "…", part_no: 3 });
    expect(a.events).toEqual(b.events);
    expect(replay(a.events)).toEqual(a.state);
  });

  describe("bad lists", () => {
    const withShots = (list: unknown) =>
      fakes({ shot_list: () => ({ shots: list, lines: [], hook: "" }) }, { approve_shots: () => ({ action: "approve" }) });
    const failure = (list: unknown) =>
      run(graph("part_recipe"), withShots(list), { story_pages: "…", part_no: 3 }).state.nodes.per_shot?.failure;

    it("says when the list isn't a list", () => expect(failure("13 shots")).toBe("'shot_list.shots' isn't a list"));
    it("says when an item has no key", () => expect(failure([{ id: "P3-01" }, { animate: true }])).toBe("item 2 of 'shot_list.shots' has no 'id'"));
    it("says when two items share a key", () => expect(failure([{ id: "P3-01" }, { id: "P3-01" }])).toBe("two items in 'shot_list.shots' have the same id 'P3-01'"));
    it("says when a key has odd characters", () => expect(failure([{ id: "P3 01" }])).toMatch(/can only use letters, digits/));
  });

  it("finishes straight away for an empty list", () => {
    const exec = fakes({ shot_list: () => ({ shots: [], lines: [], hook: "" }), assemble: () => ({ reel: "r" }) }, { approve_shots: () => ({ action: "approve" }), watch: () => ({ action: "approve" }) });
    const { state } = run(graph("part_recipe"), exec, { story_pages: "…", part_no: 3 });
    expect(state.status).toBe("completed");
    expect(state.nodes.per_shot!.versions["1.1"]!.output.clip).toEqual([]);
  });
});

describe("for-each over the recipe's own inputs (D-73)", () => {
  const DESK = { desk: { thesis: "growth with rising margins", scoring: ["growth", "margin"], style: "plain" } };
  const FILINGS = [
    { id: "ACME", company: "Acme Tea", release: "Revenue $412M, up 14%." },
    { id: "LNTR", company: "Lantern Rail", release: "Revenue $1.08B, up 3%." },
  ];

  it("the earnings example: one report per filing in the run's inputs, then the quarter ranked from all of them", () => {
    const company = (c: StepContext) => (c.inputs.item as { company: string }).company;
    let ranked: StepContext | undefined;
    const exec = fakes(
      {
        summarize: (c) => ({ headline: `${company(c)} reported`, metrics: [], guidance: "kept", risks: [] }),
        score: (c) => ({ scores: [], total: company(c) === "Acme Tea" ? 8 : 4 }),
        write: (c) => ({ report: `# ${company(c)}` }),
        rank: (c) => ((ranked = c), { ranking: [], summary: "Acme first" }),
      },
      { check_summary: () => ({ action: "approve" }), review: () => ({ action: "approve" }), approve_ranking: () => ({ action: "approve" }) },
    );
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(graph("quarter_from_releases"), rec, exec, graphs, LIBRARY);
    s.start(RELEASE, { quarter: "Q3 2026", filings: FILINGS }, DESK);
    s.run();
    expect(rec.state.status).toBe("completed");
    expect(rec.state.nodes.per_company?.items?.keys).toEqual(["ACME", "LNTR"]);
    expect(rec.state.nodes["per_company[LNTR].summarize"]?.versions["1.1"]?.output).toMatchObject({ headline: "Lantern Rail reported" });
    expect(ranked?.uses).toMatchObject({ "per_company.company": ["Acme Tea", "Lantern Rail"], "per_company.total": [8, 4], "per_company.report": ["# Acme Tea", "# Lantern Rail"] });
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });

  it("a for-each inside another goes through its item's list (item.lines)", () => {
    const [outer, inner, leaf] = ["outer", "inner", "leaf"].map((id) => id);
    const g = (text: string) => loadText(text).graphs[0]!;
    const all = [
      g(`graph: ${outer}\nlevel: part\ninputs: { parts: json }\nnodes:\n  - { id: per_part, kind: map, over: inputs.parts, graph: ${inner} }\nedges:\n  - { from: per_part, to: END }\n`),
      g(`graph: ${inner}\nlevel: shot\ninputs: { item: json }\nnodes:\n  - { id: per_line, kind: map, over: item.lines, graph: ${leaf} }\nedges:\n  - { from: per_line, to: END }\n`),
      g(`graph: ${leaf}\nlevel: line\ninputs: { item: json }\nnodes:\n  - { id: say, kind: model, capability: llm.write, trust: always, prompt: "{{item.text}}", uses: [item.text], out: { said: text } }\nedges:\n  - { from: say, to: END }\n`),
    ];
    const exec = fakes({ say: (c) => ({ said: (c.inputs.item as { text: string }).text }) });
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(all[0]!, rec, exec, all, LIBRARY);
    s.start(RELEASE, { parts: [{ id: "P1", lines: [{ id: "L1", text: "hi" }, { id: "L2", text: "bye" }] }, { id: "P2", lines: [{ id: "L1", text: "again" }] }] });
    s.run();
    expect(rec.state.status).toBe("completed");
    expect(rec.state.nodes["per_part[P1].per_line[L2].say"]?.versions["1.1"]?.output).toEqual({ said: "bye" });
    expect(rec.state.nodes["per_part[P2].per_line[L1].say"]?.versions["1.1"]?.output).toEqual({ said: "again" });
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });
});

describe("for-each over a plain list, and over another for-each's results (D-74)", () => {
  it("tickers → find each release → report on each: the second for-each goes through what the first found", () => {
    const DESK = { desk: { thesis: "growth", scoring: ["growth"], style: "plain" } };
    const seen: Record<string, unknown> = {};
    const exec = fakes(
      {
        research: (c) => ({ found: true, company: `${c.inputs.item} Inc.`, release: `${c.inputs.item} revenue up 9%`, url: `https://ir.example.com/${c.inputs.item}`, date: "2026-10-23" }),
        summarize: (c) => ((seen[(c.inputs.item as { id: string }).id] = c.inputs.item), { headline: "ok", metrics: [], guidance: "none", risks: [] }),
        score: () => ({ scores: [], total: 6 }),
        write: () => ({ report: "# report" }),
        rank: () => ({ ranking: [], summary: "done" }),
      },
      { check_find: () => ({ action: "approve" }), check_summary: () => ({ action: "approve" }), review: () => ({ action: "approve" }), approve_ranking: () => ({ action: "approve" }) },
    );
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(graph("quarter_review"), rec, exec, graphs, LIBRARY);
    s.start(RELEASE, { quarter: "Q3 2026", tickers: ["AAPL", "MSFT"] }, DESK);
    s.run();
    expect(rec.state.status).toBe("completed");
    expect(rec.state.nodes.find?.items?.keys).toEqual(["AAPL", "MSFT"]);
    expect(rec.state.nodes.per_company?.items?.keys).toEqual(["AAPL", "MSFT"]);
    expect(seen.MSFT).toEqual({ id: "MSFT", company: "MSFT Inc.", release: "MSFT revenue up 9%", source: "https://ir.example.com/MSFT", date: "2026-10-23" });
    expect(replay(readRun(log, "run1"))).toEqual(rec.state);
  });
});
