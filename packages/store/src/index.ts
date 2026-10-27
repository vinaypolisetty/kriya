import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type Database from "better-sqlite3";
import { FsBlobStore, type BlobStore } from "./blobs.js";
import { openDatabase, SqliteEventLog, type EventLog } from "./events.js";
import { SqliteFacetHistory, type FacetHistory } from "./library.js";

export * from "./blobs.js";
export * from "./events.js";
export * from "./library.js";

export type Store = {
  db: Database.Database;
  events: EventLog;
  blobs: BlobStore;
  library: FacetHistory;
  close(): void;
};

/**
 * Opens the local store in `dir` (by convention `.kriya/` at the project root):
 *   dir/kriya.db   events, Library history and projection tables
 *   dir/blobs/     media, named by sha256
 */
export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, "kriya.db"));
  return {
    db,
    events: new SqliteEventLog(db),
    blobs: new FsBlobStore(join(dir, "blobs")),
    library: new SqliteFacetHistory(db),
    close: () => db.close(),
  };
}
