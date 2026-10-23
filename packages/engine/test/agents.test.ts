import { describe, expect, it } from "vitest";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText } from "../src/load.js";
import {
  memoryBlobs,
  readRun,
  Recorder,
  replay,
  Scheduler,
  type AgentHistory,
  type AgentReply,
  type Blobs,
  type EventSink,
  type Executors,
  type Graph,
  type RunState,
  type Tools,
} from "../src/index.js";

const RELEASE = "a".repeat(64);
const INPUTS = { topic: "the water tanker mafia" };

/** One agent step that researches a topic with three tools. `extra` adds settings (limits). */
const recipe = (extra = ""): Graph => {
  const r = loadText(`graph: research
level: part
inputs:
  topic: text
outputs:
  report: analyst.report
nodes:
  - id: analyst
    kind: agent
    goal: Write a short report on the topic
    tools: [search, fetch, count_words]
    uses: [inputs.topic]
    trust: always
${extra}    out: { report: text }
edges:
  - { from: analyst, to: END }
`);
  expect(r.problems).toEqual([]);
  return r.graphs[0]!;
};

/**
 * A fake model provider that outlives crashes: each turn is keyed by its
 * idempotency key, so asking again returns the same reply, unpaid. `script`
 * picks the reply from the history the engine passes in.
 */
class Model {
  readonly paid = new Map<string, AgentReply>();
  asked = 0;
  readonly histories: AgentHistory[] = [];
  constructor(private readonly script: (h: AgentHistory) => AgentReply, private readonly costPerTurn = 0.01) {}

  executors(): Executors {
    return {
      produce: () => [{ done: true }],
      decide: () => ({ action: "approve" }),
      turn: (_node, ctx, history) => {
        this.asked++;
        this.histories.push(history);
        const key = ctx.idempotencyKey!;
        if (!this.paid.has(key)) this.paid.set(key, this.script(history));
        return { reply: this.paid.get(key)!, tokens: { input: 100, output: 20 }, model: "fake-claude-2026-10-01", cost_usd: this.costPerTurn };
      },
    };
  }
}

/** Search, fetch the top hit, count its words, then write the report. */
const researcher = (h: AgentHistory): AgentReply => {
  if (h.length === 0) return { calls: [{ tool: "search", args: { q: "water tanker mafia" } }] };
  if (h.length === 1) {
    const { url } = h[0]!.results[0]!.result as { url: string };
    return { calls: [{ tool: "fetch", args: { url } }, { tool: "count_words", args: { text: "Tankers set the price" } }] };
  }
  const page = h[1]!.results[0]!.result as { text: string };
  return { final: { report: `${page.text} (${h[1]!.results[1]!.result} words)` } };
};

/** Tools that remember every run, with its idempotency key. */
function tools(): Tools & { runs: { tool: string; key: string }[] } {
  const runs: { tool: string; key: string }[] = [];
  return {
    runs,
    call(tool, args, ctx) {
      runs.push({ tool, key: ctx.idempotencyKey });
      switch (tool) {
        case "search": return { url: "https://example.org/tankers" };
        case "fetch": return { text: `Page at ${(args as { url: string }).url}: tankers set the price` };
        case "count_words": return (args as { text: string }).text.split(" ").length;
        default: throw new Error(`fake tool '${tool}' doesn't exist`);
      }
    },
  };
}

function run(g: Graph, model: Model, t: Tools = tools(), blobs: Blobs = memoryBlobs()) {
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(g, rec, model.executors(), [], { tools: t, blobs });
  s.start(RELEASE, INPUTS);
  s.run();
  return { s, rec, events: () => readRun(log, "run1") };
}

