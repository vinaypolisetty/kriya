import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadDir } from "../src/load.js";
import { Recorder, readRun, replay, Scheduler, type Decision, type Executors, type EventSink, type RunState, type StepContext } from "../src/index.js";

/** The series' locked context the Mohalla Mitra recipes inherit. */
const SERIES = { series: { style: "2D cartoon, flat colors", rules: "no real film songs", cast: ["Mitra", "Bheem"] } };

/** A fake Library where every facet exists at v1. */
const LIBRARY = { assets: { facet: (entity: string, facet: string) => ({ version: "v1", value: `${entity}:${facet}` }) } };

const { graphs } = loadDir(resolve(__dirname, "../../../examples"));
const part = graphs.find((g) => g.graph === "part_recipe")!;
const RELEASE = "a".repeat(64);
const INPUTS = { story_pages: "pages 7–9", part_no: 3 };

const SHOTS = [
  { id: "P3-01", action: "Tanker arrives", animate: false },
  { id: "P3-02", action: "Mitra spots the valve", animate: true },
];
const LINES = [{ id: "L1", speaker: "Mitra" }];

/**
 * A fake provider that outlives crashes, like Replicate does. Every job is
 * keyed by its idempotency key: asking again returns the same job, unpaid.
 * Slow capabilities (video, speech) answer with a ticket.
 */
class Provider {
  readonly paid = new Map<string, Record<string, unknown>[]>();
  submissions = 0;

  submit(key: string, make: () => Record<string, unknown>[]): Record<string, unknown>[] {
    this.submissions++;
    if (!this.paid.has(key)) this.paid.set(key, make());
    return this.paid.get(key)!;
  }

  result(ticket: string): Record<string, unknown>[] {
    const r = this.paid.get(ticket);
    if (!r) throw new Error(`unknown job ${ticket}`);
    return r;
  }
}

function executors(provider: Provider): Executors {
  const item = (c: StepContext) => (c.inputs.item as { id: string }).id;
  return {
    produce(node, c) {
      const key = c.idempotencyKey!;
      const make = (): Record<string, unknown>[] => {
        switch (node.id) {
          case "shot_list": return [{ shots: SHOTS, lines: LINES, hook: "Who will close the valve?" }];
          case "draw": return [1, 2].map((i) => ({ image: `img:${item(c)}:${i}` }));
          case "animate": return [{ clip: `clip:${item(c)}` }];
          case "speak": return [{ audio: `wav:${item(c)}`, seconds: 4 }];
          case "assemble": return [{ reel: "reel.mp4" }];
          default: return [{ done: true }];
        }
      };
      const out = provider.submit(key, make);
      // Video and speech are slow: the provider answers with a ticket, and the job is delivered later.
      return node.kind === "model" && (node.capability === "video.from_image" || node.capability === "audio.speech") ? { ticket: key } : out;
    },
    decide(node, c): Decision {
      if (node.id === "pick") return { action: "lock", selection: [c.shows!.at(-1)!.version] };
      return { action: "approve" };
    },
  };
}

/** Runs until done, delivering finished provider jobs in a fixed order. */
function drive(s: Scheduler, rec: Recorder, provider: Provider): void {
  for (let i = 0; i < 100; i++) {
    s.run();
    const waiting = Object.entries(rec.state.nodes)
      .filter(([, n]) => n.status === "waiting_external")
      .map(([, n]) => n.ticket!)
      .sort();
    if (waiting.length === 0) return;
    s.deliver(waiting[0]!, provider.result(waiting[0]!));
  }
}

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

function uninterrupted() {
  const provider = new Provider();
  const db = new SqliteEventLog(openDatabase(":memory:"));
  const log = new CrashingLog(db, Number.POSITIVE_INFINITY);
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(part, rec, executors(provider), graphs, LIBRARY);
  s.start(RELEASE, INPUTS, SERIES);
  drive(s, rec, provider);
  return { state: rec.state, provider, writes: log.writes, events: readRun(db, "run1") };
}

