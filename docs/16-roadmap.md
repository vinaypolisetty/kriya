# 16 · Roadmap

## v0.1 — 42 days, 2 hours a day (Tue Oct 13 → Mon Nov 23, 2026)

Goal: a durable engine, two real use cases, a review inbox, and a repo that's easy to try and understand. The printable version is *Orchestrator-v0.1-42-Day-Plan.pdf*.

Rules: tick a day when its "done when" is met, not when time runs out. Days 14 and 28 are buffers. If a day overruns, carry it forward and drop the lowest task of the week, never the week's finish line.

### Week 1 · Engine foundations (Oct 13–19)

| Day | Date | Focus | Tasks | Done when |
|---|---|---|---|---|
| 1 | Tue Oct 13 | Set up the repo ✅ | Name, license, pnpm monorepo, CI | A test passes in CI |
| 2 | Wed Oct 14 | Graph spec ✅ | Zod schemas: graph, node kinds, edges, typed fields | A sample graph validates |
| 3 | Thu Oct 15 | Mohalla Mitra recipes in YAML ✅ | Part/shot/voice recipes; loader with readable errors | Recipes load; broken ones give readable errors |
| 4 | Fri Oct 16 | Storage ✅ | SQLite (`better-sqlite3`): append-only events; content-addressed blob store. Other tables added when first needed | Write and read a blob by hash |
| 5 | Sat Oct 17 | Event log ✅ | Append-only events; rebuild state by replay; agent events included (D-26) | Replay == live state, at every event (a crash after any event loses nothing) |
| 6 | Sun Oct 18 | Scheduler ✅ | Ready queue with fake executors; condition evaluator wired to edges; joins | A branch and a capped loop pass |
| 7 | Mon Oct 19 | For-each and join ✅ | Map fan-out with stable keys; per-item loops; map outputs as ordered lists (D-41); wait-for-all joins; [weekly notes](notes/week-01.md). Map-to-map links by key: when a recipe first needs one | Part graph runs end to end with fakes |

(Days 1–3 were completed together on Oct 13.)

### Week 2 · Versions, locks and durable waits (Oct 20–26)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 8 | Tue Oct 20 | Version tree ✅: candidates, parents, lock; locking buttons and generated approvals (D-42); `result` for routing on drafts (D-43); only locked outputs enter context | Lock/context tests pass |
| 9 | Wed Oct 21 | Branches ✅: create, switch, park; `replay_change`; `refines` so edits and redos become new versions of the same step (D-44); screens can wait for an answer. Adopt moved to Day 14 | Branch tests pass; one instruction replayed onto two items; the pick screen shows the edited panel |
| 10 | Thu Oct 22 | Cache keys and stale ✅ (spec + inputs + refs + item; per-input hashes, D-45); rebuild reuses unchanged items | Changing one shot marks only its work stale |
| 11 | Fri Oct 23 | Durable waits ✅: tickets (`deliver`); atomic steps; idempotency keys; `recover()`; crash at every write (D-46) | Resume makes no duplicate calls |
| 12 | Sat Oct 24 | Context and assets ✅: inheritance (`inherits`), full/local/isolated, facets with versions, blocking on missing facets, @mentions, removed defaults, overrides (D-47); reference validation (B-1, B-2) | Context tests pass |
| 13 | Sun Oct 25 | CLI ✅: `kriya init, run, status, inbox, decide, lock` ([docs/cli.md](cli.md)); plain schema errors (Q-18) | A full fake episode from the terminal |
| 14 | Mon Oct 26 | Buffer + write-up ✅: [deterministic orchestration of non-deterministic models](notes/writeup-determinism.md); `adopt` (two parents, D-49); `kriya adopt`, `kriya rebuild` (Q-20) | Draft saved; adopt tests pass |
| 14a | from slack | **Agent loop** ✅ (D-26, D-50): `AgentExecutor.turn()`, the engine-owned turn loop, a tool registry (only listed tools), `max_turns` and `budget.usd` checked between turns. Fakes only | An agent calls 3 tools and returns a final answer; a crash at any write resumes at the same turn with no repeated calls |
| 14b | from slack | **Agents that wait and remember** ✅ (D-51): `ask_human` as a tool (the screen suspend path), slow tools as tickets, offload + `recall`, `note` (D-39 steps 1–3) | An agent pauses for a person, resumes the next day and finishes |
| 14c | from slack (half day) | **File tools for agents** ✅ (D-52) over the blob store: read, write, list; content-addressed so replay stays exact | An agent writes a draft file and reads it back after a crash |

Days 14a–14c use the four days the plan ran ahead by Day 13. They make kriya run agents and tools, not only fixed workflows.

