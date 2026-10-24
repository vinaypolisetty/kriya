# CLAUDE.md

Context for AI coding assistants (Claude Code in VS Code, etc.) working in this repo.

## What this project is

kriya is a durable orchestration engine for multi-step creative and production pipelines with humans in the loop. It runs graphs whose nodes are **workflow steps, agents, tools, and UI actions (human decisions)**. It is open source, built first for personal use (the *Mohalla Mitra* Instagram motion-comic series) and as a portfolio project.

Read before making design changes:
- `docs/02-concepts.md`: the vocabulary (levels, nodes, candidates, branches, versions, locks, context, stale)
- `docs/03-engine.md`: runtime design
- `docs/04-graph-spec.md`: the recipe file format
- `docs/17-decisions.md`: decisions already made. Don't reverse them without asking.

## Owner

Vinay Polisetty (engineering manager; building this part-time, ~2 hours a day). The day-by-day plan is in `docs/16-roadmap.md`. Prefer small, reviewable changes that move the current day's task forward.

## Commands

```bash
pnpm install
pnpm test                 # vitest, all packages
pnpm typecheck            # tsc --noEmit, all packages
pnpm validate:examples    # validate every recipe in examples/
bin/kriya help            # the CLI (docs/cli.md)
```

Run all three before considering a change done. CI runs the same three.

## Layout

```
packages/engine/src/
  spec.ts          Zod schemas: Graph, Node (discriminated by kind), Edge
  condition.ts     safe condition language: tokenizer, parser, evaluator
  validate.ts      semantic checks beyond the schema
  load.ts          YAML → graphs, problems with file:line:col
  cli-validate.ts  CLI entry for validation
  events.ts        Zod union of engine events (the event log's types)
  state.ts         run state as a pure fold over events: apply / replay
  recorder.ts      live side: check + apply an event, then append it
  scheduler.ts     which step runs next: edges, conditions, loop limits, joins
packages/engine/test/   vitest tests
packages/store/src/
  blobs.ts         content-addressed blob store (sha256, write-once)
  events.ts        append-only event log on SQLite (better-sqlite3), schema migrations
  index.ts         openStore(dir): .kriya/kriya.db + .kriya/blobs/
packages/adapters/src/
  jobs.ts          in-flight provider calls as tickets; settle() delivers them (D-53)
  anthropic.ts     Claude: llm.write / llm.vision steps and agent turns (D-54)
  replicate.ts     Replicate: image.generate / image.edit (Nano Banana), job ledger (D-56)
  schema.ts        a step's `out` types as a strict JSON Schema
packages/cli/src/
  commands.ts      init, run, status, inbox, decide, lock, rebuild, adopt (each a fresh process over .kriya/)
  project.ts       kriya.yaml + recipes folder
  fake.ts          fake models and Library for keyless runs
bin/kriya          runs the CLI from this checkout in your current folder
examples/mohalla-mitra/ reference recipes (part, shot, voice)
docs/                   design docs (numbered)
```

Planned packages (not created yet): `web` (review inbox).

Local run data lives in `.kriya/` at the project root (gitignored): `kriya.db` and `blobs/`.

## Non-negotiable design rules

1. **The engine is deterministic; models are not.** Control flow (which node runs next, branches, loops, joins) depends only on recorded data. Model outputs, agent decisions and checker verdicts are recorded as events the first time and replayed, never re-generated, on resume.
2. **Conditions never call models or read the clock.** They read recorded data only. If a decision needs judgement, add a checker node that records a verdict and let the condition read the verdict.
3. **Only locked outputs flow downstream.** Rejected candidates and parked branches stay in history, never in context.
4. **Stable IDs, not names.** Nodes, fields and conditions are referenced by id. Renames must never break references, runs or locks.
5. **Every loop has a limit.** Any edge that closes a cycle carries `max_loops`. The validator enforces this.
6. **Pin model versions.** Record the exact provider model version for every call.
7. **Nothing is silently changed in a locked node.** Changes that touch a lock become proposals. In ask mode the user approves them; in auto mode they apply immediately, are recorded as auto-approved, notify the user and can be reverted to the previous lock (D-28).
8. **Higher-level agents show a plan before acting** by default (with optional auto mode per step or level). In auto mode, locked nodes don't ask first (D-28).
9. **Creators bring their own API keys.** Never commit keys; read from `.env`.

## Code conventions

- TypeScript strict mode, ES modules, `.js` extensions in relative imports (NodeNext).
- Zod for every external shape (files, API payloads, LLM tool inputs). Derive TS types with `z.infer`.
- Schemas are `.strict()` so typos in recipes are errors, not silently ignored.
- Error messages are for non-technical creators: plain words, say what's wrong and how to fix it, suggest the nearest valid name.
- Pure functions in the engine core; I/O (database, providers, filesystem) behind interfaces so tests use fakes.
- Tests sit in `packages/*/test`, named `*.test.ts`. Every validator rule gets a test with a failing example.
- No new runtime dependency without a reason in the PR description.

## Vocabulary (use these words consistently)

| Term | Meaning |
|---|---|
| Recipe / graph | A workflow definition at one level |
| Level | A scope like series, story, part, shot. Creators define their own |
| Node | One step. Kinds: `model`, `agent`, `tool`, `screen`, `map`, `subgraph` |
| UI action | A `screen` node: pauses for a human, shows a generated screen |
| Candidate | One of N automatic outputs a node produces (e.g. 3 images) |
| Branch | An alternate path the user creates explicitly, with its own conversation |
| Version | Any output in a node's version tree |
| Lock | Marks one version as the node's output |
| Stale | Downstream work whose inputs changed after an upstream lock moved |
| Asset / facet | Library entity (e.g. @Mitra) and one aspect of it (look, voice, speech, rules) |
| Release | An immutable published set of graph versions; runs pin a release |
