# Week 1 notes · Engine foundations (Oct 13–20, 2026)

**Finish line: "Part graph runs end to end with fakes." Met on Oct 20.** Days 1–7 are done, and the plan is back on schedule (Day 8 starts Oct 20, as planned).

## What shipped

| Day | Built | PR |
|---|---|---|
| 1–3 | Monorepo, CI, graph spec (Zod), condition language, validator, Mohalla Mitra recipes | scaffold |
| — | Design decisions D-26 to D-39; agent `max_turns` + `budget` | #1 |
| 4 | `@kriya/store`: content-addressed blob store, append-only event log on SQLite | #2 |
| 5 | Typed engine events, `apply` / `replay`, `Recorder` | #3 |
| 6 | Scheduler: conditions on edges, `max_loops`, joins | #4 |
| 7 | `map` steps with stable keys; the full Part runs | #5 |

Numbers at the end of the week: 76 tests (59 engine, 17 store), ~1,600 lines of source across two packages, one runtime dependency added (`better-sqlite3`), CI green on every PR.

## What the engine can do now

- Load a recipe folder and reject broken recipes with file:line:col and a "did you mean".
- Run a whole Part with fake executors: shot list → approve → each shot (draw, pick, retry, edit, animate) and each voice line → assemble once → watch → done.
- Give every step instance a stable key (`per_shot[P3-04].draw`); each shot has its own loop limits.
- Record everything as events, and rebuild exactly the same state from the log **at every event**. A run resumed after a crash at any of 31 points finishes identical to one that never crashed.
- Refuse events that can't happen (locking a missing version, a tool result with no call) before they reach the log.

## Decisions this week

D-26 to D-41. The ones that shape the code most:

- **D-26** The engine owns the agent loop, one turn per call.
- **D-28** Auto mode doesn't ask before changing a lock; changes stay recorded and revertible.
- **D-33** Recipe files are the source of truth; releases are hashed snapshots.
- **D-34** Stream by default, barriers opt-in.
- **D-39** Agent memory is an engine-owned context ladder.
- **D-40** Plain SQL via `better-sqlite3`, not Drizzle.
- **D-41** A map's output is one list per child output, in source-list order, `null` where an item made nothing.

## What went well

- **Breaking the code on purpose.** Each guarantee (replay is pure, loops are capped, joins wait, each item counts its own loops) was checked by planting the bug and watching a test fail. It caught one weak test: the first join test passed even with the join's wait removed, because the join step happened to be declared last. Keep doing this.
- **Deriving instead of remembering.** The first scheduler draft kept visit counts and "reached the end" in memory, which would have broken resume. Reading them from recorded state instead made resume safety structural, not something to test for later.
- **Deciding the spec question before writing the code.** Settling D-41 first made Day 7 straightforward.

## What didn't

- **The schedule slipped 4 days, then recovered.** A long design session (Oct 15–16) plus a break used up the 2-day lead and 4 more days. Days 4–7 were then done in one day by keeping Day 4 small (events + blobs only, other tables when needed).
- **Design questions pile up in chat.** Several items raised on Oct 15 were never logged anywhere (below). Log them as they come up.

## Known gaps carried into Week 2

| Gap | Where it gets fixed |
|---|---|
| A screen's `selected` is version ids, not the picked output (so `voice_recipe`'s `audio` is ids) | Day 8, locks |
| The first candidate locks automatically; `trust` isn't applied | Day 8 |
| Humans answer instantly; no real tickets or waiting | Day 11 |
| Re-running a map (after a shot-list redo) fails plainly instead of reusing unchanged items | Day 10, stale tracking |
| `subgraph` steps don't run | When a recipe needs one |
| Map-to-map links by item key (D-34 streaming between maps) | When a recipe needs one |
| Validator: refs in `uses`, `show`, `beside`, `{{prompt}}` aren't checked; built-in scopes hardcoded to Mohalla Mitra's levels; misspelled field names give raw Zod errors | Not scheduled yet; should be soon |
| Unlogged spec ideas: tool `args` references, agent `instructions:`, `prompt_file:`, map `graph: {by, cases}`, checker `rubric:` | Log as open questions |

## Week 2 focus (Oct 20–26)

Versions, locks and durable waits: version tree and lock policy (Day 8), branches with `replay_change` first (Day 9), cache keys and stale (Day 10), tickets and crash-and-resume with no duplicate calls (Day 11), context and assets (Day 12), the CLI (Day 13). Day 14 is the buffer and the write-up.

The riskiest piece is Day 10: stale tracking is listed in the roadmap as one of the hardest parts. Give it full attention.

## Story material for later

- *Determinism with non-deterministic models*: the event log, replay at every prefix, and the crash-at-every-event test.
- *Tests that can fail*: planting bugs found a test that couldn't fail.
- *Recovering a slipped plan without dropping the finish line*: shrink scope (Day 4), not the goal.
