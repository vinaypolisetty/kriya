import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type Database from "better-sqlite3";
import { FsBlobStore, type BlobStore } from "./blobs.js";
import { openDatabase, SqliteEventLog, type EventLog } from "./events.js";

export * from "./blobs.js";
export * from "./events.js";

export type Store = {
  db: Database.Database;
  events: EventLog;
  blobs: BlobStore;
  close(): void;
};

/**
 * Opens the local store in `dir` (by convention `.kriya/` at the project root):
 *   dir/kriya.db   events and projection tables
 *   dir/blobs/     media, named by sha256
 */
export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, "kriya.db"));
  return {
    db,
    events: new SqliteEventLog(db),
    blobs: new FsBlobStore(join(dir, "blobs")),
    close: () => db.close(),
  };
}
