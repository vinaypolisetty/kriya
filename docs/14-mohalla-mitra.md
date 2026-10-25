# 14 · Mohalla Mitra (reference use case)

An original Instagram motion-comic series inspired by (and deliberately distinct from) Chacha Chaudhary: a 60-year-old chaiwala who solves neighbourhood problems with his head and the mohalla's help. Full source material: the Claude doc *Mohalla Mitra: 25 Stories* (tabs: 25 Stories, Production Playbook, Episode Algorithm, Story 1 script, Full Context).

## Format and locked decisions

| Area | Decision |
|---|---|
| Format | Instagram Reels, 9:16, motion comic: stills with pan/zoom plus ~4 animated clips per Reel |
| Art style | Anime-influenced cartoon, 2D, clean linework, soft cel shading, warm colors |
| Language | Hinglish voices, English captions |
| Episode size | 1 story = 9 pages = 3 Reels, posted Mon / Wed / Fri; full carousel Saturday |
| Distinct from Chacha Chaudhary | Grounded team show: Mitra solves with his head and the mohalla's help; Pinki as young co-lead; no superpowers |
| Mitra's name | Called "Mitra" / "Mitra chacha" in dialogue; real name Madhav saved for a later reveal |
| Bheem | Engine ears (names any vehicle by its sound), "nobody notices him"; comedy: lizard fear, earthquake snore; never solves the case |
| Bheem's look | Curly hair, red-and-white checked gamcha headband, short beard, bodybuilder build, khaki driver shirt |
| Chai stall | The Part 1 interior: natural wood, shelves with steel pots, glass tumblers, jars with red and yellow lids, gas stove |
| Music | Original Bollywood-style tracks; never real film songs |
| Posting | Always as a Reel (a regular post crops the video), "Also share to feed" on |

## Cast (Library entities)

Mitra (chaiwala, round glasses, white mustache, brown vest over kurta) · Kamla (wife, green saree, steel ladle) · Bheem (auto driver) · Pinki (12, newspaper girl, braids, blue pinafore, red cycle) · Biscuit (stray dog, one floppy ear) · Seth Dhanpat (villain, white kurta, gold watch) · Tinku and Pinku (henchmen, tall/short, floral shirts) · Inspector Tiwari (lazy but honest police; plump, mustached, khaki uniform and cap, a bit sweaty, holding chai — **sheet not made yet**).

## Tools

| Job | Tool |
|---|---|
| Images | Nano Banana (Replicate), 16:9 panels from character sheets |
| Animation | Wan 2.7 image-to-video, 5 s |
| Voices | Gemini TTS (`google/gemini-3.1-flash-tts`) |
| Music | A Replicate music model, ~30 s tracks |
| Assembly | ffmpeg script (Part 2): cropping, timing, captions, mixing, compression |

## Reference assets (never regenerate casually)

`cast-lineup.png`, `mitra-sheet.png`, `kamla-sheet.png`, `bheem-sheet.png` (new look), `pinki-sheet.png`, `biscuit-sheet.png`, `dhanpat-sheet.png`, `tinku-pinku-sheet.png`, `stall-sheet.png`. Still to make: `tiwari-sheet.png`.

**Style line** (start of every image prompt):
> Wide 16:9 panel, same anime-influenced cartoon style as the reference images, clean linework, soft cel shading, warm colors, Indian small-town mohalla. Characters must match their reference sheets exactly. Exactly one of each character, no duplicates. No text, no speech bubbles, no signs with writing.

**Shot prompt ending:** "Only these characters. No other people."
**Edit prompt pattern:** "Edit the first image. Keep everything exactly the same. Exactly one of each character. Only change X."
**Wan prompt ending:** "Camera static. Keep the 2D cartoon style, flat colors, no 3D. Ambient sound only, no music, no speech."
**Music kit (current, Bollywood-style):** main theme, emotional clue, villain, comedy chase. (Older Part 1 kit: morning, villain, clue.)
**Voices:** one Gemini voice per character, never changed. Cast for kriya on Oct 25, 2026 (Gemini 3.1 Flash TTS on Replicate, `hi-IN`), kept in the P3 project's `library/`: Mitra **Achird** · Bheem **Alnilam** · Kamla **Zephyr** · Pinki **Callirrhoe** · Tiwari **Rasalgethi** · Tinku **Puck** · Pinku **Sadachbia** · Dhanpat **Algieba** · Driver **Enceladus** · Woman **Despina** · Kids **Leda** · Narrator **Iapetus**.

## The Episode Algorithm (the workflow being automated)

### Phase 0 — Series setup (once)

1. **Style line** locked and pasted at the start of every image prompt.
2. **Cast lineup** image of all characters → `cast-lineup.png`.
3. **Character sheets** (front, side, back, 4 expressions), generated with the lineup attached → `<name>-sheet.png`.
4. **Location sheets**, starting with `stall-sheet.png`; add one when a place appears in 2+ episodes.
5. **Voice cast**: one Gemini TTS voice per character, written down, never changed.
6. **Music kit**: ~30 s original tracks.
7. **Series rules**: brains beat brawn (Bheem never solves the case); characters called by names viewers know.

### Phases 1–7 — per story, per part

