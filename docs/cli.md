# The kriya command line

For building and testing kriya, and for running episodes before the web inbox exists (Day 22). Creators won't need it.

## Set up once

```bash
pnpm install
alias kriya="$PWD/bin/kriya"     # or add bin/ to your PATH
```

## A whole episode

```bash
kriya init p3 --example mohalla-mitra      # kriya.yaml, recipes/, .gitignore
cd p3
kriya run part_recipe --input part_no=3 --input story_pages=@pages-7-9.txt
kriya inbox                                # what's waiting on you, numbered
kriya decide 1 approve                     # answer item 1
kriya decide 1 edit --pick 1.3 --note "add the gamcha"
kriya decide 1 lock                        # one option on show: no --pick needed
kriya status part_recipe-1                 # every step, in recipe order
kriya lock part_recipe-1 "per_shot[S1].draw" 1.1 --why "the first one was better"
```

## Commands

| Command | Does |
|---|---|
| `kriya init <folder> [--example <name>]` | Starts a project; `kriya init --examples` lists the examples |
| `kriya run <recipe> [--input name=value]… [--id name]` | Starts a run. `@file` reads a value from a file |
| `kriya status [run]` | All runs, or one run's steps |
| `kriya show <run> [step] [version]` | What a run made: every step with its versions, model and cost; or one step's full output (YAML), with an agent's turns and tool calls |
| `kriya inbox` | Everything waiting on you, across runs |
| `kriya decide <item> <button> [--pick v] [--note text] [--region x,y,w,h]` | Answers an inbox item, by number or `run:step` |
| `kriya lock <run> <step> <version> [--why text]` | Locks a version yourself and lists what went stale |
| `kriya rebuild <run>` | Redoes stale work from its earliest step; unchanged items are kept |
| `kriya retry <run> <step>` | Tries a failed step again as a new attempt (a refusal, a bad key, a rate limit). Failed maps around it run again and keep their finished items; naming a failed map retries its failed items. `kriya status <run>` prints the command for each failure |
| `kriya web [--port 4317]` | The review inbox in your browser (build it once: `pnpm --filter @kriya/web build`). Click an item to open its screen: pick a candidate (each shows what its checks found), write a note, press its buttons, or "Use suggestion". Live: anything that changes a run, here or in a terminal, shows up at once. Reading never calls a model; a decision is recorded at once and the run carries on in the background |
| `kriya check <run> <step>` | Judges a step's latest candidates against its rubric again (e.g. after you changed the rubric) and records the verdicts; locks don't move |
| `kriya library [entity]` | The Library by kind: each entity's facets with their version, what its kind still needs, files that aren't there; or one entity's facets with every version |
| `kriya adopt <run> <step> <base> <from> --note text` | Makes a new version from `base`, taking what the note says from `from` (two parents, D-30). It waits for you to lock it |

## How it behaves

- **Every command is its own process.** Runs live in `.kriya/kriya.db`; close the terminal mid-episode and carry on tomorrow. Each command replays the run and calls `recover()` first, so a crash never loses work or pays twice (D-46).
- **Models**: `models: fake` in `kriya.yaml` (the default) makes up outputs from each step's declared types, no keys, no cost. Real providers are chosen per kind of step, and kinds left out stay fake:
  ```yaml
  models:
    llm: anthropic     # text (llm.write), vision (llm.vision) and agents → Claude; key ANTHROPIC_API_KEY
    image: replicate   # image.generate, image.edit → Nano Banana 2; token REPLICATE_API_TOKEN
    video: replicate   # video.from_image → Wan 2.7 image-to-video
    audio: replicate   # audio.speech → Gemini 3.1 Flash TTS; audio.music → Lyria 2
  ```
  (`models: anthropic` is short for `{ llm: anthropic }`.) Keys go in `.env` at the project root. Images need their looks in the Library, and voices their voice (see **The Library** below). Per capability:
  ```yaml
  replicate:                       # optional, per capability; a step's own model: and params: win
    image.generate: { model: google/nano-banana-2, params: { resolution: 1K, output_format: png } }
    video.from_image: { params: { resolution: 720p } }   # $0.10 a second instead of $0.15
    audio.speech: { params: { language_code: hi-IN } }
  ```
  A clip starts from the one image its step uses (the locked panel). A voice step's prompt is the words to say; the speaker's `@voice` picks the voice, and everything else it uses (the line's emotion, `@speech`, the voice's words) says how, followed by any style the step gives in `params`. Clips and audio are measured from their bytes, so `out: { seconds: number }` gets the real length. Any Replicate model works: name its input `fields:` (`prompt`, `images`, `voice`, `style`) if they differ, and its `price_usd` or `price_per_second_usd`. `kriya show` prints the prompt and references each version got, copies images, clips and audio to `.kriya/view/` and prints the paths to open. Optional `claude: { model, effort }` sets the defaults (`claude-opus-5-5`, `high`); a step can pin its own `model:`. Commands wait while Claude works (`⏳ waiting on Claude…`); if you close the terminal, the next command asks again. The key is needed only when a step actually calls Claude: without one, that step doesn't start (add the key and run any command to carry on), and `status` / `inbox` still work. Missing Library facets are faked too. A fake agent calls its first tool once, then answers; fake tools just echo what they were asked. Tool results are kept in `.kriya/blobs/`. An agent's `ask_human` question shows in `kriya inbox`; answer it with `kriya decide <n> reply --note "…"`.
