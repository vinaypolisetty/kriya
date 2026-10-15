# 11 · Providers and tools

## Capabilities, not models

Steps ask for a **capability**; a registry maps it to a provider and model. Swapping Wan 2.7 for something newer is a config change, and different steps can use different models.

| Capability | Input → output | Mohalla Mitra default |
|---|---|---|
| `image.generate` | text + reference images → image | Nano Banana (Replicate), 16:9 |
| `image.edit` | image + instruction (+ refs) → image | Nano Banana (Replicate) |
| `video.from_image` | image + text → video | Wan 2.7 image-to-video (Replicate), 5 s |
| `audio.speech` | text + voice + style → audio | Gemini TTS `gemini-3.1-flash-tts` (Replicate) |
| `audio.music` | text → audio | A Replicate music model, ~30 s tracks |
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

`assemble_reel` will wrap the existing Python script in a container worker (ffmpeg needs CPU and long runtimes). **The script needs to be re-attached** before Week 3.

## Code blocks by assistant

Open question: should the builder assistant write new code tools (e.g. a custom ffmpeg step) for creators? Proposal: composite blocks and catalog models for everyone; code blocks only for advanced users, sandboxed. ([18](18-open-questions.md))

## Which providers at launch

Replicate and Anthropic for v0.1. Others are open ([18](18-open-questions.md)).
