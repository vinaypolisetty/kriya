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
| [`trace.ts`](src/trace.ts) | The event log as plain-words lines (`kriya log`, a step's **What happened** in `kriya web`), arrow counts and each review's last answer |
| [`chat.ts`](src/chat.ts) | Talking to a step (`kriya chat`, `POST /api/chat`, D-87): the brief the chat gets from recorded state, and `talk`, which records the message, asks the chat, does what it asked the way a click would (lock, make a version) and records the answer |
| [`fake.ts`](src/fake.ts) | Fake models, tools and a fake step chat, so a whole episode runs without keys or cost |
| [`web.ts`](src/web.ts) | `kriya web`: the JSON API, media, server-sent events, LAN pairing. Its header lists every route |
| [`live.ts`](src/live.ts) | The runs `kriya web` is carrying on: writes one at a time, one scheduler per run while its models work (D-86) |

## How a command works

Each command is its own process. It loads the project, opens `.kriya/`, and calls `openRun()`, which replays the run, applies Library changes and calls `recover()`. Then it does its one thing, drives the run until it waits, prints a short report, and closes the store. Nothing is kept in memory between commands, so a closed terminal loses nothing. `kriya web` does the same per request, and sends every write through `LiveRuns` (`live.ts`, D-86): writes are recorded one at a time, and a run whose models are still working keeps its one scheduler, which takes the next write, because two schedulers on one run would disagree. Work in flight never holds a write up.

The full command reference is [docs/cli.md](../../docs/cli.md).

## Rules for changing it

- A creator's mistake throws `UserError` with what's wrong and how to fix it. Anything else is a bug.
- A new command goes in `main()`'s switch, in `HELP`, and in docs/cli.md (`pnpm check:conventions` checks the last two).
- A new web route goes in the route list at the top of `web.ts` (checked). Reads never record events or call models.

## Tests

`pnpm --filter @kriya/cli test`. `commands.test.ts` runs the commands through `main()` on temporary projects made with `kriya init --example mohalla-mitra`, using fakes. `web.test.ts` starts the server on a free port and talks to it with `fetch`, including acting as an unpaired phone. `live.test.ts` drives a run whose clip is slow, to show a pick goes through meanwhile.
