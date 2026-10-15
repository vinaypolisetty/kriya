# 03 · Engine

The engine runs graphs durably. It is deliberately small: an event log, a scheduler, a suspension manager, a context store and the step kinds. Checkers, fix loops and for-each are built from those.

## Components

```
┌──────────────────────────────────────────────────────────────┐
│ Authoring (YAML · builder · assistant) → graph definitions    │
└───────────────┬──────────────────────────────────────────────┘
                ▼  release (immutable, hashed)
┌──────────────────────────────────────────────────────────────┐
│ ENGINE                                                        │
│  Event log ── Scheduler ── Suspension manager ── Context store│
│  Loop controller (generate → check → fix → escalate)          │
└──┬─────────────┬───────────────┬───────────────┬─────────────┘
   ▼             ▼               ▼               ▼
 Executors     Library        Knowledge base   Human inbox
 model/agent/  (assets,       (failure → fix)  (screens, decisions)
 tool/screen    facets)
   ▼
 Providers (capabilities): image.generate · image.edit · video.from_image
                           audio.speech · audio.music · llm.write · llm.vision
```

## 1. State is an event log

Every engine action is appended as an event. Current state is computed by replaying events.

| Event | Meaning |
|---|---|
| `RunStarted` | A run began, pinned to a release hash |
| `NodeReady` | All inputs available, conditions satisfied |
| `AttemptStarted` | A model/agent/tool call began |
| `CandidateProduced` | A version was created (with prompt, inputs, model version, seed, cost) |
| `VerdictRecorded` | A checker (code, LLM or human) judged a candidate |
| `FixChosen` | The loop controller or agent picked a fix |
| `Suspended` / `Resumed` | Waiting on a ticket (model job, human, timer) |
| `HumanDecision` | A screen was submitted: action, selection, note, region |
| `Locked` / `Unlocked` | A version became / stopped being the node's output |
| `BranchCreated` / `BranchSwitched` / `Adopted` | Version-tree operations |
| `MarkedStale` | Inputs changed under accepted work |
| `NodeCompleted` / `RunCompleted` / `NodeFailed` | Terminal states |

Why: resumability (replay after a crash), lineage for free (trace any frame back through every attempt), knowledge-base mining (which fixes worked), audit (why something was accepted, including waivers).

Storage: an append-only `events` table (SQLite for v0.1, Postgres later) plus projection tables for fast reads.

## 2. Two graphs: declared and discovered

