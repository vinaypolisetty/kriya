# 11 · Providers and tools

## Capabilities, not models

Steps ask for a **capability**; a registry maps it to a provider and model. Swapping Wan 2.7 for something newer is a config change, and different steps can use different models.

| Capability | Input → output | Mohalla Mitra default |
|---|---|---|
| `image.generate` | text + reference images → image | Nano Banana 2 `google/nano-banana-2` (Replicate), 16:9, $0.067 at 1K |
| `image.edit` | image + instruction (+ refs) → image | Nano Banana 2 (Replicate) |
| `video.from_image` | image + text → video | Wan 2.7 image-to-video `wan-video/wan-2.7-i2v` (Replicate), 5 s, $0.10/s at 720p, $0.15/s at 1080p |
| `audio.speech` | text + voice + style → audio | Gemini TTS `google/gemini-3.1-flash-tts` (Replicate), ~$0.001/s (priced by tokens) |
| `audio.music` | text → audio | Lyria 2 `google/lyria-2` (Replicate), 30 s tracks, $0.002/s |
| `llm.write` | text (+ images) → structured text | Claude (Anthropic API) |
| `llm.vision` | images + rubric → verdict | Claude (Anthropic API) |

## Adapter interface

```ts
interface ProviderAdapter {
  id: string;                                   // "replicate", "anthropic"
  capabilities(): CapabilityInfo[];             // what it offers, parameter schemas
  submit(call: CapabilityCall): Promise<Ticket | Result>;   // async jobs return a ticket
  poll?(ticket: Ticket): Promise<Result | Pending>;
  verifyWebhook?(req: Request): Result | null;  // Replicate webhooks resume waiting steps
  estimateCost(call: CapabilityCall): Money;
}
```

Every call records: provider, **exact model version** (e.g. Replicate version hash), parameters, seed, input hashes, output blob hash, cost, latency.

## Keys

**Creators bring their own keys** ([Decision D-09](17-decisions.md)). Model costs bill to their accounts; the platform shows estimates before each run.

- v0.1: `.env` (`REPLICATE_API_TOKEN`, `ANTHROPIC_API_KEY`). Never committed.
- Later (hosted): a guided "Connect Replicate" step during setup (opens the provider page, paste once, verify it works), stored with envelope encryption; clear errors when a key is missing or out of credit.

The model dropdown in the builder only shows models for which a key is connected.

## Manual mode

Any model step can run in **manual mode**: the engine writes out the exact prompt and reference files; the creator runs the model themselves and uploads the result; the step resumes. Same suspend/resume mechanism, different ticket. Useful at first and for providers without an API.

## Tools

Tools are code steps with typed inputs and outputs.

| Tool | Does |
|---|---|
| `crop` | Crop to a region (free; no model call) — removes extras at edges |
| `compress` | Re-encode under a size limit (e.g. < 30 MB for sending) |
| `trim` / `hold_frame` | Keep the good part of a clip and hold its last good frame |
| `assemble_reel` | The Part 2 ffmpeg assembly script: 1080×1920, shots timed to voice lines, pan/zoom on stills, crossfades, English captions, music sections ducked under voices, end card, compressed < 30 MB. Strips model audio (Wan's audio is always discarded). |
| `extract_frames` / `stills` | Small frames every N seconds with their times, for Claude to look through; a full-size still at each chosen moment, to draw from (D-80) |
| `insert_caricatures` | Cuts caricatures into a video at their moments: one full screen with a push in, one after another, or popped over the frozen frame where each subject stands; captions; sound paused during each cut (D-80) |

The tools run on the creator's machine with ffmpeg, as jobs like model calls (D-62). `assemble_reel` is the Part 3 assembler made general (`packages/adapters/workers/assemble_reel.py`, Python + Pillow): everything that was hardcoded for one episode comes from the recipe. A container worker for hosted runs comes later.

## Code blocks by assistant

## Agent-written tools and provider choice ([D-32](17-decisions.md))

- **Agents write their own tools, sandboxed** (v0.2): Deno with permission flags for TS/JS, Docker with no network for Python/ffmpeg. The code is a recorded, hashed output; replay uses recorded results. No approval needed in auto mode.
- **Agents pick, discover and switch providers** on their own within budget: catalog models, `swap_provider`, new Replicate models (exact version pinned), and arbitrary web APIs through a sandboxed `http` tool with a domain allowlist.
- **Secrets broker:** the engine injects keys into provider calls. Agent-written code never sees a key, so the worst case is spent budget, which is capped.
- **Promotion** of a sandboxed tool to a trusted, unrestricted tool needs a human who has read the code. It is recorded, revertible and pinned by hash; changed code drops back to the sandbox.
- **Never:** unsandboxed AI-written code that no human reviewed.
- v0.1: the creator writes tools (functions behind `Executor`); agents choose among catalog tools and providers and course-correct.

## Which providers at launch

Three providers in v0.1, each with one job ([D-31](17-decisions.md)):

| Provider | Role | Capabilities |
|---|---|---|
| **Anthropic** | Reasoning and navigation: agents, checkers, shot lists, the builder assistant | `llm.write`, `llm.vision` |
| **Replicate** | Real media generation | `image.generate`, `image.edit`, `video.from_image`, `audio.speech`, `audio.music` |
| **Fake** | Quick testing and the no-keys demo: canned outputs for every capability, $0, deterministic | All |

Anything else runs through **manual mode** until it earns an adapter.
