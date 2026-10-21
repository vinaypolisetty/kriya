/**
 * The live side of the event log. Every engine action goes through `record`:
 * the event is checked and applied first, then appended, so an event that
 * can't happen never reaches the log, and live state always equals replay.
 */
import { EngineEvent, parseEvent } from "./events.js";
import { apply, replay, type RunState } from "./state.js";

/** What the engine needs from storage. `@kriya/store`'s SqliteEventLog fits this. */
export interface EventSink {
  append(runId: string, type: string, payload: unknown): number;
  read(runId: string, afterSeq?: number): { type: string; payload: unknown }[];
}

export class Recorder {
  private current: RunState | undefined;

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

  record(event: EngineEvent): RunState {
    const e = EngineEvent.parse(event);
    const { type, ...payload } = e;
    checkJson(payload, type);
    const next = apply(this.current, e);
    this.log.append(this.runId, type, payload);
    this.current = next;
    return next;
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
