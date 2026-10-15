# 17 · Decisions

A log of decisions with reasons. Change a decision by adding a new entry that supersedes it.

| # | Date | Decision | Why |
|---|---|---|---|
| D-01 | 2026-10-12 | Build a **generic** orchestrator; Mohalla Mitra is the first use case, not the definition | The pattern (stages, generate→check→fix, shared assets, learned fixes) recurs across many domains |
| D-02 | 2026-10-12 | **One engine, step kinds as equals**: workflow nodes, agents, tools, UI actions; any can contain or call the others | Agents and humans are both "steps that take a long time"; one primitive (complete / spawn / suspend) keeps the engine small |
| D-03 | 2026-10-12 | **Durable execution via an event log**; humans and model jobs use the same suspend/resume tickets | Resumability, lineage, audit, KB mining; manual mode for free |
| D-04 | 2026-10-13 | **Candidates are automatic (config); branches are explicit (user says "branch off")**, named and saved | Images benefit from best-of-N every time; story direction changes are deliberate and need their own history |
| D-05 | 2026-10-13 | When a branched upstream is locked over the original, downstream work is **marked stale and parked** (not kept as an alternate cut). Only work whose inputs changed goes stale; re-locking restores it | Keeps one active cut; nothing is lost |
| D-06 | 2026-10-13 | Primary authors are **non-technical creators** | Drives recipe-style builder, generated screens, plain language, templates first |
| D-07 | 2026-10-13 | **Creators define their own levels**; project/episode is only the starting template | Different domains have different hierarchies (channel → series → episode → shot) |
| D-08 | 2026-10-13 | **Higher-level agents always show a plan first** by default, with an option to switch a step/level to automatic. **Locked nodes always require approval** | Safety and cost visibility; autonomy can grow per step |
| D-09 | 2026-10-13 | **Creators bring their own model keys**; costs bill to their accounts; platform shows estimates | Avoids billing/reselling; fits open source |
| D-10 | 2026-10-13 | Conversation at every level, scoped: node micro-agents change their node; episode agent directs node agents; project agent handles Library/templates | Clear blast radius; traceable changes |
| D-11 | 2026-10-13 | **Only locked outputs flow downstream**; siblings leave context, not history | Short, cheap prompts free of rejected ideas; reversible |
| D-12 | 2026-10-13 | Assets are **entities with facets** (look, voice, speech, rules) used automatically by matching node kinds, plus explicit @mentions; overrides node > episode > project | "By default it should consider, but explicit mention possible" |
| D-13 | 2026-10-13 | **Context modes**: full (generate default), local (edit default), isolated | Edits with too much context caused duplicates in Part 2 |
| D-14 | 2026-10-13 | Definitions stored as **one JSON document per graph version**, with stable ids, drafts → immutable releases; runs pin releases | Atomic, hashable, diffable; renames never break runs |
| D-15 | 2026-10-13 | **Deterministic engine, non-deterministic models**: conditions read only recorded data; no live model calls in conditions (use a checker node); pin model versions | Reproducible flows; auditable judgements |
| D-16 | 2026-10-13 | The stored form is an **explicit graph (nodes + edges, conditions on edges)**; the recipe view is a rendering of it | Real branching, loops and joins; one source of truth for recipe, canvas and YAML |
| D-17 | 2026-10-13 | All authoring surfaces (forms, drag and drop, builder assistant chat, YAML) produce the **same graph operations**; the assistant can only do what clicks can do | Validation, undo and history in one place; safe assistant |
| D-18 | 2026-10-13 | **UI actions are drag-and-drop blocks**; each button is an outgoing edge | Human decisions are first-class and composable |
| D-19 | 2026-10-13 | Build **our own small engine** on SQLite/Postgres; keep a path to Temporal | Core value (versions, locks, stale) isn't off the shelf |
| D-20 | 2026-10-13 | **TypeScript** monorepo with **Zod**; Python only for the media worker | One schema shared by UI, engine and LLM tools |
| D-21 | 2026-10-13 | v0.1 is **local-first and open source** (Apache-2.0), for personal use and as a portfolio project; YAML recipes; builder later | Ship in ~6 weeks part-time; visible progress for job search |
| D-22 | 2026-10-13 | Agent nodes may only call the tools listed on the node | Safety and cost control |
| D-23 | 2026-10-13 | Every loop requires `max_loops`; enforced by the validator | No runaway spend |
| D-24 | 2026-10-13 | Recipe schemas are **strict** (unknown keys are errors) | Typos must not pass silently |
| D-25 | 2026-10-15 | Project name is **kriya** (Sanskrit: action, a deliberate act). Package scope `@kriya/*`, CLI `kriya` | Replaces the working name `orc`; matches the repo |
