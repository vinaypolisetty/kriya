/**
 * The append-only event log. Current state is rebuilt by replaying events
 * (docs/03-engine.md §1). Day 5 adds the typed event union; here a payload is
 * any JSON value.
 */
import Database from "better-sqlite3";

export type StoredEvent = {
  seq: number;
  runId: string;
  type: string;
  payload: unknown;
  at: string;
};

export interface EventLog {
  /** Appends one event and returns its sequence number (strictly increasing across the log). */
  append(runId: string, type: string, payload: unknown): number;
  /** A run's events in order, optionally only those after `afterSeq`. */
  read(runId: string, afterSeq?: number): StoredEvent[];
}

const SCHEMA_VERSION = 1;

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

  constructor(
    db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.insert = db.prepare("INSERT INTO events (run_id, type, payload, at) VALUES (?, ?, ?, ?)");
    this.select = db.prepare("SELECT seq, run_id, type, payload, at FROM events WHERE run_id = ? AND seq > ? ORDER BY seq");
  }

  append(runId: string, type: string, payload: unknown): number {
    const json = JSON.stringify(payload);
    if (json === undefined) throw new Error(`event '${type}' has a payload that can't be saved as JSON`);
    return Number(this.insert.run(runId, type, json, this.now()).lastInsertRowid);
  }

  read(runId: string, afterSeq = 0): StoredEvent[] {
    const rows = this.select.all(runId, afterSeq) as { seq: number; run_id: string; type: string; payload: string; at: string }[];
    return rows.map((r) => ({ seq: r.seq, runId: r.run_id, type: r.type, payload: JSON.parse(r.payload), at: r.at }));
  }
}
