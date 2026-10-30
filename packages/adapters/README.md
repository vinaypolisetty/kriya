# @kriya/adapters

Turns the engine's requests into real work: Claude for writing, judging and agents; Replicate for images, clips, voices and music; ffmpeg for local media tools. Every call runs as a job: the engine gets a ticket at once, and `settle()` delivers the result when it arrives. Also home to the fix policy, which is pure and decides what to press on a review screen.

Depends on `@kriya/engine` and `@anthropic-ai/sdk`. Replicate is plain `fetch`.

## Files

| File | What it is |
|---|---|
| [`jobs.ts`](src/jobs.ts) | `Jobs` (calls in flight, by ticket) and `settle(scheduler, jobs)` (deliver each result, then run on) (D-53) |
| [`anthropic.ts`](src/anthropic.ts) | `anthropicExecutors`: `llm.write` / `llm.vision` with structured outputs, `llm.research` with web search and fetch (D-74), the judge (`check`), agent turns; prices; `describeError` (D-54, D-63) |
| [`replicate.ts`](src/replicate.ts) | `replicateExecutors`: `image.generate`, `image.edit`, `video.from_image`, `audio.speech`, `audio.music`; the job ledger; throttle handling (D-56, D-58, D-69) |
| [`tools.ts`](src/tools.ts) | `mediaTools`: `crop`, `compress`, `assemble_reel`, `extract_frames`, `stills`, `attach`, `insert_caricatures`, run locally as jobs (D-62, D-80) |
| [`workers/assemble_reel.py`](workers/assemble_reel.py) | The Reel assembler: Python, Pillow and ffmpeg; reads a manifest, prints one JSON line |
| [`workers/insert_caricatures.py`](workers/insert_caricatures.py) | Cuts caricatures into a video at their moments (group, one each, or over the frozen frame); same manifest-in, JSON-line-out shape |
| [`fixes.ts`](src/fixes.ts) | The knowledge base: `suggestFix` (verdicts → crop < edit < retry < lock, D-64), the seed rules from Parts 1–3, and `tips` / `prevention` (what keeps failing → words for a step's prompt, D-76) |
| [`schema.ts`](src/schema.ts) | A step's `out` types as a strict JSON Schema; `library.<kind>` becomes an enum of Library names (D-70) |
| [`files.ts`](src/files.ts), [`duration.ts`](src/duration.ts) | A file's type from its bytes or name; a WAV or MP4's length from its bytes |

## What every provider adapter does

1. **Starts calls through `Jobs`** under the step's ticket, using `ctx.idempotencyKey` (`run/step#attempt`), so asking again after a crash is the same job.
2. **Records the exact model version and cost** in each call's `CallMeta` (design rule 6).
3. **Downloads media into the blob store** and returns `blob:<sha256>`, because provider URLs expire. Lengths are measured from the bytes, never taken from the request.
4. **Fails with a plain reason** a creator can act on (`describeError`): a missing key, a refusal, a rate limit.
5. Exposes `handles(node)`, so the CLI can route each step to the right adapter.

## Tests

`pnpm --filter @kriya/adapters test`. `fetch` and the Anthropic client are stubbed: no keys, no cost. `tools.test.ts` runs real ffmpeg and Pillow and skips itself when they're missing.
