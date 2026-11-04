/**
 * The append-only event log on SQLite (docs/03-engine.md §1). Current state is
 * rebuilt by replaying events. A trigger refuses UPDATE and DELETE, so history
 * can't be rewritten. The store treats a payload as any JSON value; the typed
 * events and their checks live in the engine (events.ts, recorder.ts). Schema
 * changes are numbered migrations tracked in `user_version` (D-40).
 */
import Database from "better-sqlite3";

export type StoredEvent = {
  seq: number;
  runId: string;
  type: string;
  payload: unknown;
  at: string;
};

/**
 * A write from a process whose view of a run is out of date: something else
 * (another terminal, `kriya web`) recorded on the run since this one read it
 * (G-6). Nothing was saved; reading the run again and redoing it is safe.
 */
export class BehindTheLog extends Error {
  constructor(readonly runId: string) {
    super(`run '${runId}' was changed somewhere else (another terminal or kriya web) while this was working on it, so nothing was saved. Do it again: kriya reads the run afresh`);
  }
}

export interface EventLog {
  /**
   * Appends one event and returns its sequence number (strictly increasing across the log).
   * With `after`, only if the run's last event is still that one (0: it has none yet);
   * otherwise it throws `BehindTheLog` and saves nothing.
   */
  append(runId: string, type: string, payload: unknown, after?: number): number;
  /** A run's events in order, optionally only those after `afterSeq`. */
  read(runId: string, afterSeq?: number): StoredEvent[];
  /** Appends several events atomically: all of them or none, with `after` as for `append`. Returns the last one's sequence number. */
  appendMany(runId: string, events: { type: string; payload: unknown }[], after?: number): number;
  /** Every run in the log, oldest first. */
  runs(): string[];
}

const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE events (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL,
      type    TEXT NOT NULL,
      payload TEXT NOT NULL,
      at      TEXT NOT NULL
    );
    CREATE INDEX events_by_run ON events (run_id, seq);
    CREATE TRIGGER events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only: they can''t be changed'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only: they can''t be deleted'); END;
  `,
  // Day 18: every Library facet version kriya has seen, so an old sheet or voice survives an edit.
  2: `
    CREATE TABLE facet_versions (
      n       INTEGER PRIMARY KEY AUTOINCREMENT,
      entity  TEXT NOT NULL,
      facet   TEXT NOT NULL,
      version TEXT NOT NULL,
      value   TEXT NOT NULL,
      at      TEXT NOT NULL,
      UNIQUE (entity, facet, version)
    );
  `,
};

/** Opens (or creates) a kriya database and brings its schema up to date. Use ":memory:" for tests. */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `this database was written by a newer kriya (schema ${current}, this version knows ${SCHEMA_VERSION}); update kriya to open it`,
    );
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v}`);
    })();
  }
  return db;
}

export class SqliteEventLog implements EventLog {
  private readonly insert: Database.Statement;
  private readonly select: Database.Statement;
  private readonly last: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.insert = db.prepare("INSERT INTO events (run_id, type, payload, at) VALUES (?, ?, ?, ?)");
    this.select = db.prepare("SELECT seq, run_id, type, payload, at FROM events WHERE run_id = ? AND seq > ? ORDER BY seq");
    this.last = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?");
  }

  append(runId: string, type: string, payload: unknown, after?: number): number {
    return this.appendMany(runId, [{ type, payload }], after);
  }

  appendMany(runId: string, events: { type: string; payload: unknown }[], after?: number): number {
    // IMMEDIATE takes the write lock before the check, so no other process can write between the two.
    return this.db.transaction(() => {
      if (after !== undefined && (this.last.get(runId) as { seq: number }).seq !== after) throw new BehindTheLog(runId);
      let seq = after ?? 0;
      for (const e of events) {
        const json = JSON.stringify(e.payload);
        if (json === undefined) throw new Error(`event '${e.type}' has a payload that can't be saved as JSON`);
        seq = Number(this.insert.run(runId, e.type, json, this.now()).lastInsertRowid);
      }
      return seq;
    }).immediate();
  }

  /** Every run in the log, oldest first. */
  runs(): string[] {
    return (this.db.prepare("SELECT run_id, MIN(seq) AS first FROM events GROUP BY run_id ORDER BY first").all() as { run_id: string }[]).map((r) => r.run_id);
  }

  read(runId: string, afterSeq = 0): StoredEvent[] {
    const rows = this.select.all(runId, afterSeq) as { seq: number; run_id: string; type: string; payload: string; at: string }[];
    return rows.map((r) => ({ seq: r.seq, runId: r.run_id, type: r.type, payload: JSON.parse(r.payload), at: r.at }));
  }
}
