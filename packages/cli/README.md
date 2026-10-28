# @kriya/cli

A kriya project on disk, the `kriya` commands, and `kriya web`, the HTTP server behind the browser app. This is where the engine, the store and the adapters are wired together.

Depends on every other package, plus `yaml`, `zod` and `qrcode` (the phone-pairing QR code, D-68).

## Files

| File | What it is |
|---|---|
| [`main.ts`](src/main.ts) | The executable: real terminal in, exit code out |
| [`commands.ts`](src/commands.ts) | Every command (`main()`), `openRun` (replay, re-check the Library, recover), `drive`, and `executors()`, which routes each step to Claude, Replicate, a tool or a fake |
| [`project.ts`](src/project.ts) | `kriya.yaml` (models, context, Library kinds, tools), `recipes/`, the release hash |
| [`library.ts`](src/library.ts) | `library/*.yaml` → entities and facets; facet versions by content hash; `Assets` for the engine |
| [`kb.ts`](src/kb.ts) | `kb.yaml`: the project's own rules and its answers to tips; failures by step from every run's checks; `preventFor`, the words applied tips add to a prompt (D-76) |
| [`fake.ts`](src/fake.ts) | Fake models and tools, so a whole episode runs without keys or cost |
| [`web.ts`](src/web.ts) | `kriya web`: the JSON API, media, server-sent events, LAN pairing. Its header lists every route |

## How a command works

Each command is its own process. It loads the project, opens `.kriya/`, and calls `openRun()`, which replays the run, applies Library changes and calls `recover()`. Then it does its one thing, drives the run until it waits, prints a short report, and closes the store. Nothing is kept in memory between commands, so a closed terminal loses nothing. `kriya web` does the same per request, and sends every write through one queue, because two schedulers on one run would disagree.

The full command reference is [docs/cli.md](../../docs/cli.md).

## Rules for changing it

- A creator's mistake throws `UserError` with what's wrong and how to fix it. Anything else is a bug.
- A new command goes in `main()`'s switch, in `HELP`, and in docs/cli.md (`pnpm check:conventions` checks the last two).
- A new web route goes in the route list at the top of `web.ts` (checked). Reads never record events or call models.

## Tests

`pnpm --filter @kriya/cli test`. `commands.test.ts` runs the commands through `main()` on temporary projects made with `kriya init --example mohalla-mitra`, using fakes. `web.test.ts` starts the server on a free port and talks to it with `fetch`, including acting as an unpaired phone.
