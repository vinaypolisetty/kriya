# kriya documentation

These docs record the full design as of October 2026: what was decided, why, and what is still open. They are written so that someone new (or an AI coding assistant) can pick up the project without the original conversations.

| # | Doc | What it covers |
|---|---|---|
| 01 | [Vision](01-vision.md) | What kriya is, who it's for, what makes it different, scope |
| 02 | [Core concepts](02-concepts.md) | Levels, nodes, step kinds, candidates, branches, versions, locks, context, stale |
| 03 | [Engine](03-engine.md) | Event log, scheduler, task lifecycle, durable waits, loop controller, caching |
| 04 | [Graph spec](04-graph-spec.md) | The recipe file format, field by field, with examples |
| 05 | [Authoring](05-authoring.md) | How creators build workflows: recipe view, canvas, drag and drop, chat assistant, conditions |
| 06 | [Context and assets](06-context-and-assets.md) | The Library, facets, @mentions, context modes, overrides |
| 07 | [Versions, branches and locks](07-versions-branches-locks.md) | Version trees, branching, adopt, lock, stale propagation, run upgrades |
| 08 | [Persistence](08-persistence.md) | Stores, tables, releases, stable IDs, export |
| 09 | [Determinism](09-determinism.md) | What is deterministic, what isn't, and how the boundary is kept |
| 10 | [UI](10-ui.md) | Run-mode and build-mode screens |
| 11 | [Providers and tools](11-providers.md) | Capabilities, adapters, model registry, keys, tools |
| 12 | [Knowledge base](12-knowledge-base.md) | Failure → fix rules that grow over time |
| 13 | [Use cases](13-use-cases.md) | Content creation and beyond |
| 14 | [Mohalla Mitra](14-mohalla-mitra.md) | The reference use case: episode algorithm, assets, failure table |
| 15 | [Stack](15-stack.md) | Technology choices for v0.1 and later |
| 16 | [Roadmap](16-roadmap.md) | 42-day v0.1 plan and later versions |
| 17 | [Decisions](17-decisions.md) | Decision log with reasons |
| 18 | [Open questions](18-open-questions.md) | What is still undecided |
| 19 | [Glossary](19-glossary.md) | Every term in one place |

Weekly build notes: [notes/](notes/) ([week 1](notes/week-01.md)).
| — | [Getting started in VS Code](getting-started-vscode.md) | Install, open, test, push to GitHub, use Claude Code |

Related artifacts kept outside the repo:
- *Orchestrator: Spec & User Journey* (Claude doc): the first written spec and the Part 3 user journey
- *Orchestrator UI Mocks* (design canvas): run-mode and build-mode screens
- *Mohalla Mitra: 25 Stories* (Claude doc): the series, Production Playbook, Episode Algorithm, Full Context
