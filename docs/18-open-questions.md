# 18 · Open questions

Resolved questions are recorded in [17-decisions.md](17-decisions.md).

| # | Question | Current leaning |
|---|---|---|
| Q-17 | Rebuilding a stale version that a refining step made (an edited panel) re-runs the refined step (`draw`) from scratch rather than re-applying the edit. Should rebuild replay the edit instead? | Yes: rebuild should `replay_change` the edit onto a fresh `draw`; fix with run upgrades (v0.2) or sooner if Part 3 hits it |
| Q-21 | Memory across runs: Part 3 can't see what Part 2 locked. Mentions resolve within one run, and level context (`kriya.yaml`) is written by hand | Promote a locked output into level context (e.g. `kriya promote <run> <step> --to story.recap`), recorded as `ContextUpdated`, so replay stays exact |
| Q-22 | `adopt` and `replay_change` refuse a step that answers with a ticket, but real image edits (Day 16) are slow jobs | Let both suspend on the ticket and record the parents when `deliver()` arrives; fix on Day 16 |
| Q-24 | A provider can refuse an input every time (E005): retry asks again with the same input, so it can't help. L06's case was the style's order (D-60), but a refusal can come back with other lines | The fix loop (Day 21): a refused step routes to a fix like a failed check (reword the style, drop a facet, ask the person), recorded as a change, never a silent edit |
| Q-25 | Library, after Day 18: (a) facets picked automatically by step kind (a voice step gets the speaker's voice without `item.speaker@voice`) needs a way to say which fields name entities; (b) pinning an old version (`@Mitra.voice v1`); (c) the music kit (no tracks in the project yet; the voice cast is in doc 14) | (a) mark entity fields in recipe types (`speaker: character`), then pick facets by capability; (b) when a run needs it; (c) a few Lyria 2 tracks for the kit, as `kind: music` entities |
| Q-19 | Unlogged spec ideas from Week 1: tool `args` references, agent `instructions:`, `prompt_file:`, map `graph: {by, cases}`, checker `rubric:` | `instructions:` before Day 15; `rubric:` on Day 20; the rest when a recipe needs them |

The Part 2 assembly script must be re-attached before Week 3 (Oct 27).
