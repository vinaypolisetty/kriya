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
| `kriya inbox` | Everything waiting on you, across runs |
| `kriya decide <item> <button> [--pick v] [--note text] [--region x,y,w,h]` | Answers an inbox item, by number or `run:step` |
| `kriya lock <run> <step> <version> [--why text]` | Locks a version yourself and lists what went stale |
| `kriya rebuild <run>` | Redoes stale work from its earliest step; unchanged items are kept |
| `kriya adopt <run> <step> <base> <from> --note text` | Makes a new version from `base`, taking what the note says from `from` (two parents, D-30). It waits for you to lock it |

## How it behaves

- **Every command is its own process.** Runs live in `.kriya/kriya.db`; close the terminal mid-episode and carry on tomorrow. Each command replays the run and calls `recover()` first, so a crash never loses work or pays twice (D-46).
- **Models are fake** (`models: fake` in `kriya.yaml`) until real providers arrive on Day 15: made-up outputs from each step's declared types, no keys, no cost. Missing Library facets are faked too.
- **`kriya.yaml`** holds the project's name, the inherited context (e.g. `series: { style, rules, cast }`) and, until the Library (Day 18), facet values as `Entity.facet: value`.
- **Errors are plain words**, including recipe problems ("'capabilty' isn't a setting for a model step. Did you mean 'capability'?").
