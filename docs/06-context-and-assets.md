# 06 · Context and assets

## What a node sees

```
context(node) = locked outputs from upstream nodes
              + locked context inherited from higher levels
              + Library facets matched automatically by node kind
              + explicit @mentions
              − defaults the user removed
```

Only **locked** things enter context. Rejected candidates, parked branches, stale work and the back-and-forth chat that produced a lock do not. This keeps prompts short, cheap and free of rejected ideas.

```
Context for S3 = project locks (cast, style) + episode locks (story A″-3) + S1B 🔒 + S2′C 🔒
```

## The Library

The Library holds **entities**, each with **facets** for different kinds of steps:

```
@Mitra
 ├─ look    → mitra-sheet.png (front, side, back, 4 expressions)  used by: image, animation steps
 ├─ voice   → Gemini TTS voice "<name>", warm, slow                 used by: voice steps
 ├─ speech  → Hinglish, calls people "beta", proverbs               used by: script, voice steps
 └─ rules   → called "Mitra"/"Mitra chacha"; never "Madhav" (yet)   used by: script steps
```

- **Entity kinds** (Character, Place, Style, Music kit, Rules) are defined in Build mode with their facets. Instances (Mitra, Bheem, chai stall) are filled in by the creator.
- **Facets declare which node kinds they apply to.** Adding a new facet later (e.g. `@Mitra · walk cycle` for animation) makes every animation step pick it up automatically.
- **Facets are versioned and lockable.** "Keep consistent" = locked: nothing regenerates it by accident. Changing a locked facet creates a new version and marks dependent work stale (plan and cost first).
- **Missing facets block.** If a shot includes @Tiwari and he has no `look`, image steps for that shot are `BLOCKED` until it exists.

## Automatic vs explicit

| | How | Example |
|---|---|---|
| Automatic | The node pulls facets matching its kind for entities in scope | A voice node on Mitra's line gets `@Mitra · voice` and `· speech`; an image node for the same shot gets `· look` |
| Explicit | @mention in the prompt, chat or settings | "@P2-13 match this tone"; "@EmotionalClue keep it soft like the music" |
| Remove | ✕ on an automatic chip | Drop a default this node shouldn't use this time |

In the node UI:

```
🎙️ Voice: P3-06, Mitra: "Ab dekhte hain kaun aata hai…"
Using:  [@Mitra · voice] [@Mitra · speech] [@Pronunciations] [@Style · Hinglish]   ✕ to remove
Added:  [@P2-13 voice line] "match the tone of this"                            + Add asset
```

## What can be referenced

Anything locked, at any level:
- **Project:** characters, places, style, voices, music kit, pronunciation list, rules
- **Episode:** the locked story, shot list, voice table
- **Other nodes:** any locked output, e.g. `@P2-04` (image), `@P2-13` (voice line)
- **A specific version:** `@Mitra.voice v1` to pin an earlier version

## Rules

1. **Explicit mentions are saved with the node**, not just in chat. Rebuilds use the same assets; lineage shows what each output was made from.
2. **References resolve to locked versions.** If a referenced asset changes, nodes that used it go stale.
3. **Overrides by level: node > episode > project.** "In this episode Mitra has a cold, slightly hoarse" overrides without changing the project's @Mitra.
4. **Defaults come from the asset, not the node.**

## Context modes

| Mode | Uses | Default for |
|---|---|---|
| **Full** | Automatic defaults from all levels + mentions | Generate (new shot, script, voice line) |
| **Local** | Only the node's own current version + mentions | Edit / refine |
| **Isolated** | Only what the user explicitly gives it | Experiments, one-off tasks |

Defaults are per action (generate → full, edit → local); the recipe author can override per node and the user can switch per action.

### In v0.1 ([D-47](17-decisions.md))

| Mode | The step receives |
|---|---|
| `full` | Its `uses` and prompt `{{refs}}` (minus defaults removed with ✕), facets included, plus mentions and the version it starts from |
| `local` | Only the version it edits, plus mentions |
| `isolated` | Only mentions |

- Facet references: `item.characters@look` (each named entity's look), `@Mitra.voice` (one facet, typically as a mention). They resolve **step override > episode (`run`) override > Library**, and every version keeps the facet versions it used.
- A missing facet **blocks** the step ("@Tiwari has no look yet; add it to the Library"); other items carry on, and `unblock()` retries once it exists.
- The fingerprint behind stale tracking covers only what the step received, so a local edit doesn't go stale when the series style changes, and a new `@Bheem · look` stales only Bheem's shots.
- Inherited context (`series.style`) is recorded when the run starts; changing it later (`updateContext`) stales exactly the work that read it.

### Why local matters

When changing one detail about one person, pulling in every character sheet and the style line does harm: it caused the duplicate-character problem in Part 2 (the edit had too much to work with and added copies). A local edit:

```
🖼️ Shot P2-11: Kamla warns Bheem          Mode: Local

Using:   [P2-11 · version C]                (just this image)
Target:  [@Bheem] + marked area on his head
Change:  "Add his red-and-white checked gamcha headband. Change nothing else."
Added:   [@Bheem · look]   ← optional: only his sheet, so the gamcha is drawn correctly
```

Three things narrow the change: local mode, a target (person + optional region), and at most one explicit facet. The engine wraps local edits in the proven pattern automatically (a knowledge-base rule): *"Edit the first image. Keep everything exactly the same. Exactly one of each character. Only change…"*

## Summaries flow up

Higher-level agents see each node's locked output plus a short summary of its conversation ("3 versions, locked B, gamcha fixed by edit"), not every message. The project agent sees episode summaries. Each conversation stays small.

**The "why" of a lock.** A lock can carry the creator's own note on why that version was chosen, verbatim (`<node>.why`). Agent and LLM steps receive it by default; image, clip and voice steps only when they list it in `uses`. With no note, nothing is passed; it is never generated. ([D-29](17-decisions.md))
