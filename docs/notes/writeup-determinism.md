# Deterministic orchestration of non-deterministic models

*Draft, Day 14. For a blog post / LinkedIn article. About 1,000 words.*

---

Ask an image model for the same panel twice and you get two different panels. Ask an LLM judge whether the panel is good twice and you can get two different verdicts. Ask an agent to fix it and it may take a different path every time.

That's fine for one call. It's a disaster for a pipeline. I'm building kriya, an engine for creative pipelines with humans in the loop. It started with my Instagram motion-comic series, *Mohalla Mitra*: one Part is a shot list, 10–13 panels with three candidates each, edits, clips, 18 voice lines and an assembled Reel. A run takes hours of model time and days of my time, because I review it in between meetings.

So the run will crash, or I'll close my laptop, or a provider will time out. When it resumes, it must not redraw the 9 panels I already locked, pay for them again, or quietly pick a different fix for shot P3-04 because the judge changed its mind.

The rule that makes this work fits in one sentence:

> **The engine is deterministic; models are not. Every non-deterministic thing is recorded the first time and replayed after that, never asked again.**

## Where non-determinism comes from

It enters kriya at a small, fixed set of boundaries:

| Source | Example | Recorded as |
|---|---|---|
| Model outputs | Three drawings for P3-04 | `CandidateProduced` |
| Agent choices | The fix agent decides to crop, then edit | `AgentTurn` |
| LLM judge verdicts | "Bheem's gamcha is missing" | `VerdictRecorded` |
| Outside tools | A Replicate job's output | `ToolResult` (content hash) |
| People | I lock P3-11 from my phone | `HumanDecision` |
| Timing | Which shot finishes first | The order of events in the log |
| Cost and tokens | $0.04 for one drawing | Inside the events above |

Everything else is the engine's own logic, and that logic is a pure function of the log:

| Part | Why it's deterministic |
|---|---|
| Which step runs next | Reads recorded state only |
| Conditions on edges (`verdict.pass == false`) | A small language with no function calls, no clock, no model calls |
| Self-locking a confident step | Reads the recorded verdict, not a fresh one |
| Fix routing | Matches the recorded issue against knowledge-base rules |
| Budgets and loop limits | Sums of recorded costs and recorded counts |
| An agent's prompt on turn N | Rebuilt from the log, including compaction decisions |
| Cache keys and stale tracking | Content hashes of recorded, locked outputs |

## State is a fold over events

kriya keeps no mutable "current state" table. It keeps an append-only event log in SQLite, where a trigger refuses any UPDATE, and computes the state as `events.reduce(apply, empty)`.

Three details make that hold up in practice:

1. **Check before append.** The recorder applies each event to the current state *before* writing it. An event that can't happen, like locking a version that doesn't exist, never reaches the log.
2. **Plain JSON only.** `undefined`, `NaN` and dates change silently when they go through JSON, so payloads that contain them are refused. Otherwise the replayed state would differ from the live one.
3. **Tested at every event.** Replay must equal live state after *every* event, not just at the end.

## Crashes fall between calls, never inside a step

Recording that "a model call happened" isn't enough. The engine also has to survive dying *during* the call.

- **Write before calling out.** Everything the scheduler decided since the last outside call is committed in one transaction, before the next model, tool or person is contacted.
- **Idempotency keys from recorded state.** Every call carries `run/step#attempt`. The attempt number comes from the log, so after a crash the engine asks again with the *same* key. The provider returns the job it already ran, and doesn't charge twice.
- **Slow things are tickets.** A Replicate job or a person who answers tomorrow suspends the step with a ticket. Model waits and human waits use the same mechanism.

The test that convinced me: run a whole Part with fake models, crash it at every single write, resume, and compare. The final state, the list of paid jobs and the event log are identical to a run that never crashed, every time.

## Agents: the engine owns the loop

Agents are the hardest case, because their non-determinism compounds. Turn 3 depends on what turns 1 and 2 returned.

Most agent frameworks run the loop in memory: `while (!done) { call model; run tool }`. If the process dies on turn 37, the orchestrator only knows "started", so it starts over. Turns 1–36 get paid for again, and the model takes a different path.

In kriya the executor takes **one turn and returns**. The engine records the turn, runs the tool, records the result, and decides whether there's another turn. On resume, recorded turns are replayed and turn 37 is the first new call. Even compaction (summarizing a long history) is a recorded event, triggered by recorded token counts, so replay makes the same decisions.

One gap remains, and it's honest to name it: the window between `ToolCalled` and `ToolResult`. If a tool ran but its result wasn't recorded, it runs again. So tools with side effects (post, send, pay) must accept an idempotency key. Read-only tools don't need one.

## What this buys

- **Resume anywhere.** Close the laptop mid-Part and carry on tomorrow. Nothing is redrawn or paid for twice.
- **Lineage for free.** Any frame in the Reel traces back through every attempt, prompt, model version and verdict.
- **Precise rebuilds.** Each version records a hash per input. A new look for Bheem marks only Bheem's shots stale.
- **Trust you can measure.** Verdicts are data, so "how often does the LLM judge agree with me?" is a query, not a feeling. That number decides when a step can run unattended.

## What it costs

- **More events than you'd expect.** Thirty event types so far. Each one needs a schema, an `apply` case and a replay test.
- **Discipline at every boundary.** Any new place where randomness can enter, like a clock, a retry with a fresh seed or a provider-side trim, has to be recorded or it breaks replay.
- **No shortcuts with off-the-shelf agent loops.** Wrapping an existing agent framework would give me its features and lose durability, because it owns the loop.

## The one-line version

Models are allowed to be creative. The orchestrator isn't. Record every creative act once, and the pipeline around it becomes boring, replayable and cheap to resume.

---

*Notes for the final version:*
- *Add a diagram: the boundary ring (models, agents, judges, people, timing) around the deterministic core.*
- *Add one real example from Part 3 once real models run (Week 3): an actual crash, the resume, and the cost saved.*
- *Link the repo and `docs/09-determinism.md`.*
