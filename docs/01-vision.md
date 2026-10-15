# 01 · Vision

## One sentence

kriya is a platform where people build **agents that are workflows, not chats**: they put together **steps, logic, tools and screens**, and the engine runs them durably, with humans deciding at the points that matter.

## The problem

Making something real with AI (a comic episode, a hiring decision, a report) is never one prompt. It is many steps, each producing drafts that a person has to judge, fix and pick from, while keeping everything consistent with things decided earlier (the characters' look, the brand's style, the rules of the series).

Today people do this by hand across chat windows and model playgrounds:

- They copy prompts and reference images between tools.
- They lose track of which version was chosen and why.
- When they change one early decision, they can't tell which later work is now wrong.
- They re-learn the same fixes ("attach only the sheets for that shot") every time.
- Chats forget. Nothing is resumable or repeatable.

The Mohalla Mitra workflow (see [14-mohalla-mitra.md](14-mohalla-mitra.md)) is a concrete example: 7 phases, 4 model providers, ~13 shots per Reel, 3–4 candidates per shot, edit/crop/regenerate loops, voice retakes, and a growing table of failures and fixes, all run manually.

## What kriya does

1. **Runs a declared graph of steps** where each step is a model call, an agent, a code tool, or a human decision (a "UI action").
2. **Keeps every output as a version** in a tree. The human locks one; only locked work feeds the next step.
3. **Tracks what depends on what.** Changing a locked decision marks exactly the affected downstream work as stale, shows the plan and cost, and rebuilds only that.
4. **Is durable.** Runs pause for minutes (model jobs) or days (humans) and resume after crashes. Everything is in an event log.
5. **Reuses a Library** of locked reference assets (characters, places, style, voices) that every step can draw on automatically or by @mention.
6. **Learns.** Failures and their fixes become rules that prevent, detect or repair the same problem next time.
7. **Lets non-technical creators author workflows** by template, by describing them to an assistant, by drag and drop, or by editing forms, and lets them chat with an assistant whenever they're stuck.

## Who it's for

- **Primary: non-technical creators** who make repeatable content (series, channels, brand content) and need consistency across many outputs.
- **First user: the author**, making Mohalla Mitra Reels, and running other personal pipelines (e.g. an earnings-report agent).
- **Also: technical builders** who prefer YAML and code, and anyone running human-reviewed AI processes (permits, investigations, hiring) — see [13-use-cases.md](13-use-cases.md).

## What makes it different

| Common tools | kriya |
|---|---|
| Chat agents: forget, can't resume, no structure | Durable graphs with an event log; agents are steps inside them |
| DAG runners (Airflow, n8n): run steps, no human judgement model | Human decisions are first-class nodes with generated screens |
| Node canvases (ComfyUI): powerful, technical | Recipe-style builder for non-technical creators, plus a canvas for power users |
| Prompt tools: one output at a time | Version trees, explicit branches, locks, adopt across versions |
| Re-run everything after a change | Stale tracking rebuilds only what actually changed |

One-line framing: **a build system for creative work, with judges.** Like Make/Bazel (targets, dependencies, cached outputs, rebuild only what changed) plus CI (every output passes checks) plus code review (humans approve what machines can't judge).

## Principles

1. **The engine is deterministic; models are not.** Randomness lives only inside model calls and is recorded once.
2. **Humans decide; the system remembers.** Every choice, note and waiver is data.
3. **Only decisions flow forward.** Rejected options stay in history, out of context.
4. **Nothing changes silently.** Locked work changes only through approved proposals.
5. **Plain words for creators.** No variables, schemas or stack traces in the creator UI.
6. **Cost is visible before it's spent.** Estimates before runs and rebuilds; spending caps.
7. **Every loop has a limit.** No runaway spend.

## Scope

**v0.1 (personal + open source, ~6 weeks):** engine, YAML recipes, CLI, Replicate and Anthropic adapters, Library, review inbox web app, two real use cases, docs. See [16-roadmap.md](16-roadmap.md).

**Later:** visual recipe builder, drag and drop, canvas view, builder assistant, run upgrades in the UI, knowledge-base tips, templates and sharing.

**Out of scope for now:** hosted multi-tenant service, billing, team permissions, marketplace. (Creators bring their own model keys: see [17-decisions.md](17-decisions.md).)

## Why open source

- It is a personal tool first; open source costs nothing extra and invites feedback.
- It is a portfolio piece: a working engine, a real posted Reel made with it, design docs, tests and a public roadmap.
- The design ideas (deterministic orchestration of non-deterministic models; lock-and-stale propagation; durable human-in-the-loop waits) are worth writing about publicly.