function crashAndResume(crashAt: number) {
  const provider = new Provider();
  const db = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(new CrashingLog(db, crashAt), "run1");
  const s = new Scheduler(part, rec, executors(provider), graphs, LIBRARY);
  let crashed = false;
  try {
    s.start(RELEASE, INPUTS, SERIES);
    drive(s, rec, provider);
  } catch (e) {
    if (!(e instanceof Crash)) throw e;
    crashed = true;
  }
  // Restart: a new process reads the log and carries on. Nothing from memory survives.
  let state: RunState;
  if (db.read("run1").length === 0) {
    const fresh = Recorder.start(db, "run1");
    const s2 = new Scheduler(part, fresh, executors(provider), graphs, LIBRARY);
    s2.start(RELEASE, INPUTS, SERIES);
    drive(s2, fresh, provider);
    state = fresh.state;
  } else {
    const resumed = Recorder.resume(db, "run1");
    const s2 = new Scheduler(part, resumed, executors(provider), graphs, LIBRARY);
    s2.recover();
    drive(s2, resumed, provider);
    state = resumed.state;
  }
  return { crashed, state, provider, events: readRun(db, "run1") };
}

describe("crash and resume: no duplicate calls", () => {
  const base = uninterrupted();

  it("the uninterrupted Part finishes, with slow jobs delivered on tickets", () => {
    expect(base.state.status).toBe("completed");
    expect(base.events.some((e) => e.type === "Suspended" && e.kind === "model_job")).toBe(true);
    expect(base.provider.paid.size).toBe(1 + 2 + 1 + 1 + 1); // shot list, 2 panels, 1 clip, 1 line, the Reel
  });

  it(`a crash at any of the run's writes, then resume: same result, nothing paid twice`, () => {
    expect(base.writes).toBeGreaterThan(20);
    for (let k = 1; k <= base.writes; k++) {
      const r = crashAndResume(k);
      expect(r.crashed, `write ${k}`).toBe(true);
      expect(r.state, `final state after a crash at write ${k}`).toEqual(base.state);
      expect([...r.provider.paid.keys()], `paid jobs after a crash at write ${k}`).toEqual([...base.provider.paid.keys()]);
      expect(r.events, `log after a crash at write ${k}`).toEqual(base.events);
    }
  });

  it("crashes right after a paid call happen, and those are asked again with the same key, unpaid", () => {
    // A crash at the write that follows a model call: the call was made (and paid) but not recorded.
    const askedTwice = [];
    for (let k = 1; k <= base.writes; k++) {
      const r = crashAndResume(k);
      if (r.provider.submissions > base.provider.submissions) askedTwice.push(k);
      expect(r.provider.paid.size).toBe(base.provider.paid.size);
    }
    expect(askedTwice.length).toBeGreaterThanOrEqual(base.provider.paid.size); // at least one per paid job
  });

  it("the log is still exactly replayable", () => {
    const r = crashAndResume(10);
    expect(replay(r.events)).toEqual(r.state);
  });
});

describe("tickets", () => {
  it("a slow job keeps the step waiting until it's delivered", () => {
    const provider = new Provider();
    const rec = Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "run1");
    const s = new Scheduler(part, rec, executors(provider), graphs, LIBRARY);
    s.start(RELEASE, INPUTS, SERIES);
    s.run();
    const waiting = Object.entries(rec.state.nodes).filter(([, n]) => n.status === "waiting_external").map(([k]) => k);
    expect(waiting.length).toBeGreaterThan(0);
    expect(rec.state.status).toBe("running");
  });

  it("says plainly when nothing waits on a ticket", () => {
    const provider = new Provider();
    const rec = Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "run1");
    const s = new Scheduler(part, rec, executors(provider), graphs, LIBRARY);
    s.start(RELEASE, INPUTS, SERIES);
    expect(() => s.deliver("nope", [])).toThrow("no step is waiting on ticket 'nope'");
  });
});
