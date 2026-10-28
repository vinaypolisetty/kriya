# @kriya/engine

The recipe format and the deterministic core: a run is a list of events, its state is a fold over them, and the scheduler decides what runs next from that state alone. Everything non-deterministic (models, tools, people) happens outside, behind interfaces this package defines, and comes back as an event.

Depends on `zod` and `yaml` only. Imports no other `@kriya` package.

## Files

| File | What it is |
|---|---|
| [`spec.ts`](src/spec.ts) | The recipe format as Zod schemas: `Graph`, `Node` (by `kind`), `Edge`, field types (`TypeRef`, `library.<kind>`) |
| [`load.ts`](src/load.ts) | YAML → graphs, with problems at `file:line:col`. The only file here that reads the disk |
| [`validate.ts`](src/validate.ts) | Checks the schema can't do: references, loops without limits, unreachable steps, buttons edges rely on. Also `suggest()` for "did you mean" |
| [`condition.ts`](src/condition.ts) | The edge condition language: tokenizer, parser, evaluator. No calls, no clock |
| [`events.ts`](src/events.ts) | Every event type as a strict schema. Payloads are recorded data only |
| [`state.ts`](src/state.ts) | `apply(state, event)`: pure, refuses impossible events. `replay(events)` |
| [`recorder.ts`](src/recorder.ts) | The only writer: check + apply, then append; transactions; refuses values JSON would change |
| [`scheduler.ts`](src/scheduler.ts) | Which step runs next; edges, loops, joins, for-each items; locks, stale, branches, retry, keep; the `Executors` interface |
| [`cli-validate.ts`](src/cli-validate.ts) | `pnpm validate:examples` |

## Public API, in brief

```ts
import { loadDir, validateBundle, Recorder, Scheduler, replay, readRun } from "@kriya/engine";

const { graphs, problems } = loadDir("recipes");           // problems: errors and warnings with file:line
const rec = Recorder.start(eventLog, "run-1");             // or Recorder.resume(eventLog, "run-1")
const s = new Scheduler(graph, rec, executors, graphs, { assets, tools, blobs });
s.start(release, inputs, context);
s.run();                                                    // runs until it waits on a job or a person
s.deliver(ticket, outputs, meta);                           // a provider call finished
s.answer("per_shot[P3-04].pick", { action: "lock", selection: ["1.2"] });
s.inbox();                                                  // what's waiting on a person
replay(readRun(eventLog, "run-1"));                         // equals rec.state, always
```

What the scheduler can do to a run: `run`, `recover`, `inbox`, `answer`, `lock`, `writeVersion`, `rebuild`, `retry`, `keep`, `branch`, `switchBranch`, `adopt`, `replayChange`, `updateContext`, `override`, `mention`, `removeDefault`, `assetsChanged`, `unblock`. Jobs come back through `deliver`, `deliverTool`, `deliverTurn`, `deliverVerdicts` and `failJob`.

What it asks of the outside world:

| Interface | Implemented by | For |
|---|---|---|
| `Executors` (`produce`, `decide`, `check?`, `turn?`) | `adapters` (Claude, Replicate, tools), `cli/fake.ts`, test fakes | model, tool and agent steps; screens; judges |
| `Tools` | `cli/fake.ts` (real agent tools aren't built yet); `adapters/anthropic.ts` describes them to Claude | an agent's tools |
| `Blobs` | `cli` (`.kriya/blobs/`) | tool results by content hash |
| `Assets` | `cli/library.ts` | Library facets and their versions |
| `EventSink` | `store`'s `SqliteEventLog` | appending and reading events |

## Rules for changing it

- The run core (`events`, `state`, `recorder`, `scheduler`, `condition`, `spec`, `validate`) imports only its own files, `zod` and `node:crypto`. No clock, no randomness, no I/O. `pnpm check:conventions` enforces this.
- A new event needs: a strict schema in `events.ts`, handling in `apply` (refusing it when impossible), and a replay test.
- Write events between two outside calls inside `atomic`; outside calls go through `external`.

## Tests

`pnpm --filter @kriya/engine test`. Fakes are written in each test; SQLite runs in memory; recipes are the real ones in `examples/`. Highlights: `replay.test.ts` (live = replay at every event), `durable.test.ts` (crash at every write), `stale.test.ts` (per-input hashes, keep, joins), `validate.test.ts` (a failing recipe for every rule).
