# Architecture: how the code fits together

For engineers reading or changing kriya's code. The numbered docs (01–19) are the *design*: what kriya should be, and why. This page is the *code as built*: which package does what, how a run moves through them, and where to make a change. When the two disagree, the code and the [decision log](17-decisions.md) win; fix whichever doc is behind.

Read [02-concepts](02-concepts.md) first if words like *lock*, *stale* or *candidate* are new. The [glossary](19-glossary.md) has the rest.

## The packages

```
                ┌──────────────┐      ┌──────────────┐
  browser  ───▶ │  @kriya/web  │ HTTP │  @kriya/cli  │ ◀─── terminal (bin/kriya)
                │ React, Vite  │ ───▶ │ commands,    │
                └──────────────┘      │ kriya web,   │
                                      │ project, lib │
                                      └──┬────┬───┬──┘
                         ┌───────────────┘    │   └───────────────┐
                         ▼                    ▼                   ▼
                ┌────────────────┐   ┌────────────────┐   ┌──────────────┐
                │ @kriya/adapters│──▶│  @kriya/engine │   │ @kriya/store │
                │ Claude,        │   │ spec, validate,│   │ SQLite log,  │
                │ Replicate,     │   │ events, state, │   │ blobs,       │
                │ ffmpeg tools,  │   │ recorder,      │   │ Library      │
                │ jobs, fixes    │   │ scheduler      │   │ history      │
                └────────────────┘   └────────────────┘   └──────────────┘
```

| Package | Job | Depends on | Talks to the outside world? |
|---|---|---|---|
| [`engine`](../packages/engine/README.md) | The recipe format, validation, and the deterministic core: events → state → which step runs next | `zod`, `yaml` | Only to read recipe files (`load.ts`). The run core does no I/O, no clock, no network |
| [`store`](../packages/store/README.md) | Where runs live: the append-only event log and Library history in SQLite, media as content-addressed files | `better-sqlite3` | Disk only |
| [`adapters`](../packages/adapters/README.md) | Turns engine requests into real work: Claude, Replicate, Polygon, local ffmpeg tools; the job queue; the fix policy | `engine`, `@anthropic-ai/sdk` | Yes: providers and ffmpeg |
| [`cli`](../packages/cli/README.md) | A project on disk (`kriya.yaml`, `recipes/`, `library/`), the commands, and the `kriya web` HTTP server | all of the above | Disk, providers (through adapters), HTTP |
| [`web`](../packages/web/README.md) | The browser app: run graph, step panel, inbox, review screen, Library | `react` | Only `kriya web`'s API |

The dependency arrows only point one way. **`engine` imports nothing from the other packages**, and its run core (`events`, `state`, `recorder`, `scheduler`, `condition`, `spec`, `validate`) imports nothing from Node but `node:crypto` for hashing. That one rule is what keeps rule 1 of the design ("the engine is deterministic; models are not") checkable: anything that could be non-deterministic lives outside it, behind an interface the engine defines.

## The core idea in code

```
            decides                 records                 folds
 Scheduler ─────────▶ Recorder.record(event) ─────▶ apply(state, event) ─────▶ RunState
     ▲                       │                                                  │
     │                       └──▶ EventSink.append  (SQLite, in a transaction)  │
     └────────────────────────────── reads ─────────────────────────────────────┘
```

- **[`events.ts`](../packages/engine/src/events.ts)**: every engine action is one of a closed set of event types, each a strict Zod schema. Payloads are plain recorded data: outputs, decisions, verdicts, costs. Never a clock or a live object.
- **[`state.ts`](../packages/engine/src/state.ts)**: `apply(state, event)` is a pure function, and run state is `events.reduce(apply, empty)`. `apply` also *refuses* events that can't happen (locking a version that doesn't exist), so a damaged log fails loudly.
- **[`recorder.ts`](../packages/engine/src/recorder.ts)**: the only way to write. `record()` applies the event first and appends it second, so live state always equals replayed state. `begin` / `commit` / `rollback` group events into one SQLite transaction.
- **[`scheduler.ts`](../packages/engine/src/scheduler.ts)**: reads the graph and the recorded state, and decides what happens next. It reaches outside only through the `Executors`, `Tools`, `Blobs` and `Assets` interfaces it defines.

