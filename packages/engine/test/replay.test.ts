import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteEventLog, openStore } from "@kriya/store";
import { Recorder, readRun, replay, apply, ReplayError, type EngineEvent, type RunState } from "../src/index.js";

const h = (c: string) => c.repeat(64);

/** A small Part run touching every event type: a model step with a fix loop, a human pick, an agent, staleness. */
const SCRIPT: EngineEvent[] = [
  { type: "RunStarted", release: h("a"), graph: "part_recipe", inputs: { part_no: 3 }, context: {} },
  { type: "NodeReady", node: "shot_list" },
  { type: "AttemptStarted", node: "shot_list", attempt: 1 },
  { type: "CandidateProduced", node: "shot_list", attempt: 1, candidate: 1, output: { shots: ["P3-01", "P3-02"] }, parents: [], model: "claude@2026-09", cost_usd: 0.04 },
  { type: "VerdictRecorded", node: "shot_list", version: "1.1", by: "code", pass: true, issues: [], cost_usd: 0 },
  { type: "Locked", node: "shot_list", version: "1.1", by: "auto" },
  { type: "NodeReady", node: "per_shot[P3-01].draw" },
  { type: "AttemptStarted", node: "per_shot[P3-01].draw", attempt: 1 },
  { type: "Suspended", node: "per_shot[P3-01].draw", ticket: "replicate:abc", kind: "model_job" },
  { type: "Resumed", node: "per_shot[P3-01].draw", ticket: "replicate:abc" },
  { type: "CandidateProduced", node: "per_shot[P3-01].draw", attempt: 1, candidate: 1, output: { image: h("b") }, parents: [], model: "nano-banana@v1", seed: 7, cost_usd: 0.03 },
  { type: "CandidateProduced", node: "per_shot[P3-01].draw", attempt: 1, candidate: 2, output: { image: h("c") }, parents: [], model: "nano-banana@v1", seed: 8, cost_usd: 0.03 },
  { type: "VerdictRecorded", node: "per_shot[P3-01].draw", version: "1.2", by: "llm", pass: false, issues: [{ type: "missing_detail", what: "gamcha", fix: "edit" }], model: "claude@2026-09", cost_usd: 0.01 },
  { type: "FixChosen", node: "per_shot[P3-01].draw", fix: "edit", issue: "missing_detail" },
  { type: "AttemptStarted", node: "per_shot[P3-01].draw", attempt: 2 },
  { type: "CandidateProduced", node: "per_shot[P3-01].draw", attempt: 2, candidate: 1, output: { image: h("d") }, parents: ["1.2"], prompt: "add the gamcha", model: "nano-banana@v1", cost_usd: 0.03 },
  { type: "Suspended", node: "per_shot[P3-01].draw", ticket: "inbox:1", kind: "human" },
  { type: "HumanDecision", node: "per_shot[P3-01].draw", action: "lock", selection: ["2.1"], note: "expression is right" },
  { type: "Resumed", node: "per_shot[P3-01].draw", ticket: "inbox:1" },
  { type: "Locked", node: "per_shot[P3-01].draw", version: "2.1", by: "human", why: "expression is right" },
  { type: "NodeReady", node: "fix_agent" },
  { type: "AgentTurn", node: "fix_agent", turn: 1, response: { tool: "crop" }, tokens: { input: 900, output: 40 }, model: "claude@2026-09", cost_usd: 0.002 },
  { type: "ToolCalled", node: "fix_agent", turn: 1, call: 1, tool: "crop", args: { box: [0, 0, 10, 10] } },
  { type: "ToolResult", node: "fix_agent", turn: 1, call: 1, ok: true, result: h("e") },
  { type: "AgentTurn", node: "fix_agent", turn: 2, response: { final: true }, tokens: { input: 1200, output: 20 }, model: "claude@2026-09", cost_usd: 0.003 },
  { type: "HistoryCompacted", node: "fix_agent", turn: 2, covers: [1, 1], digest: h("f"), model: "claude@2026-09", cost_usd: 0.001 },
  { type: "NodeFailed", node: "fix_agent", reason: "budget reached" },
  { type: "MarkedStale", node: "per_shot[P3-01].draw", reason: "@Bheem look v3" },
  { type: "Unlocked", node: "per_shot[P3-01].draw" },
  { type: "NodeCompleted", node: "shot_list" },
  { type: "RunCompleted", status: "completed" },
];

const tempLog = () => {
  const dir = join(mkdtempSync(join(tmpdir(), "kriya-replay-")), ".kriya");
  return openStore(dir);
};