- The **definition graph** is static, from the recipe.
- The **run graph** is dynamic: a `map` node **materializes** its children only when its source output is locked (you can't know there are 13 shots until the shot list exists).

Rules:
- **Stable task keys** come from item identity (`per_shot[P3-04].draw`), not position. If the shot list is regenerated and P3-04 is unchanged, its accepted work survives.
- **Item-level edges**: `clips[P3-01]` depends on `images[P3-01]` only, so clips start while other panels are still in their fix loops.
- **Barriers** (`wait: all`) when a stage must finish first, optionally with a human sign-off on the whole set.

## 3. Node instance lifecycle

```
            ┌──────── InputsChanged ────────┐
            ▼                               │
PENDING → READY → RUNNING → CHECKING → LOCKED ┘ (→ STALE)
   │                 ▲          │
   │                 │          ├─→ FIXING ──┘ (next attempt)
BLOCKED              │          ├─→ AWAITING_HUMAN ─→ (lock / reject / waive)
(missing asset,      │          └─→ FAILED (budget or attempts exhausted)
 upstream not done)  │
                     └── WAITING_EXTERNAL (provider job, manual upload)
```

A node instance holds **attempts**; each attempt holds one or more **candidates**; each candidate gets **verdicts**. Keeping these separate lets an edit attempt point at "candidate 2 of attempt 1" as its parent.

`BLOCKED` examples: a required asset is missing (Inspector Tiwari has no look facet), or a key for the provider isn't configured.

## 4. Durable waits: the engine never blocks

Slow things become tickets:

1. The executor submits the job and returns a **ticket** (provider prediction id, inbox item id, manual-upload slot, timer).
2. The node parks in `WAITING_EXTERNAL` or `AWAITING_HUMAN`.
3. A webhook, poller or inbox action emits the completion event; the node wakes.

Human work and model work use the same mechanism. **Manual mode** (the creator runs a model themselves and uploads the result) is the same suspend/resume with a different ticket type.

## 5. The loop controller (generate → check → fix)

After each verdict a policy picks the next action:

```ts
function nextAction(task, verdict, history, kb): Action {
  if (verdict.passed) return Accept();
  if (task.budgetExhausted() || task.attempts >= task.maxAttempts) return Escalate("exhausted");

  for (const issue of verdict.issues) {
    const rule = kb.match(issue, { stage: task.stage, provider: task.provider });
    if (rule && !history.tried(rule.fix, issue)) return rule.fix.bind(issue, verdict.candidate);
  }
  return llmChooseFix(task, verdict, history, kb); // fallback: an agent reasons it out
}
```

Principles:
- **Knowledge-base rules first, model judgement second.**
- **Never repeat a fix that already failed** for the same issue; move up the ladder.
- **Fixes have a cost order:** crop (code, free) → edit (one call) → regenerate (N calls) → escalate (human time).
- **Waive** is a valid outcome, recorded with a reason (e.g. P2-11: gamcha missing, kept).

### Fix vocabulary

| Fix | What it does |
|---|---|
| `retry` | Same inputs, new seed |
| `regenerate_with_patch` | Prompt changed by a knowledge-base rule or a human note |
| `edit` | Local repair: "change only X" (context: local) |
| `transform` | Code fix: crop, trim, hold last good frame, speed up |
| `swap_provider` | Try a different model for the capability |
| `decompose` | E.g. crop the area first, then edit the crop |
| `escalate` | Hand to a human |
| `waive` | Accept with a known flaw, recorded |

### Checker ladder

Cheapest first, most trusted last: **code checks** (duration, size, schema) → **LLM judge** (rubric) → **human**. The engine tracks how often the LLM judge agrees with human verdicts; that number justifies raising a step's trust level.

### Verdict shape

```json
{ "pass": false,
  "issues": [
    { "type": "extra_character", "where": "right edge", "fix": "crop" },
    { "type": "missing_detail", "what": "Bheem's gamcha", "fix": "edit" } ] }
```

## 6. Caching and stale propagation

Every node instance has a **cache key**:

```
hash( node spec version
    + content hashes of resolved inputs (locked upstream versions)
    + asset facet versions referenced
    + prompt template version
    + model id and version
    + executor config )
```

- Same key → reuse the locked output, no spend.
- Key changes → the instance goes `STALE`; staleness propagates down item-level edges only.

Examples: redoing Part 1's music marks music and assembly stale, not the 13 panels. A new `@Bheem · look` version marks only shots with Bheem stale; the creator chooses to rebuild or pin the old version.

## 7. Scheduling and limits

- Ready queue with **worker pools per provider**, each with its own concurrency limit.
- **Reserve before spending:** estimate cost, reserve against the run budget, settle the actual cost. Runs stop cleanly at the cap.
- **Idempotency keys** derived from attempt id: after a crash the engine re-polls the existing provider job instead of paying twice.
- **Priority:** work closest to a human checkpoint first, so a complete review batch is ready sooner.

## 8. Plugin interfaces

Use cases implement small interfaces; the engine owns everything else.

```ts
interface Executor  { submit(ctx: TaskContext): Promise<Ticket | Candidate[]> }
interface Checker   { check(ctx: TaskContext, c: Candidate): Promise<Verdict> }
interface Fixer     { apply(ctx: TaskContext, issue: Issue, parent: Candidate): Promise<Ticket | Candidate[]> }
interface Selector  { pick(ctx: TaskContext, cs: Candidate[]): Promise<Candidate> } // best-of-N
```

`TaskContext` provides the resolved spec, assets matched by facet, knowledge-base prompt patches, attempt history and the parent candidate. Plugins never touch engine state directly, so the engine is testable with fake executors.

## 9. Agents are durable too

Every agent turn is an event:

```
agent:fix_P3-04  turn 1 → tool: vision_check(panel)          → verdict: gamcha missing
                 turn 2 → tool: image.edit(note="add gamcha") → suspended (provider job)
                 …resumes 40 s later…
                 turn 3 → tool: screen.ask_user(pick_panel)   → suspended (waiting for human)
                 …human answers next morning…
                 turn 4 → done: locked candidate 2
```

Agents survive crashes, wait as long as needed, replay turn by turn, and run under the same budgets and attempt limits as everything else.

## 10. Build vs buy

Temporal, Prefect and Hatchet do durable execution well, but the hard parts here (content-hash invalidation, version trees and locks, the fix loop, human verdicts as data, a learning knowledge base) don't come off the shelf. Plan: a small engine (target < 2k lines for the core) on SQLite/Postgres with a Postgres-backed job queue, keeping the executor interface clean enough to move onto Temporal later if scale demands it. ([Decision D-19](17-decisions.md))