Because state is a fold, three things come for free: crash recovery (replay the log), audit ("why is this locked?" is in the log), and tests that compare live state with replay after every event (`replay.test.ts`, `durable.test.ts`).

## The life of a run

What happens on `kriya run part_recipe`, then `kriya decide 1 lock`, then a crash, then the next command:

1. **Load the project.** [`cli/project.ts`](../packages/cli/src/project.ts) reads `kriya.yaml`, then `recipes/*.yaml` through [`engine/load.ts`](../packages/engine/src/load.ts), which runs the schema and [`validate.ts`](../packages/engine/src/validate.ts) and reports problems with file:line. [`cli/library.ts`](../packages/cli/src/library.ts) reads `library/`. A recipe with errors never starts.
2. **Open the store.** `openStore(".kriya")` gives the event log, the blob store and the Library history.
3. **Wire the executors.** `executors()` in [`commands.ts`](../packages/cli/src/commands.ts) picks a real adapter per step (Claude for `llm.*` and agents, Replicate for images, clips, voice and music, Polygon for `polygon.financials`, ffmpeg for tools) and falls back to [`fake.ts`](../packages/cli/src/fake.ts) for anything left as `fake` in `kriya.yaml`.
4. **Start.** `Scheduler.start()` records `RunStarted` and makes the first steps ready.
5. **Run.** `Scheduler.run()` loops: pick the first ready step (in a fixed order), run it, follow the edges whose conditions hold, repeat. Each step's events go in one transaction (`atomic`).
6. **Call out.** A model step calls `Executors.produce(node, ctx)`. A real adapter starts the provider call in [`Jobs`](../packages/adapters/src/jobs.ts) and returns `{ ticket }` at once; the step is `Suspended`. Before any outside call, the scheduler **commits** everything so far (`external`), so a crash can only fall between calls, never inside a step (D-46).
7. **Settle.** [`settle()`](../packages/adapters/src/jobs.ts) awaits each job and delivers it: `deliver` (outputs), `deliverTurn` (an agent turn), `deliverVerdicts` (a judge), or `failJob` (a plain reason). Then `run()` again.
8. **Wait for a person.** A `screen` step asks `Executors.decide()`. With no answer yet, the step suspends and shows up in `inbox()`. The process exits; nothing is lost.
9. **Answer.** `kriya decide` (or `POST /api/decide`) replays the run, records the `HumanDecision` **first** (D-66), then recovers and carries on.
10. **Crash and resume.** Every command calls `openRun()`. It replays the log (`Recorder.resume`), re-checks the Library (`assetsChanged`, `unblock`), and calls `recover()`, which repeats only the outside calls that were in flight, **with the same idempotency key** (`run/step#attempt`). Replicate predictions are also in a job ledger, so a repeated call polls the same prediction instead of paying again.

## Where state lives

| What | Where | Written by | Source of truth for |
|---|---|---|---|
| Recipes | `recipes/*.yaml` in a project | the creator | the workflow definition (D-33) |
| Library | `library/*.yaml` + files they name | the creator | each entity's current facets |
| Events | `.kriya/kriya.db`, table `events` | `Recorder` only | everything that happened in a run |
| Library history | `.kriya/kriya.db`, table `facet_versions` | `cli/library.ts` | old facet versions (v1, v2…) |
| Media | `.kriya/blobs/ab/cd/<sha256>` | adapters, tools | bytes, named by hash, write-once |
| Replicate job ledger | `.kriya/jobs/` | `replicate.ts` | which predictions a step already started |
| Pairing token | `.kriya/web-token` | `cli/web.ts` | which phones may use `kriya web --lan` |

Run state itself is never stored: it's recomputed from events every time a command or request opens a run.

## Determinism: where the line is

