import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir, loadText } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Decision, type Executors, type Graph, type StepContext } from "../src/index.js";

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const example = (id: string) => graphs.find((g) => g.graph === id)!;
const one = (yaml: string) => {
  const { graphs: [g], problems } = loadText(`graph: g\nlevel: part\n${yaml}`);
  expect(problems.filter((p) => p.severity === "error")).toEqual([]);
  return g!;
};

type Seen = Record<string, StepContext[]>;

/** Fakes: each step returns `n` candidates; screens answer from the script; everything a step saw is kept. */
function fakes(
  outputs: Record<string, (c: StepContext) => Record<string, unknown>[]>,
  decisions: Record<string, (c: StepContext) => Decision> = {},
): Executors & { seen: Seen } {
  const seen: Seen = {};
  return {
    seen,
    produce(node, ctx) {
      (seen[node.id] ??= []).push(ctx);
      return outputs[node.id]?.(ctx) ?? [{ done: true }];
    },
    decide(node, ctx) {
      const d = decisions[node.id];
      if (!d && node.show === node.id) return { action: "approve" };
      if (!d) throw new Error(`no decision for '${node.id}'`);
      return d(ctx);
    },
  };
}

function run(g: Graph, exec: Executors, inputs: Record<string, unknown> = {}) {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const s = new Scheduler(g, Recorder.start(log, "run1"), exec, graphs);
  s.start("a".repeat(64), inputs);
  const state = s.run();
  return { state, events: readRun(log, "run1") };
}

const panels = (c: StepContext) =>
  [1, 2, 3].map((i) => ({ image: `img:${(c.inputs.item as { id: string }).id}:a${c.visit}c${i}` }));

describe("locking from a screen", () => {
  it("locks the candidate you picked, with your note as the why", () => {
    const exec = fakes({ draw: panels }, { pick: () => ({ action: "lock", selection: ["1.2"], note: "Bheem's expression is right" }) });
    const { state } = run(example("shot_recipe"), exec, { item: { id: "P3-04", animate: false } });
    expect(state.nodes.draw?.locked).toEqual({ version: "1.2", by: "human", why: "Bheem's expression is right" });
    expect(state.status).toBe("completed");
  });

  it("doesn't lock on buttons without locks: true", () => {
    // edit takes a selection too, but it's what to edit, not what to keep
    const exec = fakes({ draw: panels }, { pick: (c) => (c.visit === 1 ? { action: "edit", selection: ["1.3"], note: "add gamcha" } : { action: "lock", selection: ["1.1"] }) });
    const { events } = run(example("shot_recipe"), exec, { item: { id: "P3-04", animate: false } });
    const drawLocks = events.filter((e) => e.type === "Locked" && e.node === "draw");
    expect(drawLocks).toEqual([{ type: "Locked", node: "draw", version: "1.1", by: "human" }]);
  });

  it("an approve with no selection locks the only candidate of the latest attempt", () => {
    const exec = fakes({ speak: (c) => [{ audio: `wav${c.visit}`, seconds: 5 }] }, { listen: (c) => ({ action: c.visit < 3 ? "redo" : "approve" }) });
    const { state } = run(example("voice_recipe"), exec, { item: { id: "L1" } });
    expect(state.nodes.speak?.locked?.version).toBe("3.1");
  });

  it("says plainly when an approve can't tell which of several options you meant", () => {
    const g = one(`nodes:
  - { id: draw, kind: model, capability: image.generate, options: 3, out: { image: image } }
  - { id: ok, kind: screen, review: approve, show: draw.image, actions: [{ id: yes, locks: true }] }
edges:
  - { from: draw, to: ok }
  - { from: ok, to: END }
`);
    const { state } = run(g, fakes({ draw: () => [{ image: "a" }, { image: "b" }, { image: "c" }] }, { ok: () => ({ action: "yes" }) }));
    expect(state.nodes.ok?.failure).toBe("pick one of the 3 options of 'draw' to lock");
    expect(state.nodes.draw?.locked).toBeUndefined();
  });

  it("says plainly when the picked version doesn't exist", () => {
    const exec = fakes({ draw: panels }, { pick: () => ({ action: "lock", selection: ["9.9"] }) });
    const { state } = run(example("shot_recipe"), exec, { item: { id: "P3-04", animate: false } });
    expect(state.nodes.pick?.failure).toBe("version 9.9 of 'draw' doesn't exist");
  });
});

