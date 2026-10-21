import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteEventLog } from "../src/events.js";
import { openStore } from "../src/index.js";

const memoryLog = () => {
  const db = openDatabase(":memory:");
  let tick = 0;
  return { db, log: new SqliteEventLog(db, () => `2026-10-20T00:00:0${tick++}Z`) };
};

describe("event log", () => {
  it("appends with increasing sequence numbers and reads a run in order", () => {
    const { log } = memoryLog();
    const a = log.append("run1", "RunStarted", { release: "abc" });
    const b = log.append("run2", "RunStarted", {});
    const c = log.append("run1", "NodeReady", { node: "shot_list" });
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(log.read("run1").map((e) => e.type)).toEqual(["RunStarted", "NodeReady"]);
  });

  it("keeps payloads and timestamps exactly", () => {
    const { log } = memoryLog();
    const payload = { node: "draw", options: 3, tags: ["P3-04"], nested: { ok: true } };
    log.append("run1", "CandidateProduced", payload);
    const [e] = log.read("run1");
    expect(e).toEqual({ seq: 1, runId: "run1", type: "CandidateProduced", payload, at: "2026-10-20T00:00:00Z" });
  });

  it("reads only events after a given sequence number", () => {
    const { log } = memoryLog();
    const first = log.append("run1", "A", {});
    log.append("run1", "B", {});
    expect(log.read("run1", first).map((e) => e.type)).toEqual(["B"]);
  });

  it("refuses to change or delete events", () => {
    const { db, log } = memoryLog();
    log.append("run1", "Locked", { version: 2 });
    expect(() => db.prepare("UPDATE events SET type = 'Unlocked'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
  });

  it("refuses payloads that aren't JSON", () => {
    const { log } = memoryLog();
    expect(() => log.append("run1", "Bad", undefined)).toThrow(/can't be saved as JSON/);
  });

  it("refuses a database from a newer kriya", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kriya-db-")), "kriya.db");
    const newer = openDatabase(path);
    newer.pragma("user_version = 99");
    newer.close();
    expect(() => openDatabase(path)).toThrow(/newer kriya/);
  });
});

describe("openStore", () => {
  it("creates the folder and keeps events and blobs across reopening", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kriya-store-")), ".kriya");
    const s1 = openStore(dir);
    const { hash } = s1.blobs.put(new TextEncoder().encode("reel"));
    s1.events.append("run1", "NodeCompleted", { blob: hash });
    s1.close();

    const s2 = openStore(dir);
    const [e] = s2.events.read("run1");
    expect(e?.payload).toEqual({ blob: hash });
    expect(s2.blobs.get(hash)?.toString()).toBe("reel");
    s2.close();
  });
});
