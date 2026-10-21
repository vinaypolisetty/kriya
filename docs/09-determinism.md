# 09 · Determinism

**The engine is deterministic. The models are not.** Randomness is allowed only inside a model call; it is recorded once and treated as fixed data afterwards. This is the same approach durable workflow engines like Temporal use (deterministic workflow code, recorded activities).

| Part | Deterministic? | How |
|---|---|---|
| Which node runs next, branches, loops, joins | Yes | Conditions are pure rules on recorded fields; no clock, no randomness |
| Conditions written in plain English | Yes, at run time | Converted to a rule **when authoring**, never re-interpreted per run |
| Order of `map` items | Yes | The order of the locked source list (recorded data), never completion order, so parallel execution doesn't change it ([D-41](17-decisions.md)) |
| Which version is locked, what's stale | Yes | Computed from content hashes and lock events |
| Replay / resume | Yes | Rebuilt from the event log; no model is re-called |
| Model outputs | **No** | Recorded with prompt, inputs, model version, seed, cost |
| Agent decisions | **No** | Each turn and tool call recorded; replayed from the log |
| AI checker verdicts | **No** | Recorded with the candidate; re-checking creates a new verdict event |

## Consequences

- **Same inputs → same flow.** Given the same locked outputs and decisions, the engine always takes the same path. Workflow bugs are reproducible.
- **Once something exists, it never changes.** Locks, agent choices and verdicts are stored; resuming after a crash never regenerates or re-decides anything.
- **Regenerating gives something new, on purpose.** "Try again" and stale rebuilds are fresh model calls. To get the old result, re-lock the old version.
- **Same request ≠ same output.** Seeds help on some image/video models but not reliably across providers; LLMs and TTS vary even at identical settings. Reproducibility comes from **storing outputs**, not re-running models.

## Rules the engine enforces

1. **Pin model versions.** Record the exact provider version (e.g. Replicate version hash), not just a model name. Providers update models under the same name.
2. **Conditions read only recorded data.** "Ask me if the checker isn't confident" reads the *stored* verdict; it never calls a model while deciding where to go.
3. **No live model calls in conditions.** "If the script feels too long" becomes a checker node that records a verdict, and the condition points at that verdict. The flow stays deterministic and the judgement stays visible and auditable.
4. **Engine code avoids `Date.now()`, `Math.random()` and iteration-order dependence** in control flow. Time comes from events; ids from deterministic derivation or recorded generation.
5. **Idempotency keys** from attempt ids prevent duplicate provider calls on resume.

## Builder assistant and determinism

The builder assistant only writes graph operations at authoring time. It never runs inside a published recipe, so chatting never changes how a release executes.
