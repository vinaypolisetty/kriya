# 15 · Stack

**TypeScript across the stack**, so the graph spec, node schemas and validation are defined once and shared by the builder UI, the engine and the assistant's tools. The one exception is a Python media worker for the ffmpeg assembly script.

## v0.1 (personal + open source, local-first)

| Layer | Choice | Why |
|---|---|---|
| Repo | pnpm monorepo: `engine`, `cli`, `web`, `adapters`, `examples` | One install, shared types |
| Schemas | Zod | One definition → validation, form generation, LLM tool definitions |
| Recipes | YAML (`yaml` package with line numbers) | Readable, diffable; errors point at lines |
| Database | SQLite via `better-sqlite3`, plain SQL ([D-40](17-decisions.md)) | Zero setup for anyone who clones it; an append-only log needs no ORM |
| Media | Local folder, content-addressed | Simple; S3/R2 adapter later |
| Keys | `.env` | Users bring their own |
| Job queue | In-process scheduler over the SQLite event log | Enough for one user |
| Models | Replicate SDK, Anthropic SDK (tool use) | Webhooks/polling resume waiting steps; Claude powers agents, checkers and the builder assistant |
| UI | Vite + React (review inbox, run view) | Fast to build |
| Assembly | Python + ffmpeg, called as a tool | Reuses the Part 2 script |
| Tests | Vitest | Fast, TS-native |
| CI | GitHub Actions: typecheck, test, validate examples | Every push |
| Start-up | `pnpm dev` or `docker compose up` | One command |

## Later (hosted / multi-user)

| Layer | Choice |
|---|---|
| Web app | Next.js + React + TypeScript |
| Canvas | React Flow (xyflow) |
| Recipe drag and drop | dnd-kit (sortable, nested, keyboard accessible) |
| Components | Tailwind + Radix / shadcn/ui |
| Phone review | PWA |
| Database | Postgres (Supabase or Neon): JSON columns, append-only events, row-level security |
| Job queue | pg-boss or Graphile Worker; Temporal as the upgrade path at scale |
| Media | Cloudflare R2 (no egress fees for video) |
| Live updates | Server-sent events or Supabase Realtime |
| Auth | Supabase Auth or Clerk |
| Keys | Envelope encryption (cloud KMS or Supabase Vault) |
| Hosting | Vercel (web); Fly.io / Railway / Render (engine, workers) |
| Monitoring | Sentry + LLM tracing (Langfuse or similar) |

## Why not an existing workflow engine

Temporal/Prefect/Hatchet handle durable execution, but version trees, locks, stale propagation, content-hash invalidation, human verdicts as data and the fix loop are the core of this project and don't come off the shelf. Keep the executor interface clean enough to move onto Temporal later.

## Editor setup

VS Code with the recommended extensions in `.vscode/extensions.json` (ESLint, Prettier, Vitest, YAML, GitHub Actions). Claude Code in VS Code reads `CLAUDE.md` for project context.