```
FOR each story:
    Phase 1  write script, split into Part 1 / 2 / 3
    FOR each part:
        Phase 2  shot list + voice table          (Claude)
        Phase 3  images                            (You, Claude checks)
        Phase 4  clips                             (You)
        Phase 5  voices                            (You)
        Phase 6  assemble + review                 (Claude, You review)
        Phase 7  post as a Reel                    (You)
```

**Phase 1 — Script (once per story).** Pick the next story; write 9 pages split into 3 parts of 3 pages, each ending on a cliffhanger. Continuity check: the villain is never present when a clue is revealed; every name has been introduced; Mitra (not Bheem) solves the case.

**Phase 2 — Shot list and voice table (per part).** 10–13 shots named `P<part>-<nn>`, each with characters, location, action and lines. Pick 4 shots with the biggest motion to animate (🎬). Voice table grouped by character: file name, Hinglish line, emotion, English caption. End-card hook ("Who will come to close the valve? Part 3 tomorrow").

**Phase 3 — Images (Nano Banana).** Prompt = style line + shot prompt + "Only these characters. Exactly one of each." Attach **only** the sheets for that shot's characters plus the location sheet. Generate 3–4, pick the best. Check: right characters, no extras or duplicates, on-model details (Bheem's gamcha, Mitra's glasses), right location, no readable text, story logic. If it fails: one detail wrong → **edit**; unwanted people at the edges → **crop**; composition wrong → **regenerate**. Two shots in a row in the same place → make the second by **editing** the first (if the edit adds duplicates, crop the area first and edit the crop).

**Phase 4 — Clips (Wan 2.7).** For each 🎬 shot, its image is the start frame, 5 s. Prompt: one simple action + the Wan ending. Check faces don't warp and the motion doesn't break the story. Wan's audio is always discarded.

**Phase 5 — Voices (Gemini TTS).** Line by line, one character at a time, saved voice, emotion as the style instruction. Name each file exactly as in the voice table. Redo mispronounced or slow lines (a line over ~8 s makes the Reel drag).

**Phase 6 — Assembly and review.** Build the 1080×1920 Reel: each shot timed to its lines, pan and zoom on stills, crossfades, English captions, music sections ducked under voices, end card, compressed < 30 MB. Watch once with sound, list fixes (a word, a line, a shot); swap files and re-render.

**Phase 7 — Post.** Instagram **+ → Reel** (never a regular post), set the cover frame, "Also share to feed". Caption: one-line hook, part number, a question for comments. Schedule Mon/Wed/Fri, carousel Saturday. Sunday: check watch time, saves, shares, drop-off point; note one thing to change.

## How the phases map to kriya

| Phase | kriya graph / node | Kind | Gate |
|---|---|---|---|
| 0 | Library + series setup | model + screen | Human locks each asset |
| 1 | `story_recipe.script` | model (llm.write) | Continuity checker + human |
| 2 | `part_recipe.shot_list`, `approve_shots` | model + screen | Schema check + human |
| 3 | `shot_recipe.draw`, `pick`, `edit`, `crop` | model + screen + tool | Vision checker → edit/crop/regen |
| 4 | `shot_recipe.animate` (only if `item.animate`) | model (video.from_image) | Vision check on frames → trim/hold/regen |
| 5 | `voice_recipe.speak`, `too_long`, `listen` | model + screen | Duration check + human listen |
| 6 | `part_recipe.assemble`, `watch` | tool + screen | Size/format check + human watch |
| 7 | (later) post checklist | screen | Checklist |

Recipes: `examples/mohalla-mitra/part.yaml`, `shot.yaml`, `voice.yaml`.

## Story 1 — The Tanker Raja: status

| Part | Pages | Status | Length |
|---|---|---|---|
| Part 1: Dry taps | 1–3 | Done: voiced, captioned, original score | 1:12 |
| Part 2: Clues and the plan | 4–6 | Done: voiced, captioned, Bollywood-style score, "Inspector Tiwari" retake | 1:48 |
| Part 3: The trap closes | 7–9 | Not started — **the first episode to make with kriya** | — |

Part 2 shots: P2-01 🎬 Biscuit sniffs the red mud, tanker drives away · P2-02 🎬 Pinki skids up on her cycle · P2-03 Mitra pours Pinki chai · P2-04 Mitra close-up, realizing · P2-05 Tinku and Pinku sneak in · P2-06 Bheem appears behind them with chai · P2-07 (slow zoom on Bheem) · P2-08 🎬 the henchmen flee and crash · P2-09 team huddle, lantern light · P2-10 Bheem's idea · P2-11 Kamla warns Bheem (gamcha missing, kept) · P2-12 🎬 the auto parked on the valve at dawn · P2-13 Mitra lights the stove in the dark.

Part 2 music: main theme (recap) → emotional clue (the clue) → villain (henchmen) → comedy chase (crash) → main theme (the plan) → emotional clue (dawn, end card).

## Open items (series)

- Make Inspector Tiwari's character sheet (needed for Part 3)
- Part 3: shot list, prompts, voice table, assembly — via kriya
- Decide whether to move captions higher (clear of Instagram's UI) for Parts 1 and 2
- Decide whether to redo Part 1's music with the Bollywood kit
- Optional: shorten Part 2 to ~85 s by regenerating P2-04 faster
- Optional: blur the small brand-like badge on the scooter in P2-08
