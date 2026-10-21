import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore, MemoryBlobStore, hashBytes, type BlobStore } from "../src/blobs.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "kriya-blobs-"));
const bytes = (s: string) => new TextEncoder().encode(s);

const stores: [string, () => BlobStore][] = [
  ["FsBlobStore", () => new FsBlobStore(tempDir())],
  ["MemoryBlobStore", () => new MemoryBlobStore()],
];

describe.each(stores)("%s", (_name, make) => {
  it("writes a blob and reads it back by its hash", () => {
    const store = make();
    const { hash, size } = store.put(bytes("panel P3-04"));
    expect(hash).toBe(hashBytes(bytes("panel P3-04")));
    expect(size).toBe(11);
    expect(store.get(hash)?.toString()).toBe("panel P3-04");
    expect(store.has(hash)).toBe(true);
  });

  it("gives the same hash for the same content", () => {
    const store = make();
    expect(store.put(bytes("same")).hash).toBe(store.put(bytes("same")).hash);
  });

  it("returns nothing for an unknown hash", () => {
    const store = make();
    const missing = "0".repeat(64);
    expect(store.get(missing)).toBeUndefined();
    expect(store.has(missing)).toBe(false);
  });

  it("rejects things that aren't hashes, so paths can't escape the store", () => {
    const store = make();
    expect(() => store.get("../../etc/passwd")).toThrow(/isn't a blob hash/);
    expect(() => store.has("ABC")).toThrow(/isn't a blob hash/);
  });
});

describe("FsBlobStore on disk", () => {
  it("stores one file per content, fanned out by hash prefix", () => {
    const dir = tempDir();
    const store = new FsBlobStore(dir);
    const { hash } = store.put(bytes("clip"));
    store.put(bytes("clip"));
    const folder = join(dir, hash.slice(0, 2), hash.slice(2, 4));
    expect(readdirSync(folder)).toEqual([hash]);
  });

  it("survives reopening", () => {
    const dir = tempDir();
    const { hash } = new FsBlobStore(dir).put(bytes("voice line"));
    expect(new FsBlobStore(dir).get(hash)?.toString()).toBe("voice line");
  });
});
