/**
 * The live side of the event log. Every engine action goes through `record`:
 * the event is checked and applied first, then appended, so an event that
 * can't happen never reaches the log, and live state always equals replay.
 */
import { EngineEvent, parseEvent, type EngineEventInput } from "./events.js";
import { apply, replay, type RunState } from "./state.js";

/** What the engine needs from storage. `@kriya/store`'s SqliteEventLog fits this. */
export interface EventSink {
  append(runId: string, type: string, payload: unknown): number;
  read(runId: string, afterSeq?: number): { type: string; payload: unknown }[];
  /** Atomic: all of them or none. Without it, a batch is appended one by one. */
  appendMany?(runId: string, events: { type: string; payload: unknown }[]): void;
}

export class Recorder {
  private current: RunState | undefined;
  /** Events recorded since `begin`, not yet written; and the state to go back to if they're dropped. */
  private pending: { type: string; payload: unknown }[] | undefined;
  private committed: RunState | undefined;

  private constructor(
    private readonly log: EventSink,
    readonly runId: string,
    state: RunState | undefined,
  ) {
    this.current = state;
  }

  /** A new run with nothing recorded yet. */
  static start(log: EventSink, runId: string): Recorder {
    if (log.read(runId).length > 0) throw new Error(`run '${runId}' already has events; use Recorder.resume`);
    return new Recorder(log, runId, undefined);
  }

  /** Picks up an existing run by replaying its log. */
  static resume(log: EventSink, runId: string): Recorder {
    return new Recorder(log, runId, replay(readRun(log, runId)));
  }

  get state(): RunState {
    if (!this.current) throw new Error(`run '${this.runId}' hasn't started`);
    return this.current;
  }

  record(event: EngineEventInput): RunState {
    const e = EngineEvent.parse(event);
    const { type, ...payload } = e;
    checkJson(payload, type);
    const next = apply(this.current, e);
    if (this.pending) this.pending.push({ type, payload });
    else this.log.append(this.runId, type, payload);
    this.current = next;
    return next;
  }

  /**
   * Starts a batch: events are applied but held until `commit`, which writes
   * them atomically. A crash before the commit loses the whole batch and
   * nothing else, so the log never holds half of a step.
   */
  begin(): void {
    if (this.pending) throw new Error("a batch is already open");
    this.pending = [];
    this.committed = this.current;
  }

  /** Whether a batch is open. */
  get batching(): boolean {
    return this.pending !== undefined;
  }

  commit(): void {
    const batch = this.pending;
    if (!batch) return;
    try {
      if (batch.length > 0) {
        if (this.log.appendMany) this.log.appendMany(this.runId, batch);
        else for (const e of batch) this.log.append(this.runId, e.type, e.payload);
      }
    } catch (err) {
      this.rollback();
      throw err;
    }
    this.pending = undefined;
  }

  /** Drops the open batch and goes back to the last committed state. */
  rollback(): void {
    if (!this.pending) return;
    this.current = this.committed;
    this.pending = undefined;
  }
}

/**
 * Refuses values JSON would silently change (undefined, NaN, Infinity, Dates,
 * Maps, class instances), because replay would then differ from live state.
 */
function checkJson(value: unknown, type: string, path = "payload"): void {
  const bad = (what: string) => {
    throw new Error(`event '${type}' can't be recorded: ${path} is ${what}, which wouldn't survive saving. Use plain text, numbers, true/false, lists or objects`);
  };
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : bad(String(value));
  if (Array.isArray(value)) return value.forEach((v, i) => checkJson(v, type, `${path}[${i}]`));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) bad(`a ${proto?.constructor?.name ?? "special object"}`);
    for (const [k, v] of Object.entries(value)) checkJson(v, type, `${path}.${k}`);
    return;
  }
  bad(value === undefined ? "missing (undefined)" : `a ${typeof value}`);
}

export function readRun(log: EventSink, runId: string): EngineEvent[] {
  return log.read(runId).map((r) => parseEvent(r.type, r.payload));
}
