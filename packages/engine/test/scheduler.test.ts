import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir, loadText } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Decision, type Executors, type Graph, type Node, type StepContext } from "../src/index.js";

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
    decide(node, ctx) {
      calls.push(`${node.id}#${ctx.visit}`);
      const d = decisions[node.id];
      if (!d) throw new Error(`test has no decision for '${node.id}'`);
      return d(ctx);
    },
  };
}

function run(g: Graph, exec: Executors, inputs: Record<string, unknown> = {}) {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(g, rec, exec);
  s.start(RELEASE, inputs);
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
    const exec = fakes({ speak: () => ({ seconds: 5 }) }, { listen: () => ({ action: "redo" }) });
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
    const make = () => fakes({ speak: (c) => ({ seconds: c.visit === 1 ? 9 : 5 }), too_long: () => ({ seconds: 7 }) }, { listen: (c) => ({ action: c.visit < 2 ? "redo" : "approve" }) });
    const a = run(graph("voice_recipe"), make());
    const b = run(graph("voice_recipe"), make());
    expect(a.events).toEqual(b.events);
  });

  it("the final state is exactly what replaying the log gives", () => {
    const exec = fakes({}, { pick: (c) => ({ action: ["retry", "edit", "lock"][c.visit - 1]!, note: "n" }) });
    const { state, events } = run(graph("shot_recipe"), exec, { item: { id: "P3-01", animate: true } });
    expect(replay(events)).toEqual(state);
  });
});

describe("not yet supported", () => {
  it("says plainly that for-each steps can't run yet", () => {
    const exec = fakes({}, { approve_shots: () => ({ action: "approve" }) });
    const { state } = run(graph("part_recipe"), exec, { story_pages: "…", part_no: 3 });
    expect(state.nodes.per_shot?.failure).toMatch(/'map' steps can't run yet/);
    expect(state.status).toBe("failed");
  });
});