| Inside the engine (deterministic) | Outside, recorded as an event the first time |
|---|---|
| Which step is ready, in what order | Model outputs (`CandidateProduced`) |
| Edge conditions ([`condition.ts`](../packages/engine/src/condition.ts): no calls, no clock) | Judge verdicts (`VerdictRecorded`) |
| Loop limits, budgets, joins | Agent turns and tool results (`AgentTurn`, `ToolResult`) |
| Stale tracking (per-input hashes, D-45) | Human answers (`HumanDecision`) |
| The fix policy's choice ([`fixes.ts`](../packages/adapters/src/fixes.ts) is pure) | Library facet versions (hashes, on each version) |

If you need the engine to "decide" something that takes judgement, add a step that *records* a verdict, and let a condition read it (design rule 2).

## Making common changes

Each recipe below lists the files to touch, in order. Every change also needs a test that fails without it.

**A new event type.** Add the schema in `engine/src/events.ts` (strict, recorded data only) → handle it in `state.ts`'s `apply`, refusing it when it can't happen → record it from `scheduler.ts` inside `atomic` → add a replay test (live state equals `replay(events)`).

**A new recipe field or node option.** `engine/src/spec.ts` (Zod, `.strict()`) → `validate.ts` if it can be wrong in ways the schema can't see (with a failing-example test in `validate.test.ts`) → the scheduler → [04-graph-spec](04-graph-spec.md) → the examples, if they should use it. If it changes what a step's output depends on, check that `inputsOf()` hashes it, so stale tracking sees it.

**A new provider or capability.** A new file in `adapters/src/` exporting `xxxExecutors(opts)` that returns `produce` (and a `handles(node)` predicate). Start calls through `Jobs` with `ctx.idempotencyKey`. Record the exact model version and cost in the call's `CallMeta` (rule 6). Download media into the blob store (provider URLs expire). Then wire it in `executors()` in `cli/src/commands.ts`, add its settings to `kriya.yaml`'s schema in `project.ts`, and test it with `fetch` mocked (see `replicate.test.ts`).

**A new local tool.** Add it to `MEDIA_TOOLS` in `adapters/src/tools.ts`. Long work runs as a job and writes into the blob store. Python workers go in `adapters/workers/` and print one JSON line.

**A new CLI command.** A function in `cli/src/commands.ts` that opens the project and store, does one thing, and closes the store in `finally`. Add it to `main()`'s switch, `HELP`, and [docs/cli.md](cli.md). Throw `UserError` for anything the creator did wrong, in plain words with the fix. Test it through `main()` in `commands.test.ts`.

**A new web endpoint or page.** The endpoint goes in `cli/src/web.ts`: add it to the header's route list, and send every write through `queue` (two schedulers on one run would disagree). Reads must never call a model or record anything. The page goes in `packages/web/src/`, with types and calls in `api.ts`. Live data uses `useLive(path)`, which refetches on the server's `changed` event. Server tests go in `cli/test/web.test.ts`.

**A new validator rule.** In `engine/src/validate.ts`, as an error or a warning with a plain message that names the fix. Add a test in `validate.test.ts` with a recipe that breaks the rule.

## Testing

- **Where:** `packages/<pkg>/test/*.test.ts`, run by vitest (`pnpm test`).
- **Fakes, not mocks:** the engine is tested with small fake `Executors` written in each test (see `stale.test.ts`), real SQLite in memory (`openDatabase(":memory:")`), and the real example recipes (`loadDir("examples")`).
- **Replay equality:** any test that records events should end with `expect(replay(events())).toEqual(rec.state)`.
- **Crash safety:** `durable.test.ts` crashes a whole Part at every write and checks nothing is lost or paid twice.
- **Providers:** `fetch` is stubbed. Nothing in `pnpm test` spends money or needs a key. Tests that need ffmpeg, Pillow or a font skip themselves when those are missing (CI installs them).
- **Prove the test:** before committing, break the code you fixed and watch the new test fail. A test that passes either way is noise.

## Conventions are checked

`pnpm check:conventions` ([scripts/check-conventions.ts](../scripts/check-conventions.ts)) fails CI when:
- a source file has no header comment;
- a package has no README;
- code or docs cite a decision (`D-nn`) that isn't in the decision log;
- a CLI command isn't in [cli.md](cli.md);
- a web API route isn't listed in `web.ts`'s header.

The rest of the conventions are in [CONTRIBUTING.md](../CONTRIBUTING.md).
