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
  type StepContext,
  type Tools,
  Pending,
  OFFLOAD_CHARS,
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
  readonly contexts: StepContext[] = [];
  /** How a person answers an `ask_human` question: right away, or not yet (answer later with `s.answer`). */
  human: "answers" | "waits" = "answers";
  constructor(private readonly script: (h: AgentHistory) => AgentReply, private readonly costPerTurn = 0.01) {}

  executors(): Executors {
    return {
      produce: () => [{ done: true }],
      decide: (screen) => {
        if (!screen.actions.some((a) => a.id === "reply")) return { action: "approve" };
        return this.human === "answers" ? { action: "reply", note: "Pune" } : undefined;
      },
      turn: (_node, ctx, history) => {
        this.asked++;
        this.histories.push(history);
        this.contexts.push(ctx);
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
      result: { error: "'delete_everything' isn't one of this step's tools (search, fetch, count_words, ask_human, recall, note, write_file, read_file, list_files)" },
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

/**
 * Runs the research recipe with `script`, the log dying at its `crashAt`-th write,
 * then resumes in a "new process". The model provider, the tools' outside
 * effects and the blob folder outlive the crash; memory doesn't.
 */
function crashRun<T extends Tools>(crashAt: number, script: (h: AgentHistory) => AgentReply, makeTools: () => T, drive: (s: Scheduler, rec: Recorder) => void = (s) => void s.run()) {
  const model = new Model(script);
  const t = makeTools();
  const blobs = memoryBlobs();
  const db = new SqliteEventLog(openDatabase(":memory:"));
  const log = new CrashingLog(db, crashAt);
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(recipe(), rec, model.executors(), [], { tools: t, blobs });
  let crashed = false;
  try {
    s.start(RELEASE, INPUTS);
    drive(s, rec);
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
    drive(s2, r2);
    state = r2.state;
  }
  return { crashed, state: state!, model, tools: t, writes: log.writes, events: readRun(db, "run1") };
}

describe("crash and resume mid-agent", () => {
  const attempt = (k: number) => crashRun(k, researcher, tools);
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

// ── Day 14b: agents that wait and remember ───────────────────────────────

describe("ask_human: an agent asks you and waits (D-26)", () => {
  const asker = (h: AgentHistory): AgentReply =>
    h.length === 0 ? { calls: [{ tool: "ask_human", args: { question: "Which city is Part 3 set in?" } }] } : { final: { report: `Set in ${(h[0]!.results[0]!.result as { answer: string }).answer}` } };

  it("the question waits in the inbox; your reply is the tool's result and the agent carries on", () => {
    const model = new Model(asker);
    model.human = "waits";
    const { s, rec } = run(recipe(), model);
    expect(rec.state.nodes.analyst!.status).toBe("awaiting_human");
    expect(rec.state.status).toBe("running");
    expect(s.inbox()).toEqual([
      { key: "analyst", title: "analyst asks: Which city is Part 3 set in?", review: "edit_text", shows: [], buttons: [{ id: "reply", needs: ["note"], locks: false }] },
    ]);

    s.answer("analyst", { action: "reply", note: "Pune" });
    s.run();
    expect(rec.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: "Set in Pune" });
    expect(rec.state.status).toBe("completed");
    expect(model.asked).toBe(2);
  });

  it("a question you've already answered on the screen doesn't wait", () => {
    const { rec } = run(recipe(), new Model(asker));
    expect(rec.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: "Set in Pune" });
  });

  it("is a built-in: the step doesn't have to list it", () => {
    const model = new Model(asker);
    model.human = "waits";
    const { rec } = run(recipe(), model);
    expect(rec.state.nodes.analyst!.status).toBe("awaiting_human");
  });

  it("an answer without a note is refused plainly", () => {
    const model = new Model(asker);
    model.human = "waits";
    const { s } = run(recipe(), model);
    expect(() => s.answer("analyst", { action: "approve" })).toThrow(`'analyst' asked you: "Which city is Part 3 set in?". Answer with 'reply' and your answer as the note`);
  });

  it("waits across a restart (the next morning) without asking the model again", () => {
    const model = new Model(asker);
    model.human = "waits";
    const t = tools();
    const blobs = memoryBlobs();
    const log = new SqliteEventLog(openDatabase(":memory:"));
    const rec = Recorder.start(log, "run1");
    const s = new Scheduler(recipe(), rec, model.executors(), [], { tools: t, blobs });
    s.start(RELEASE, INPUTS);
    s.run();

    const resumed = Recorder.resume(log, "run1");
    const s2 = new Scheduler(recipe(), resumed, model.executors(), [], { tools: t, blobs });
    s2.recover();
    s2.run();
    expect(resumed.state.nodes.analyst!.status).toBe("awaiting_human");
    s2.answer("analyst", { action: "reply", note: "Pune" });
    s2.run();
    expect(resumed.state.status).toBe("completed");
    expect(model.asked).toBe(2);
    expect(replay(readRun(log, "run1"))).toEqual(resumed.state);
  });
});

describe("slow tools wait on a ticket", () => {
  const slow = (): Tools & { started: string[] } => {
    const started: string[] = [];
    return { started, call: (_tool, _args, ctx) => (started.push(ctx.idempotencyKey), new Pending(`job:${ctx.idempotencyKey}`)) };
  };
  const fetcher = (h: AgentHistory): AgentReply => (h.length === 0 ? { calls: [{ tool: "fetch", args: { url: "https://example.org/long" } }] } : { final: { report: JSON.stringify(h[0]!.results[0]) } });

  it("the agent waits until the job is delivered, then sees its result", () => {
    const t = slow();
    const model = new Model(fetcher);
    const { s, rec } = run(recipe(), model, t);
    expect(rec.state.nodes.analyst).toMatchObject({ status: "waiting_external", ticket: "job:run1/analyst#1/t1.c1" });
    expect(model.asked).toBe(1);

    s.deliverTool("job:run1/analyst#1/t1.c1", { text: "the long page" });
    s.run();
    expect(rec.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: JSON.stringify({ call: 1, tool: "fetch", ok: true, result: { text: "the long page" } }) });
    expect(t.started).toHaveLength(1);
  });

  it("a job that failed reaches the agent as an error", () => {
    const { s, rec } = run(recipe(), new Model(fetcher), slow());
    s.deliverTool("job:run1/analyst#1/t1.c1", undefined, "the page timed out");
    s.run();
    expect(rec.state.nodes.analyst!.versions["1.1"]!.output.report).toContain('"ok":false,"result":{"error":"the page timed out"}');
  });

  it("says plainly when no agent waits on a ticket", () => {
    const { s } = run(recipe(), new Model(fetcher), slow());
    expect(() => s.deliverTool("nope", {})).toThrow("no agent is waiting on ticket 'nope'");
  });
});

describe("agent memory: offload, recall and notes (D-39 steps 1 and 3)", () => {
  const big = "tanker ".repeat(3000); // 21,000 characters
  const reader: Tools = { call: () => ({ text: big }) };

  it("a large result reaches the agent as a preview with its hash; recall reads it back in pieces", () => {
    const model = new Model((h) => {
      if (h.length === 0) return { calls: [{ tool: "fetch", args: { url: "x" } }] };
      const r = h[0]!.results[0]!.result as { offloaded: string; size: number; preview: string };
      if (h.length === 1) return { calls: [{ tool: "recall", args: { hash: r.offloaded, from: 8000 } }] };
      return { final: { report: "read it" } };
    });
    run(recipe(), model, reader);
    const first = model.histories[1]![0]!.results[0]!.result as { offloaded: string; size: number; preview: string };
    expect(first).toMatchObject({ offloaded: expect.stringMatching(/^[0-9a-f]{64}$/), size: JSON.stringify({ text: big }).length });
    expect(first.preview).toHaveLength(400);

    const recalled = model.histories[2]![1]!.results[0]!.result as { from: number; to: number; size: number; text: string };
    expect(recalled).toMatchObject({ from: 8000, to: 8000 + OFFLOAD_CHARS });
    expect(recalled.text).toBe(JSON.stringify({ text: big }).slice(8000, 8000 + OFFLOAD_CHARS));
  });

  it("recall only reads results from this step's own history", () => {
    const model = new Model((h) => (h.length === 0 ? { calls: [{ tool: "recall", args: { hash: "f".repeat(64) } }] } : { final: { report: "ok" } }));
    run(recipe(), model);
    expect(model.histories[1]![0]!.results[0]).toMatchObject({ ok: false, result: { error: `there's no result ${"f".repeat(64)} in this step's history` } });
  });

  it("notes are in every later turn's context; the latest note for a key wins", () => {
    const model = new Model((h) => {
      if (h.length === 0) return { calls: [{ tool: "note", args: { key: "plan", text: "search, then fetch" } }, { tool: "note", args: { key: "city", text: "Pune" } }] };
      if (h.length === 1) return { calls: [{ tool: "note", args: { key: "plan", text: "fetch only" } }] };
      return { final: { report: "done" } };
    });
    run(recipe(), model);
    expect(model.contexts[0]!.notes).toBeUndefined();
    expect(model.contexts[1]!.notes).toEqual({ plan: "search, then fetch", city: "Pune" });
    expect(model.contexts[2]!.notes).toEqual({ plan: "fetch only", city: "Pune" });
  });

  it("a note without a key and text is refused, and not kept", () => {
    const model = new Model((h) => (h.length === 0 ? { calls: [{ tool: "note", args: { text: "no key" } }] } : { final: { report: "ok" } }));
    run(recipe(), model);
    expect(model.histories[1]![0]!.results[0]!.ok).toBe(false);
    expect(model.contexts[1]!.notes).toBeUndefined();
  });
});

describe("crash and resume: an agent that asks you and waits on a slow tool", () => {
  /** Ask a question, take a note, fetch slowly, then answer. The person answers on the screen. */
  const script = (h: AgentHistory): AgentReply => {
    if (h.length === 0) return { calls: [{ tool: "ask_human", args: { question: "Which city?" } }, { tool: "note", args: { key: "city", text: "asked" } }] };
    if (h.length === 1) return { calls: [{ tool: "fetch", args: { url: "https://example.org" } }] };
    return { final: { report: `${(h[0]!.results[0]!.result as { answer: string }).answer}: ${JSON.stringify(h[1]!.results[0]!.result)}` } };
  };

  /** A provider whose slow jobs outlive the crash; each job is keyed, so starting it again is the same job. */
  class SlowTools implements Tools {
    readonly jobs = new Set<string>();
    call(_tool: string, _args: unknown, ctx: { idempotencyKey: string }) {
      this.jobs.add(ctx.idempotencyKey);
      return new Pending(`job:${ctx.idempotencyKey}`);
    }
  }

  function drive(s: Scheduler, rec: Recorder) {
    for (let i = 0; i < 10; i++) {
      s.run();
      const n = rec.state.nodes.analyst;
      if (n?.status !== "waiting_external") return;
      s.deliverTool(n.ticket!, { text: "page" });
    }
  }

  const attempt = (k: number) => crashRun(k, script, () => new SlowTools(), drive);

  const base = attempt(Number.POSITIVE_INFINITY);

  it("the uninterrupted run asks, notes, waits for the job and finishes", () => {
    expect(base.state.status).toBe("completed");
    expect(base.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: 'Pune: {"text":"page"}' });
    expect(base.events.filter((e) => e.type === "Suspended").map((e) => e.kind)).toEqual(["human", "tool_job"]);
  });

  it("a crash at any write, then resume: same result, same log, every turn paid once, one job", () => {
    for (let k = 1; k <= base.writes; k++) {
      const r = attempt(k);
      expect(r.crashed, `write ${k}`).toBe(true);
      expect(r.state, `state after a crash at write ${k}`).toEqual(base.state);
      expect(r.events, `log after a crash at write ${k}`).toEqual(base.events);
      expect([...r.model.paid.keys()], `paid turns after a crash at write ${k}`).toEqual([...base.model.paid.keys()]);
      expect([...r.tools.jobs], `jobs after a crash at write ${k}`).toEqual([...base.tools.jobs]);
    }
  });
});

// ── Day 14c: a workspace of files ────────────────────────────────────────

describe("file tools: each agent step has its own workspace (D-52)", () => {
  /** Draft, list, revise, read back, then answer with the final draft. */
  const writer = (h: AgentHistory): AgentReply => {
    if (h.length === 0) return { calls: [{ tool: "write_file", args: { path: "drafts/part3.md", text: "Tanker Raja arrives." } }, { tool: "write_file", args: { path: "notes.txt", text: "check the valve scene" } }] };
    if (h.length === 1) return { calls: [{ tool: "write_file", args: { path: "drafts/part3.md", text: "Tanker Raja arrives at dawn." } }, { tool: "list_files" }] };
    if (h.length === 2) return { calls: [{ tool: "read_file", args: { path: "drafts/part3.md" } }] };
    return { final: { report: (h[2]!.results[0]!.result as { text: string }).text } };
  };

  it("writes, lists and reads back files; the latest write of a path wins", () => {
    const model = new Model(writer);
    const { rec } = run(recipe(), model);
    expect(model.histories[2]![1]!.results[1]!.result).toEqual({
      files: [
        { path: "drafts/part3.md", size: "Tanker Raja arrives at dawn.".length },
        { path: "notes.txt", size: "check the valve scene".length },
      ],
    });
    expect(model.histories[3]![2]!.results[0]!.result).toMatchObject({ path: "drafts/part3.md", from: 0, size: 28, text: "Tanker Raja arrives at dawn." });
    expect(rec.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: "Tanker Raja arrives at dawn." });
  });

  it("a write returns the path, the content hash and the size", () => {
    const model = new Model(writer);
    run(recipe(), model);
    expect(model.histories[1]![0]!.results[0]).toEqual({ call: 1, tool: "write_file", ok: true, result: { path: "drafts/part3.md", hash: expect.stringMatching(/^[0-9a-f]{64}$/), size: 20 } });
  });

  it("paths stay inside the workspace", () => {
    const model = new Model((h) =>
      h.length === 0
        ? { calls: ["../secrets.env", "/etc/passwd", "a/../../b", ".hidden"].map((path) => ({ tool: "write_file", args: { path, text: "x" } })) }
        : { final: { report: "ok" } },
    );
    run(recipe(), model);
    const results = model.histories[1]![0]!.results;
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0]!.result).toEqual({ error: `write_file needs a relative path like 'drafts/part3.md' (letters, digits, . _ - and /, no '..'), not "../secrets.env"` });
  });

  it("reading a file that isn't there says which files are", () => {
    const model = new Model((h) =>
      h.length === 0
        ? { calls: [{ tool: "read_file", args: { path: "draft.md" } }, { tool: "write_file", args: { path: "a.md", text: "x" } }, { tool: "read_file", args: { path: "b.md" } }] }
        : { final: { report: "ok" } },
    );
    run(recipe(), model);
    const [first, , third] = model.histories[1]![0]!.results;
    expect(first!.result).toEqual({ error: `there's no file "draft.md" in this step's workspace (it's empty)` });
    expect(third!.result).toEqual({ error: `there's no file "b.md" in this step's workspace (a.md)` });
  });

  it("a long file is read in pieces, never offloaded", () => {
    const long = "Mitra spots the valve. ".repeat(1000); // 23,000 characters
    const model = new Model((h) => {
      if (h.length === 0) return { calls: [{ tool: "write_file", args: { path: "script.md", text: long } }] };
      if (h.length === 1) return { calls: [{ tool: "read_file", args: { path: "script.md", from: 8000 } }, { tool: "read_file", args: { path: "script.md", from: 16000 } }] };
      return { final: { report: "ok" } };
    });
    run(recipe(), model);
    const [middle, end] = model.histories[2]![1]!.results.map((x) => x.result as { from: number; to: number; size: number; text: string });
    expect(middle).toMatchObject({ from: 8000, to: 16000, size: long.length, text: long.slice(8000, 16000) }); // a full piece, not a preview
    expect(end).toMatchObject({ from: 16000, to: long.length, text: long.slice(16000) });
  });

  it("replays to the same state", () => {
    const { rec, events } = run(recipe(), new Model(writer));
    expect(replay(events())).toEqual(rec.state);
  });

  describe("crash and resume", () => {
    const attempt = (k: number) => crashRun(k, writer, tools);
    const base = attempt(Number.POSITIVE_INFINITY);

    it("writes a draft and reads it back after a crash at any write: same draft, same log, every turn paid once", () => {
      expect(base.state.nodes.analyst!.versions["1.1"]!.output).toEqual({ report: "Tanker Raja arrives at dawn." });
      for (let k = 1; k <= base.writes; k++) {
        const r = attempt(k);
        expect(r.crashed, `write ${k}`).toBe(true);
        expect(r.state, `state after a crash at write ${k}`).toEqual(base.state);
        expect(r.events, `log after a crash at write ${k}`).toEqual(base.events);
        expect([...r.model.paid.keys()], `paid turns after a crash at write ${k}`).toEqual([...base.model.paid.keys()]);
      }
    });
  });
});