describe("an agent step runs turn by turn, the engine owning the loop (D-26)", () => {
  it("calls 3 tools over 2 turns, then its final answer becomes the step's output", () => {
    const t = tools();
    const { rec, events } = run(recipe(), new Model(researcher), t);
    expect(rec.state.status).toBe("completed");
    const analyst = rec.state.nodes.analyst!;
    expect(analyst.locked?.version).toBe("1.1");
    expect(analyst.versions["1.1"]!.output).toEqual({ report: "Page at https://example.org/tankers: tankers set the price (4 words)" });
    expect(t.runs.map((r) => r.tool)).toEqual(["search", "fetch", "count_words"]);

    const agentEvents = events().filter((e) => ["AgentTurn", "ToolCalled", "ToolResult", "CandidateProduced"].includes(e.type)).map((e) => e.type);
    expect(agentEvents).toEqual(["AgentTurn", "ToolCalled", "ToolResult", "AgentTurn", "ToolCalled", "ToolCalled", "ToolResult", "ToolResult", "AgentTurn", "CandidateProduced"]);
  });

  it("records each turn's model version, tokens and cost; the step's cost is their sum", () => {
    const { rec, events } = run(recipe(), new Model(researcher, 0.02));
    const turns = events().filter((e) => e.type === "AgentTurn");
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ turn: 1, model: "fake-claude-2026-10-01", tokens: { input: 100, output: 20 }, cost_usd: 0.02 });
    expect(rec.state.nodes.analyst!.costUsd).toBeCloseTo(0.06);
  });

  it("each turn sees the earlier turns with what every tool returned, results stored by hash", () => {
    const model = new Model(researcher);
    const { events } = run(recipe(), model);
    expect(model.histories.map((h) => h.length)).toEqual([0, 1, 2]);
    expect(model.histories[2]![1]!.results).toEqual([
      { call: 1, tool: "fetch", ok: true, result: { text: "Page at https://example.org/tankers: tankers set the price" } },
      { call: 2, tool: "count_words", ok: true, result: 4 },
    ]);
    const result = events().find((e) => e.type === "ToolResult");
    expect(result).toMatchObject({ ok: true, result: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("idempotency keys come from the run, step, attempt, turn and call", () => {
    const t = tools();
    const model = new Model(researcher);
    run(recipe(), model, t);
    expect([...model.paid.keys()]).toEqual(["run1/analyst#1/t1", "run1/analyst#1/t2", "run1/analyst#1/t3"]);
    expect(t.runs.map((r) => r.key)).toEqual(["run1/analyst#1/t1.c1", "run1/analyst#1/t2.c1", "run1/analyst#1/t2.c2"]);
  });

  it("replays to the same state", () => {
    const { rec, events } = run(recipe(), new Model(researcher));
    expect(replay(events())).toEqual(rec.state);
  });
});

describe("tools an agent can't use, and tools that fail", () => {
  it("a tool the step doesn't list never runs; the agent is told and carries on (D-22)", () => {
    const t = tools();
    const model = new Model((h) => (h.length === 0 ? { calls: [{ tool: "delete_everything" }] } : { final: { report: "done" } }));
    const { rec } = run(recipe(), model, t);
    expect(t.runs).toEqual([]);
    expect(model.histories[1]![0]!.results[0]).toEqual({
      call: 1,
      tool: "delete_everything",
      ok: false,
      result: { error: "'delete_everything' isn't one of this step's tools (search, fetch, count_words)" },
    });
    expect(rec.state.nodes.analyst!.locked?.version).toBe("1.1");
  });

  it("a tool that throws is reported back to the agent, not a crash", () => {
    const failing: Tools = { call: () => { throw new Error("the site is down"); } };
    const model = new Model((h) => (h.length === 0 ? { calls: [{ tool: "fetch", args: { url: "x" } }] } : { final: { report: "couldn't fetch" } }));
    const { rec } = run(recipe(), model, failing);
    expect(model.histories[1]![0]!.results[0]).toMatchObject({ ok: false, result: { error: "the site is down" } });
    expect(rec.state.status).toBe("completed");
  });

  it("a reply with neither tool calls nor a final answer fails the step plainly", () => {
    const { rec } = run(recipe(), new Model(() => ({ calls: [] })));
    expect(rec.state.nodes.analyst).toMatchObject({ status: "failed", failure: "the agent answered with neither a tool call nor a final answer" });
  });

  it("without an agent runner, the step fails plainly", () => {
    const rec = Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "run1");
    const s = new Scheduler(recipe(), rec, { produce: () => [], decide: () => undefined });
    s.start(RELEASE, INPUTS);
    s.run();
    expect(rec.state.nodes.analyst).toMatchObject({ status: "failed", failure: "agent steps need an agent runner, and none is set up" });
  });
});

describe("limits are checked between turns, never mid-call", () => {
  const forever = (h: AgentHistory): AgentReply => ({ calls: [{ tool: "search", args: { q: `try ${h.length + 1}` } }] });

  it("stops at max_turns", () => {
    const model = new Model(forever);
    const { rec } = run(recipe("    max_turns: 3\n"), model);
    expect(model.asked).toBe(3);
    expect(rec.state.nodes.analyst).toMatchObject({ status: "failed", failure: "it used all 3 of its turns without finishing; raise max_turns or narrow the goal" });
    expect(rec.state.status).toBe("failed");
  });

  it("stops when the budget is spent", () => {
    const model = new Model(forever, 0.3);
    const { rec } = run(recipe("    budget: { usd: 0.5 }\n"), model);
    expect(model.asked).toBe(2); // $0.30, then $0.60: over, so no third turn
    expect(rec.state.nodes.analyst).toMatchObject({ status: "failed", failure: "it spent $0.60 of its $0.50 budget without finishing" });
  });

  it("the default is 8 turns", () => {
    const model = new Model(forever);
    run(recipe(), model);
    expect(model.asked).toBe(8);
  });
});

// ── Crash at every write ──────────────────────────────────────────────────

class Crash extends Error {}

/** An event log that dies on its Nth write, before writing, like a power cut. */
class CrashingLog implements EventSink {
  writes = 0;
  constructor(private readonly inner: SqliteEventLog, private readonly crashAt: number) {}
  append(runId: string, type: string, payload: unknown): number {
    return this.inner.append(runId, type, payload);
  }
  appendMany(runId: string, events: { type: string; payload: unknown }[]): void {
    if (++this.writes === this.crashAt) throw new Crash(`crash at write ${this.crashAt}`);
    this.inner.appendMany(runId, events);
  }
  read(runId: string, afterSeq?: number) {
    return this.inner.read(runId, afterSeq);
  }
}

describe("crash and resume mid-agent", () => {
  /** The model provider, the tools' outside effects and the blob folder all outlive the crash; memory doesn't. */
  function attempt(crashAt: number) {
    const model = new Model(researcher);
    const t = tools();
    const blobs = memoryBlobs();
    const db = new SqliteEventLog(openDatabase(":memory:"));
    const log = new CrashingLog(db, crashAt);
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(recipe(), rec, model.executors(), [], { tools: t, blobs });
    let crashed = false;
    try {
      s.start(RELEASE, INPUTS);
      s.run();
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      crashed = true;
    }
    let state: RunState | undefined;
    if (!crashed) state = rec.state;
    else {
      const fresh = db.read("run1").length === 0;
      const r2 = fresh ? Recorder.start(db, "run1") : Recorder.resume(db, "run1");
      const s2 = new Scheduler(recipe(), r2, model.executors(), [], { tools: t, blobs });
      if (fresh) s2.start(RELEASE, INPUTS);
      else s2.recover();
      s2.run();
      state = r2.state;
    }
    return { crashed, state: state!, model, tools: t, writes: log.writes, events: readRun(db, "run1") };
  }

  const base = attempt(Number.POSITIVE_INFINITY);


  it("a crash at any write, then resume: same result, same log, every turn paid once", () => {
    expect(base.state.status).toBe("completed");
    expect(base.writes).toBeGreaterThan(4);
    for (let k = 1; k <= base.writes; k++) {
      const r = attempt(k);
      expect(r.crashed, `write ${k}`).toBe(true);
      expect(r.state, `state after a crash at write ${k}`).toEqual(base.state);
      expect(r.events, `log after a crash at write ${k}`).toEqual(base.events);
      expect([...r.model.paid.keys()], `paid turns after a crash at write ${k}`).toEqual([...base.model.paid.keys()]);
      // A tool may run again only with the same key (the ToolCalled → ToolResult window); never a new one.
      expect(new Set(r.tools.runs.map((x) => x.key)), `tool keys after a crash at write ${k}`).toEqual(new Set(base.tools.runs.map((x) => x.key)));
    }
  });

  it("resumes at the turn it was on: earlier turns are replayed, not asked again", () => {
    for (let k = 1; k <= base.writes; k++) {
      const r = attempt(k);
      const asked = r.model.asked - base.model.asked;
      expect(asked, `extra model calls after a crash at write ${k}`).toBeLessThanOrEqual(1); // only the call in flight
    }
  });
});
