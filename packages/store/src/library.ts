/**
 * Library history: every version of every facet kriya has seen, in the order
 * it first saw them (v1, v2, …). The Library files are the source of truth for
 * the current version; this keeps the old ones, with their files in the blob
 * store, so redrawing a sheet in place loses nothing.
 */
import type Database from "better-sqlite3";

export type FacetVersion = { n: number; version: string; value: unknown; at: string };

export interface FacetHistory {
  /** Keeps a version if it's new; returns its number for this facet (1 for the first). */
  record(entity: string, facet: string, version: string, value: unknown): number;
  /** Every version of one facet, oldest first. */
  history(entity: string, facet: string): FacetVersion[];
}

export class SqliteFacetHistory implements FacetHistory {
  private readonly insert: Database.Statement;
  private readonly select: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.insert = db.prepare("INSERT OR IGNORE INTO facet_versions (entity, facet, version, value, at) VALUES (?, ?, ?, ?, ?)");
    this.select = db.prepare("SELECT version, value, at FROM facet_versions WHERE entity = ? AND facet = ? ORDER BY n");
  }

  record(entity: string, facet: string, version: string, value: unknown): number {
    this.insert.run(entity, facet, version, JSON.stringify(value ?? null), this.now());
    return this.history(entity, facet).findIndex((v) => v.version === version) + 1;
  }

  history(entity: string, facet: string): FacetVersion[] {
    return (this.select.all(entity, facet) as { version: string; value: string; at: string }[]).map((r, i) => ({ n: i + 1, version: r.version, value: JSON.parse(r.value), at: r.at }));
  }
}
