# 18 · Open questions

| # | Question | Current leaning |
|---|---|---|
| Q-01 | In automatic mode, do locked nodes still always ask first? | Yes (recorded in D-08, needs explicit confirmation) |
| Q-02 | What does the next step receive from a locked node: only the output, or also a short note on *why* it was chosen? | Output plus a short optional "why" summary for agents; never full chat |
| Q-03 | "Adopt": borrow part of another version (merge), apply the same change to another version, or both? | Both, as two operations: `adopt` (merge) and `replay_change` |
| Q-04 | Which providers to support at launch beyond Replicate and Anthropic? | None for v0.1 |
| Q-05 | Should the builder assistant write new code blocks (e.g. custom ffmpeg)? | Composite blocks for everyone; sandboxed code only for advanced users |
| Q-06 | Export workflows as files for GitHub (JSON/YAML bundle as a first-class format)? | Yes; YAML recipes already are |
| Q-07 | Barrier defaults: stream (clips start as panels lock) by default, or wait by default? | Stream by default; barriers opt-in |
| Q-08 | Can a human choice add new nodes at run time ("split this shot into two")? | Later; v0.1 no |
| Q-09 | Conditions UX: sentences with pickers plus free typing, or a fixed menu first? | Sentences + pickers + free typing converted by the assistant |
| Q-10 | Fields inferred by the assistant vs defined by the creator | Inferred, shown as an editable list |
| Q-11 | Where the review UI lives long-term (local web app vs hosted, phone) | Local web app for v0.1; PWA later |
| Q-13 | Captions placement and Part 1 music redo (series decisions) | Out of engine scope |

The Part 2 assembly script must be re-attached before Week 3 (Oct 27).