- **The fix loop**: `kriya inbox` shows what the checks suggest, as a command to copy (`suggested: 1.2 is closest: … kriya decide 1 edit --pick 1.2 --note "…"`). A screen with `trust: when_confident` presses it itself for up to 3 rounds (locks a panel that passed, or crops, edits or retries), then asks you; `kriya show` marks those decisions and locks `auto`.
- **Checks**: a step's `check:` (a rubric for a Claude judge, limits on numbers) runs on every candidate; `kriya inbox` shows `✓ checks passed`, or `✗` with each issue, where it is and the fix. With fake models the judge passes everything; code limits always run for real.
- **Tools** (`crop`, `compress`, `assemble_reel`) are fake by default. To run them here with ffmpeg:
  ```yaml
  tools:
    python: ~/mitra/.venv/bin/python   # runs the Reel assembler; needs Pillow (default python3)
    font: fonts/Poppins-Bold.ttf       # captions and the end card
  context:
    series:
      music: { main: music/main-theme.mp3, villain: music/villain.mp3 }   # by cue; each shot's `music` picks one
  ```
  `kriya decide <n> crop --pick 1.2 --region 0.1,0,0.8,1` crops a panel (fractions of the image, or pixels); the crop becomes the panel's next version. `assemble_reel` times each shot to its voice lines, pans over stills, plays clips and holds their last frame, adds captions (`caption_en`) and an end card (the hook), ducks the music under the voices, and keeps the copy under `max_mb`. Tools cost nothing and are recorded as `local:<tool>`.
- **`kriya.yaml`** holds the project's name, the models, the tools, the inherited context (e.g. `series: { style, rules, cast }`) and the Library's `kinds:`.
- **The Library** is the `library/` folder: one YAML file per character, place or track, with its `name` (what recipes use, like `item.speaker`), its `kind`, and its facets (D-61):
  ```yaml
  # library/mitra.yaml
  name: Mitra
  kind: character
  look:
    image: sheets/mitra-sheet.png    # a file in the project
    words: a thin 60-year-old bald man with white side hair, round glasses, brown vest over white kurta
  voice: { voice: Charon, words: calm and dry, unhurried }   # or just `voice: Charon`
  speech: Hinglish; calls everyone beta
  ```
  A facet is words, a file (image, audio or video), or an object holding either; words alone draw a minor character or a place without a sheet. `kinds:` in kriya.yaml (`character: [look, voice, speech, rules]`, `place: [look]`, `music: [track]` in a new project) catches typos (`lok` → "Did you mean 'look'?") and makes `kriya library` list what each entity still needs. Recipes ask for facets by name: `item.speaker@voice`, `item.characters@look`. A facet missing from the Library (or naming a file that isn't there) blocks the step instead of drawing a stranger; in fake mode it's made up. Any change to a facet (a sheet redrawn in place, a new voice) is a new version: the work that used it goes stale (`kriya status` says "Mitra's voice changed"), and the old version, file included, is kept in `.kriya` (`kriya library Mitra` lists them).
- **A run is pinned to its recipes**: the recipe it runs and every recipe its maps run. Editing one of those shows `recipes changed` on the run; adding or editing other recipes doesn't.
- **Errors are plain words**, including recipe problems ("'capabilty' isn't a setting for a model step. Did you mean 'capability'?").