### Week 3 · Real models and the Library (Oct 27–Nov 2)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 15 | Tue Oct 27 | Capability interface + Anthropic adapter ✅ (D-53, D-54): **tool use first**, then write and vision; log model version and cost; agent context use drives clearing (D-39 step 2). Real run on Oct 23: Part 3 shot list (13 shots, 18 lines, $0.13) and a 4-turn caption agent with file tools ($0.02); follow-ups in D-55 | A real Claude agent runs a real tool through kriya; a real shot list from a real story |
| 16 | Wed Oct 28 | Replicate images ✅ (D-56, D-57): Nano Banana generate/edit; polling resume with a job ledger; looks with words; prompts recorded. Real run Oct 24: P3-04, three on-model panels for $0.20. `adopt` and `replay_change` on slow jobs (Q-22) still open | Three real candidates for one shot |
| 17 | Thu Oct 29 | Replicate clips, voice, music ✅ (D-58): Wan 2.7 i2v, Gemini 3.1 Flash TTS, Lyria 2; one job ledger (idempotency keys) for every capability; lengths measured from the bytes. Real run Oct 24: P3-04 as a 5.04 s clip ($0.50 at 720p) and Mitra's L06 line, 7.52 s ($0.008); Gemini refuses the "speak faster" retake of that line, repeatably (E005, Q-24) | One clip and one voice line |
| 18 | Fri Oct 30 | Library: assets, facets, versions; import cast, style, voices, music | @Mitra resolves to look and voice |
| 19 | Sat Oct 31 | Tools: crop, compress, `assemble_reel` (Part 2 script) | Assembly runs from the engine |
| 20 | Sun Nov 1 | Checkers: rubric vision, duration, size; verdict events | A bad panel is caught |
| 21 | Mon Nov 2 | Fix loop: edit/crop/retry routing; seed KB from the failure table; a **fix agent** when no rule matches | One real shot, start to lock, via CLI |

### Week 4 · Review inbox (Nov 3–9)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 22 | Tue Nov 3 | Web scaffold (Vite + React + small API), SSE live updates | Inbox lists waiting decisions |
| 23 | Wed Nov 4 | Pick-one screen: grid, Lock/Edit/Crop/Try again, note feeds prompt | Lock a panel from the browser |
| 24 | Thu Nov 5 | Region tool (crop, local edit) and audio players | Crop and approve a line in the UI |
| 25 | Fri Nov 6 | Run view: steps, status, stale markers, plan-and-cost card | A whole Part at a glance |
| 26 | Sat Nov 7 | Version tree panel (branch, switch); read-only Library | Switch branches from the UI |
| 27 | Sun Nov 8 | Phone layout; batch review; LAN access with a pairing token (D-38) | Review a batch on a phone over home wifi |
| 28 | Mon Nov 9 | Buffer + write-up: locks and stale tracking | Draft saved |

### Week 5 · Two real use cases (Nov 10–16)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 29 | Tue Nov 10 | Inspector Tiwari sheet + voice via the platform; start Part 3 | Tiwari locked in the Library |
| 30 | Wed Nov 11 | Part 3 shots and panels; log bugs as issues | All panels locked |
| 31 | Thu Nov 12 | Part 3 clips and voices; fix worst bugs | All media locked |
| 32 | Fri Nov 13 | Assemble, watch, fix, re-render; post | Part 3 live on Instagram |
| 33 | Sat Nov 14 | Second use case: earnings report recipe (text-only) | Recipe validates and starts |
| 34 | Sun Nov 15 | Run on two companies; fix gaps | Two finished reports |
| 35 | Mon Nov 16 | Knowledge base: Part 3 failures → rules; tips in CLI/inbox | A new tip appears and applies |

### Week 6 · Ship v0.1 (Nov 17–23)

| Day | Date | Focus | Done when |
|---|---|---|---|
| 36 | Tue Nov 17 | README: demo GIF, posted Reel, 3-command quickstart | A stranger understands it in a minute |
| 37 | Wed Nov 18 | Docs: architecture, spec reference, writing recipes, adding adapters | docs/ complete |
| 38 | Thu Nov 19 | Fresh-machine test, docker compose, fake-model example (no keys) | Clone-to-running < 10 min |
| 39 | Fri Nov 20 | Coverage + CI badge; roadmap issues; good-first-issue labels | Issues board public |
| 40 | Sat Nov 21 | 3-minute demo video | Video linked from README |
| 41 | Sun Nov 22 | Tag v0.1; publish posts; share | v0.1 released |
| 42 | Mon Nov 23 | Resume/LinkedIn; three interview stories | Stories ready; v0.2 planned |

## v0.2 — Builder

**Sandboxed agent tools** (moved from v0.4, D-32): agents write and run their own tools in Deno / Docker sandboxes; secrets broker; promotion to trusted tools with review.

Recipe view, step cards, UI-action settings, conditions with pickers, drag and drop (dnd-kit), validation in the UI, click-through test, publish, run upgrades.

## v0.3 — Smart authoring

Builder assistant (chat → graph operations, with an eval set of "request → expected change"), canvas view (React Flow), branch/adopt UI, knowledge-base tips in the builder, custom blocks.

## v0.4 — Others can use it

Hosted option, accounts, guided key setup, templates and forks, phone polish, hosted-grade sandboxing (Firecracker / gVisor), onboarding.

## Full-time estimate (for reference)

| Phase | Full-time | Cumulative |
|---|---|---|
| Engine core | 2–3 weeks | ~3 weeks |
| Personal MVP (Part 3 end to end, YAML recipes) | 3–4 weeks | ~6–7 weeks |
| Builder v1 | 5–7 weeks | ~3 months |
| Smart authoring | 4–6 weeks | ~4–4.5 months |
| Usable by others | 4–6 weeks | ~5–6 months |

Riskiest parts: run upgrades and stale tracking (test thoroughly, early); condition UX for non-technical users; builder-assistant reliability (needs an eval set); generalizing assembly beyond Reels.