describe("who locks what", () => {
  it("tools and trust: always lock themselves", () => {
    const g = one(`nodes:
  - { id: crop, kind: tool, tool: crop }
  - { id: caption, kind: model, capability: llm.write, trust: always }
edges:
  - { from: crop, to: caption }
  - { from: caption, to: END }
`);
    const { state, events } = run(g, fakes({}));
    expect(state.nodes.crop?.locked?.by).toBe("auto");
    expect(state.nodes.caption?.locked?.by).toBe("auto");
    expect(events.some((e) => e.type === "Suspended")).toBe(false);
  });

  it("a step no screen shows asks on a generated approval (ask_me and when_confident)", () => {
    const exec = fakes({ draw: panels, animate: () => [{ clip: "c" }] }, { pick: () => ({ action: "lock", selection: ["1.1"] }) });
    const { state, events } = run(example("shot_recipe"), exec, { item: { id: "P3-04", animate: true } });
    expect(events).toContainEqual({ type: "Suspended", node: "animate", ticket: "animate:approve:1", kind: "human" });
    expect(state.nodes.animate?.locked).toEqual({ version: "1.1", by: "human" });
  });

  it("a step a screen shows waits for that screen instead", () => {
    const exec = fakes({ draw: panels }, { pick: () => ({ action: "lock", selection: ["1.1"] }) });
    const { events } = run(example("shot_recipe"), exec, { item: { id: "P3-04", animate: false } });
    expect(events.filter((e) => e.type === "Suspended").map((e) => e.node)).toEqual(["pick"]);
  });
});

describe("only locked outputs enter context", () => {
  it("the next step sees the picked panel, never the rejected ones", () => {
    const exec = fakes({ draw: panels, animate: () => [{ clip: "c" }] }, { pick: () => ({ action: "lock", selection: ["1.2"] }) });
    run(example("shot_recipe"), exec, { item: { id: "P3-04", animate: true } });
    const animate = exec.seen.animate![0]!;
    expect(animate.uses["pick.selected"]).toBe("img:P3-04:a1c2");
    const everything = JSON.stringify(animate.uses);
    expect(everything).not.toContain("a1c1");
    expect(everything).not.toContain("a1c3");
  });

  it("a step that isn't locked yet is invisible downstream", () => {
    const g = one(`nodes:
  - { id: a, kind: model, capability: llm.write, out: { x: text } }
  - { id: look, kind: screen, review: approve, show: a.x, actions: [{ id: seen }, { id: keep, locks: true }] }
  - { id: b, kind: model, capability: llm.write, trust: always, uses: [a.x] }
edges:
  - { from: a, to: look }
  - { from: look, to: b, when: "action == 'seen'" }
  - { from: look, to: END, when: "action == 'keep'" }
  - { from: b, to: END }
`);
    const exec = fakes({ a: () => [{ x: "draft" }] }, { look: () => ({ action: "seen" }) });
    run(g, exec);
    expect(exec.seen.b![0]!.uses).toEqual({ "a.x": undefined });
  });

  it("after a redo, context moves to the newly locked version", () => {
    const exec = fakes({ speak: (c) => [{ audio: `take${c.visit}`, seconds: 5 }] }, { listen: (c) => ({ action: c.visit === 1 ? "redo" : "approve" }) });
    const { state } = run(example("voice_recipe"), exec, { item: { id: "L1" } });
    const s = state.nodes.speak!;
    expect(s.versions[s.locked!.version]?.output.audio).toBe("take2");
  });
});

describe("result: the draft an edge routes on (D-43)", () => {
  it("routes on the candidate just made, before anyone locks it", () => {
    const exec = fakes({ speak: () => [{ audio: "a", seconds: 9 }], too_long: () => [{ audio: "b", seconds: 7 }] }, { listen: () => ({ action: "approve" }) });
    const { events } = run(example("voice_recipe"), exec, { item: { id: "L1" } });
    const firstEdge = events.find((e) => e.type === "EdgeFollowed");
    expect(firstEdge).toMatchObject({ from: "speak", to: "too_long" });
    // speak wasn't locked when the edge was followed
    const lockedBefore = events.slice(0, events.indexOf(firstEdge!)).some((e) => e.type === "Locked" && e.node === "speak");
    expect(lockedBefore).toBe(false);
  });

  it("replays to the same state", () => {
    const exec = fakes({ draw: panels, animate: () => [{ clip: "c" }] }, { pick: (c) => (c.visit === 1 ? { action: "retry", note: "n" } : { action: "lock", selection: ["2.3"], note: "best" }) });
    const { state, events } = run(example("shot_recipe"), exec, { item: { id: "P3-04", animate: true } });
    expect(state.nodes.draw?.locked?.version).toBe("2.3");
    expect(replay(events)).toEqual(state);
  });
});
