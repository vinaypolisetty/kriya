# @kriya/store

Where runs live on disk: an append-only event log and the Library's facet history in SQLite, and media as content-addressed files. It knows nothing about what the events mean; the engine owns that.

Depends on `better-sqlite3`.

## Files

| File | What it is |
|---|---|
| [`index.ts`](src/index.ts) | `openStore(dir)` → `{ db, events, blobs, library, close }` |
| [`events.ts`](src/events.ts) | `SqliteEventLog`: append, read, atomic batches. Triggers refuse UPDATE and DELETE. Migrations by `user_version` (D-40) |
| [`blobs.ts`](src/blobs.ts) | `FsBlobStore` (files under `blobs/ab/cd/<sha256>`, write-once) and `MemoryBlobStore` for tests |
| [`library.ts`](src/library.ts) | `SqliteFacetHistory`: every version of every facet seen, numbered v1, v2… |

## Use

```ts
import { openStore, openDatabase, SqliteEventLog } from "@kriya/store";

const store = openStore(".kriya");               // kriya.db + blobs/
const { hash } = store.blobs.put(bytes);         // the same bytes always get the same hash
store.events.append("run-1", "NodeReady", { node: "draw" });
store.close();

const log = new SqliteEventLog(openDatabase(":memory:"));   // in tests
```

## Rules for changing it

- Events are never updated or deleted. A correction is a new event.
- A schema change is a new numbered migration in `events.ts`; never edit an old one.
- Blobs are write-once: a hash always means the same bytes.

## Tests

`pnpm --filter @kriya/store test`: `events.test.ts` (append-only, ordering, migrations), `blobs.test.ts`, `library.test.ts`.
