# 18 · Open questions

Resolved questions are recorded in [17-decisions.md](17-decisions.md).

| # | Question | Current leaning |
|---|---|---|
| Q-17 | Rebuilding a stale version that a refining step made (an edited panel) re-runs the refined step (`draw`) from scratch rather than re-applying the edit. Should rebuild replay the edit instead? | Yes: rebuild should `replay_change` the edit onto a fresh `draw`; fix with run upgrades (v0.2) or sooner if Part 3 hits it |
| Q-21 | Memory across runs: Part 3 can't see what Part 2 locked. Mentions resolve within one run, and level context (`kriya.yaml`) is written by hand | Promote a locked output into level context (e.g. `kriya promote <run> <step> --to story.recap`), recorded as `ContextUpdated`, so replay stays exact |
| Q-22 | `adopt` and `replay_change` refuse a step that answers with a ticket, but real image edits (Day 16) are slow jobs | Let both suspend on the ticket and record the parents when `deliver()` arrives; fix on Day 16 |
| Q-23 | A failed model job (refusal, bad key, rate limit) fails the step for good; there's no `kriya retry <run> <step>` yet. First needed on Day 17: Gemini TTS flagged a "speak faster" retake as sensitive (E005) when the first take of the same line passed, and the only way on was a new run | Add `retry` (a new attempt of a failed step) |
| Q-19 | Unlogged spec ideas from Week 1: tool `args` references, agent `instructions:`, `prompt_file:`, map `graph: {by, cases}`, checker `rubric:` | `instructions:` before Day 15; `rubric:` on Day 20; the rest when a recipe needs them |

The Part 2 assembly script must be re-attached before Week 3 (Oct 27).
