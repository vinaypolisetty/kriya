/**
 * Content-addressed blob store: images, clips, audio, Reels.
 *
 * A blob's name is the sha256 of its bytes, so the same content is stored once
 * and a hash always means the same bytes. Blobs are write-once.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BlobRef = { hash: string; size: number };

export interface BlobStore {
  put(bytes: Uint8Array): BlobRef;
  get(hash: string): Buffer | undefined;
  has(hash: string): boolean;
}

const HASH = /^[0-9a-f]{64}$/;

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkHash(hash: string): void {
  if (!HASH.test(hash)) {
    throw new Error(`'${hash}' isn't a blob hash: expected 64 lowercase hex characters (a sha256)`);
  }
}

/** Blobs as files under `dir`, fanned out by hash prefix: dir/3f/a9/3fa9c1… */
export class FsBlobStore implements BlobStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  put(bytes: Uint8Array): BlobRef {
    const hash = hashBytes(bytes);
    const path = this.pathOf(hash);
    if (!existsSync(path)) {
      const folder = join(this.dir, hash.slice(0, 2), hash.slice(2, 4));
      mkdirSync(folder, { recursive: true });
      // Write to a temp file, then rename: a crash never leaves a half-written blob under its hash.
      const tmp = join(folder, `.${hash}.${randomBytes(4).toString("hex")}.tmp`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    return { hash, size: bytes.byteLength };
  }

  get(hash: string): Buffer | undefined {
    checkHash(hash);
    const path = this.pathOf(hash);
    return existsSync(path) ? readFileSync(path) : undefined;
  }

  has(hash: string): boolean {
    checkHash(hash);
    return existsSync(this.pathOf(hash));
  }

  private pathOf(hash: string): string {
    return join(this.dir, hash.slice(0, 2), hash.slice(2, 4), hash);
  }
}

/** In-memory blobs for tests. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  put(bytes: Uint8Array): BlobRef {
    const hash = hashBytes(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, Buffer.from(bytes));
    return { hash, size: bytes.byteLength };
  }

  get(hash: string): Buffer | undefined {
    checkHash(hash);
    const b = this.blobs.get(hash);
    return b && Buffer.from(b);
  }

  has(hash: string): boolean {
    checkHash(hash);
    return this.blobs.has(hash);
  }
}
