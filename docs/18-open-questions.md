# 18 · Open questions

Resolved questions are recorded in [17-decisions.md](17-decisions.md).

| # | Question | Current leaning |
|---|---|---|
| Q-17 | Rebuilding a stale version that a refining step made (an edited panel) re-runs the refined step (`draw`) from scratch rather than re-applying the edit. Should rebuild replay the edit instead? | Yes: rebuild should `replay_change` the edit onto a fresh `draw`; fix with run upgrades (v0.2) or sooner if Part 3 hits it |
| Q-18 | Validator bug B-3: misspelled field names give raw Zod errors ("Required", "Unrecognized key(s)") with no "did you mean" | Fix before the CLI (Day 13), since creators will see these first |
| Q-19 | Unlogged spec ideas from Week 1: tool `args` references, agent `instructions:`, `prompt_file:`, map `graph: {by, cases}`, checker `rubric:` | `instructions:` before Day 15; `rubric:` on Day 20; the rest when a recipe needs them |

The Part 2 assembly script must be re-attached before Week 3 (Oct 27).
