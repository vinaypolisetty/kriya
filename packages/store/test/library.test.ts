import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, SqliteFacetHistory } from "../src/index.js";

describe("Library history (Day 18)", () => {
  it("numbers each facet's versions in the order they were first seen, and keeps them", () => {
    let t = 0;
    const h = new SqliteFacetHistory(openDatabase(":memory:"), () => `2026-10-25T00:00:0${t++}Z`);
    expect(h.record("Mitra", "voice", "aaa", { voice: "Charon" })).toBe(1);
    expect(h.record("Mitra", "voice", "bbb", { voice: "Puck" })).toBe(2);
    expect(h.record("Mitra", "voice", "aaa", { voice: "Charon" })).toBe(1); // seen before: same number, not a new row
    expect(h.record("Mitra", "look", "ccc", "sheets/mitra.png")).toBe(1);
    expect(h.history("Mitra", "voice")).toEqual([
      { n: 1, version: "aaa", value: { voice: "Charon" }, at: "2026-10-25T00:00:00Z" },
      { n: 2, version: "bbb", value: { voice: "Puck" }, at: "2026-10-25T00:00:01Z" },
    ]);
    expect(h.history("Tiwari", "voice")).toEqual([]);
  });

  it("a database from before the Library gains the history table and keeps its events", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kriya-db-")), "kriya.db");
    const old = new Database(path);
    old.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL)");
    old.prepare("INSERT INTO events (run_id, type, payload, at) VALUES ('run1', 'RunStarted', '{}', 'then')").run();
    old.pragma("user_version = 1");
    old.close();

    const db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(new SqliteFacetHistory(db).record("Mitra", "look", "aaa", "x")).toBe(1);
    expect(db.prepare("SELECT count(*) AS c FROM events").get()).toEqual({ c: 1 });
  });
});