describe("replay == live", () => {
  it("rebuilds exactly the live state from SQLite, after reopening the database", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kriya-replay-")), ".kriya");
    const s1 = openStore(dir);
    const live = Recorder.start(s1.events, "run1");
    for (const e of SCRIPT) live.record(e);
    s1.close();

    const s2 = openStore(dir);
    expect(Recorder.resume(s2.events, "run1").state).toEqual(live.state);
    s2.close();
  });

  it("matches live state at every point: a crash after any event loses nothing", () => {
    const store = tempLog();
    const live = Recorder.start(store.events, "run1");
    const snapshots: RunState[] = SCRIPT.map((e) => structuredClone(live.record(e)));
    const logged = readRun(store.events, "run1");
    snapshots.forEach((snap, k) => expect(replay(logged.slice(0, k + 1))).toEqual(snap));
  });

  it("resuming after a crash and finishing gives the same result as never crashing", () => {
    const whole = Recorder.start(tempLog().events, "run1");
    for (const e of SCRIPT) whole.record(e);

    for (let crashAt = 1; crashAt < SCRIPT.length; crashAt++) {
      const store = tempLog();
      const before = Recorder.start(store.events, "run1");
      SCRIPT.slice(0, crashAt).forEach((e) => before.record(e));
      const after = Recorder.resume(store.events, "run1");
      SCRIPT.slice(crashAt).forEach((e) => after.record(e));
      expect(after.state, `crash after event ${crashAt}`).toEqual(whole.state);
    }
  });

  it("keeps the facts that matter", () => {
    const r = Recorder.start(tempLog().events, "run1");
    for (const e of SCRIPT.slice(0, 20)) r.record(e);
    const draw = r.state.nodes["per_shot[P3-01].draw"]!;
    expect(draw.locked).toEqual({ version: "2.1", by: "human", why: "expression is right" });
    expect(draw.versions["2.1"]?.parents).toEqual(["1.2"]);
    expect(draw.versions["1.2"]?.verdicts[0]?.pass).toBe(false);
    expect(draw.costUsd).toBeCloseTo(0.1);
  });
});

describe("refusing events that can't happen", () => {
  const started = () => {
    const store = tempLog();
    const r = Recorder.start(store.events, "run1");
    SCRIPT.slice(0, 3).forEach((e) => r.record(e)); // shot_list attempt 1 running
    return { r, store };
  };

  const cases: [string, EngineEvent, RegExp][] = [
    ["locking a version that doesn't exist", { type: "Locked", node: "shot_list", version: "9.9", by: "human" }, /version 9.9 doesn't exist/],
    ["a step that was never made ready", { type: "AttemptStarted", node: "ghost", attempt: 1 }, /never made ready/],
    ["skipping an attempt number", { type: "AttemptStarted", node: "shot_list", attempt: 3 }, /expected attempt 2/],
    ["resuming the wrong ticket", { type: "Resumed", node: "shot_list", ticket: "nope" }, /isn't waiting on ticket/],
    ["a tool result with no call", { type: "ToolResult", node: "shot_list", turn: 1, call: 1, ok: true, result: h("e") }, /never made/],
    ["a parent version that doesn't exist", { type: "CandidateProduced", node: "shot_list", attempt: 1, candidate: 1, output: {}, parents: ["4.4"], cost_usd: 0 }, /parent version 4.4/],
  ];

  it.each(cases)("refuses %s, and doesn't write it", (_name, bad, message) => {
    const { r, store } = started();
    expect(() => r.record(bad)).toThrow(message);
    expect(store.events.read("run1")).toHaveLength(3);
  });

  it("refuses anything before RunStarted", () => {
    expect(() => apply(undefined, { type: "NodeReady", node: "a" })).toThrow(ReplayError);
  });

  it("refuses events after the run has finished", () => {
    const r = Recorder.start(tempLog().events, "run1");
    SCRIPT.forEach((e) => r.record(e));
    expect(() => r.record({ type: "NodeReady", node: "late" })).toThrow(/already completed/);
  });

  it("refuses payloads that wouldn't survive saving", () => {
    const { r } = started();
    const bad = (output: Record<string, unknown>) =>
      ({ type: "CandidateProduced", node: "shot_list", attempt: 1, candidate: 1, output, parents: [], cost_usd: 0 }) as EngineEvent;
    expect(() => r.record(bad({ seconds: Number.NaN }))).toThrow(/output.seconds is NaN/);
    expect(() => r.record(bad({ when: new Date() }))).toThrow(/output.when is a Date/);
    expect(() => r.record(bad({ gone: undefined }))).toThrow(/output.gone is missing/);
  });

  it("won't start a run twice", () => {
    const store = tempLog();
    Recorder.start(store.events, "run1").record(SCRIPT[0]!);
    expect(() => Recorder.start(store.events, "run1")).toThrow(/use Recorder.resume/);
  });
});

describe("reading a damaged log", () => {
  it("says which event is wrong", () => {
    const log = new SqliteEventLog(openDatabase(":memory:"));
    log.append("run1", "RunStarted", { release: "short", graph: "g" });
    expect(() => readRun(log, "run1")).toThrow(/event 'RunStarted' in the log doesn't look right \(at release\)/);
  });

  it("rejects event types it doesn't know", () => {
    const log = new SqliteEventLog(openDatabase(":memory:"));
    log.append("run1", "Teleported", {});
    expect(() => readRun(log, "run1")).toThrow(/event 'Teleported'/);
  });
});

describe("apply is pure", () => {
  it("never changes the state it was given", () => {
    let state: RunState | undefined;
    for (const e of SCRIPT) {
      const before = structuredClone(state);
      const next = apply(state, e);
      expect(state).toEqual(before);
      state = next;
    }
  });
});
