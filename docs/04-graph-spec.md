# 04 · Graph spec

The recipe file format. Source of truth: `packages/engine/src/spec.ts` (Zod). This page explains each field.

Recipes are YAML (or JSON). One file holds one graph. A folder of graphs is a **bundle**; `map` and `subgraph` nodes refer to other graphs in the bundle by name.

## Graph

```yaml
graph: part_recipe          # unique id in the bundle, lower_snake_case
level: part                 # the level this graph runs at (creator-defined)
description: Turn three story pages into a finished Reel.
inputs:                     # what the graph receives
  story_pages: text
  part_no: number
types:                      # record types used by fields
  shot:
    fields: { id: text, characters: list<text>, place: text, animate: boolean }
outputs:                    # what the graph returns, by reference
  reel: assemble.reel
nodes: [ ... ]              # at least one
edges: [ ... ]
```

| Field | Required | Notes |
|---|---|---|
| `graph` | yes | Id, `lower_snake_case`, unique in the bundle |
| `was` | no | Ids this recipe had before it was renamed. Runs started under an old id still open, list and carry on under the new one, and a for-each naming an old id still finds it. Each must be free: no recipe's id now, no other recipe's old id ([D-78](17-decisions.md)) |
| `level` | yes | Any id; levels are creator-defined |
| `description` | no | Shown in the builder |
| `inputs` | no | Map of field → type |
| `types` | no | Named record types: `{ fields: { name: type } }` |
| `outputs` | no | Map of output name → reference (`node.field`) |
| `nodes` | yes | List of nodes (see below) |
| `edges` | no | List of edges (see below) |
| `inherits` | no | Higher levels whose locked context the recipe reads, e.g. `[series]` → `series.style`. The run must be started with that context ([D-47](17-decisions.md)) |

## Types

`text`, `number`, `boolean`, `image`, `audio`, `video`, `file`, `json`, any declared type name, `library.<kind>` (the name of something in the Library, e.g. `place: library.place`, `characters: list<library.character>`), or `list<…>` of any of those. Undeclared types are a validation error with a suggestion. A model writing a `library.<kind>` field can only use names that kind has in the Library (its answer's schema lists them), so a shot list can't invent "Reservoir valve, morning" when the Library has "Reservoir valve" ([D-70](17-decisions.md)).

## References

A reference names where a value comes from:

| Form | Meaning |
|---|---|
| `shot_list.shots` | Locked output field of another node in this graph |
| `item.action` | Field of the current item (inside a graph run by `map`) |
| `item.characters@look` | The `look` facet of each Library asset named in `item.characters` |
| `series.style`, `story.pages`, `project.rules` | Locked context inherited from a higher level |
| `inputs.part_no` | A graph input |
| `pick.note`, `pick.selected` | What a human submitted on a screen |

The validator checks that the root of a reference is a node in the graph or a known built-in scope (`item`, `inputs`, `series`, `story`, `part`, `project`, `assets`, `run`).

## Nodes

Common fields on every node: `id` (required, unique, lower_snake_case), `kind` (required), `name` (label in the builder), `description`.

Unknown fields are **errors** (schemas are strict), so typos don't pass silently.

### `model`: one model call

```yaml
- id: draw
  kind: model
  name: Draw the shot
  capability: image.generate     # what it does; provider chosen by config
  model: replicate:google/nano-banana@<version>   # optional override
  prompt: |
    {{series.style}}
    {{item.action}}
    Only these characters. No other people.
  uses: [item.action, item.characters@look, item.place@look, series.style]
  options: 3                     # candidates per attempt (1–8)
  context: full                  # full | local | isolated
  trust: ask_me                  # ask_me | when_confident | always
  out: { image: image }
```

| Field | Default | Notes |
|---|---|---|
| `capability` | — | `domain.action`, e.g. `image.generate`, `image.edit`, `video.from_image`, `audio.speech`, `audio.music`, `llm.write`, `llm.vision` |
| `model` | project default | Pinned provider model, overrides the project default |
| `prompt` | — | Template; `{{ref}}` placeholders are references |
| `uses` | `[]` | References to resolve into the call (text, images, audio) |
| `options` | 1 | Number of automatic candidates. Claude steps tell each one which take it is, so they differ ([D-81](17-decisions.md)) |
| `context` | `full` | See [06-context-and-assets.md](06-context-and-assets.md) |
| `trust` | `ask_me` | Autonomy for downstream decisions |
| `out` | `{}` | Typed output fields |

### `agent`: a model with tools, looping until done

```yaml
- id: fix_panel
  kind: agent
  goal: Make the panel pass the rubric with the fewest changes.
  tools: [image.edit, crop, vision_check, ask_user]
  max_turns: 8                 # default 8; any positive number
  budget: { usd: 2 }           # optional spend cap for the whole run
  context: local
  out: { image: image }
```

Agents may only call the tools listed. Each turn is recorded. (Decision: explicit tool lists for safety and cost.)

`max_turns` has no fixed ceiling, so long-running agents are possible. The agent stops at whichever limit it hits first: turns or budget. Above 50 turns without a `budget`, the validator warns, because turns alone don't bound cost. ([Decision D-27](17-decisions.md))

### `tool`: run code

```yaml
- id: assemble
  kind: tool
  tool: assemble_reel
  uses: [shot_list.shots, shot_list.lines, per_shot.panel, per_shot.clip, voices.audio, series.music]
  args:
    shots: shot_list.shots     # an arg naming one of the step's uses gets its value
    panels: per_shot.panel
    clips: per_shot.clip
    voices: voices.audio
    music: series.music
    max_mb: 30                 # anything else is passed as written
  out: { reel: video, seconds: number }
```

A tool step takes `uses` like a model step (D-62). Built-in tools: `crop` (refines an image step; the region marked on the screen), `compress` (`video`, `max_mb`; fills `mb` and `seconds` if declared) `assemble_reel` (`shots`, `lines`, `panels`, `clips`, `voices`, `hook`, `music`, `title`, `max_mb`), and for cutting into a video you already have (D-80): `extract_frames` (`video`, `every` seconds, `width`; fills `frames: list<image>`, `times`, `seconds`), `stills` (`video`, `items` with a time `t` each; adds a full-size `frame` to each), `attach` (`items`, plus any values to copy onto each item, so a for-each item carries what it needs) and `insert_caricatures` (`video`, `moments`, `caricatures`, `layouts`, `subjects`, `captions`, `hold`).

### `screen`: a UI action (human decision)

```yaml
- id: pick
  kind: screen
  name: Pick one panel
  review: pick_one        # pick_one | pick_many | approve | fix_area | listen | edit_text | form
  show: draw.image        # what to render (images → grid, audio → players, video → player)
  beside: [item.action, item.lines, item.characters]
  batch: true             # review all items of the map on one screen
  trust: ask_me           # or when_confident: an AI judge may decide when confident
  actions:                # buttons; each is a value of `action` that edges route on
    - { id: lock,  needs: [selection], locks: true }   # this button locks the picked version of `draw`
    - { id: edit,  needs: [selection, note] }
    - { id: crop,  needs: [selection, region] }
    - { id: retry, needs: [note] }
```

The screen is **generated** from `review` + `show` + `actions`; creators never lay it out. `needs` declares what the submission must include; the engine validates it before continuing.

Submission recorded in context as: `pick.action`, `pick.selected`, `pick.note`, `pick.region`. Inside edges from the screen, `action` refers to the submitted button. `pick.selected` is the shown field of the chosen version (with `show: draw.image`, the image itself), not a version id.

**Who locks a step** ([D-42](17-decisions.md)):

| Step | Locked by |
|---|---|
| `tool` no screen shows | Itself, automatically (code output) |
| `model` / `agent` with `trust: always` | Itself, automatically |
| A step some screen `show`s (even a tool) | That screen, when a button with `locks: true` is pressed: the selected version, or the only candidate of the latest attempt |
| Any other `ask_me` / `when_confident` step | A **generated approval** screen ("Approve 'Animate the shot'"). `when_confident` asks too until checkers exist |

The creator's note on a locking button is kept as the lock's `why` (D-29).

### `check`: judge every candidate (Day 20, D-63)

Model and tool steps can check what they make, before anyone sees it:

```yaml
- id: draw
  kind: model
  capability: image.generate
  options: 3
  check:
    rubric:                        # an LLM judge looks at each image (or reads written work); it passes only if every rule holds
      - Every listed character appears, and each looks like their description.
      - Only the listed characters appear; no extra people.
    # limits on number outputs are code checks, e.g. on a voice step: seconds: { max: 8 }
```

Each check records a verdict on each candidate: pass, or issues, each with a `fix` (`crop`, `edit` or `retry`). Screens show them. `trust: when_confident` locks the first candidate that passed (it asks when none did). An edge can route on `verdict.pass` (and `verdict.issues`) like `result`. A rubric on a step that makes images is judged by looking at them. On written work (text, numbers, lists, declared types) the judge reads the candidate against what the step was given, so "every number appears in the release" can be checked; its fixes are `edit` or `retry` ([D-73](17-decisions.md)). The judge can't listen or watch: a step making audio or video limits a number instead (`seconds: { max: 8 }`). A limit needs a number output.

A screen with `trust: when_confident` follows its candidates' checks for up to 3 rounds (Day 21, D-64): it locks a candidate that passed, or presses the fix the knowledge base suggests (`crop` with the area the judge says to keep, `edit` with the rule's wording, or `retry` with every issue as the note). Its decisions are recorded `by: auto`. Any other screen shows the suggestion in the inbox.

### `refines`: make versions of another step

A `model`, `agent` or `tool` step can **refine** another step in the same recipe: its output becomes that step's next version instead of its own ([D-44](17-decisions.md)).

```yaml
- id: edit
  kind: model
  capability: image.edit
  refines: draw          # the edited panel is draw's version 2.1, parent 1.3
```

The new version records its parent (what the reviewing screen last selected, else the locked or newest version), the instruction (that screen's note, e.g. "add the gamcha"), and which step made it. A screen showing `draw` then shows the edit. The refining step's outputs must be outputs of the refined step, with the same types.

The executor gets `parent` (the version it starts from) and `instruction`. The same two fields drive `replay_change`, which re-applies a version's instruction onto other items ("the same gamcha fix on every shot with Bheem").

### `map`: run a graph once per item

```yaml
- id: per_shot
  kind: map
  over: shot_list.shots   # list to iterate: a step's locked output, or this recipe's inputs.filings / item.lines
  graph: shot_recipe      # graph to run per item
  key: id                 # stable item key (default: id)
```

`over` reads a list from a step's locked output, or from the recipe's own inputs: `inputs.filings` at the top, `item.lines` inside another map ([D-73](17-decisions.md)). A list of plain names (`["AAPL", "MSFT"]`) works too: each name is its own key and the child sees it as `item`. And `over: find`, naming another map, goes through that map's results: one row per item, its outputs side by side, its key as `id` ([D-74](17-decisions.md)). Inputs were recorded when the run (or the item) started, so either way the map reads recorded data.

The child graph sees the item as `item`. Child instances are keyed by `item.<key>` so they survive list regeneration: the steps of shot P3-04 are `per_shot[P3-04].draw`, `per_shot[P3-04].pick`, …. Keys use letters, digits, `-` and `_`, and must be unique in the list.

Each item moves on as soon as its own steps finish. The map step finishes when **every** item has; if any item didn't finish, the map fails and names the items, so nothing downstream runs on a partial set.

**What later steps see** ([D-41](17-decisions.md)): for each output the child graph declares, one list in the order of the source list, with `null` where an item produced nothing. With `shot_recipe`'s `outputs: { panel, clip }`:

```
per_shot.panel   → [panel 1, panel 2, …, panel 13]
per_shot.clip    → [clip, null, null, clip, …]    # still shots have no clip
per_shot[P3-04].clip   → one item's output
```

### `subgraph`: run a graph once (or `count` times)

```yaml
- id: parts
  kind: subgraph
  graph: part_recipe
  count: 3
```

## Edges

```yaml
edges:
  - { from: draw, to: pick }
  - { from: pick, to: draw, when: "action == 'retry'", max_loops: 4 }
  - { from: [per_shot, voices], to: assemble, wait: all }
  - { from: pick, to: END, when: "action == 'lock' and item.animate == false" }
```

| Field | Notes |
|---|---|
| `from` | A node id, or a list for joins |
| `to` | A node id or `END` |
| `when` | Condition (below). No `when` = always |
| `max_loops` | Required on any edge that closes a cycle (1–20) |
| `wait` | For joins: `all` (default) or `any` |

**Start nodes** are nodes with no incoming edge, ignoring loop-back edges (those with `max_loops`).

## Conditions

Grammar:

```
expr    := or
or      := and ('or' and)*
and     := not ('and' not)*
not     := 'not' not | cmp
cmp     := operand (('=='|'!='|'<'|'<='|'>'|'>=') operand)?
operand := path | 'string' | "string" | number | true | false | null | '(' expr ')'
path    := name ('.' name)*
```

- Paths read recorded data only: node outputs, screen submissions (`action`, `pick.note`), the current item, inherited context.
- `<step>.<field>` always means that step's **locked** output. `result.<field>` means the candidate the edge's own source step **just made**, before anyone locks it: route on a fresh draft (`when: "result.seconds > 8"`) without waiting for review ([D-43](17-decisions.md)). `result` needs a single candidate: not on screens, maps or joins, or a step with `options` > 1. `verdict` is what that candidate's checks said (`when: "not verdict.pass"`); its step needs a `check:`.
- Missing paths evaluate to `undefined` (never throw).
- No function calls, assignment, clock or randomness. Parse errors are reported with the reason.

In the builder, creators write conditions as sentences ("Only if the shot is marked animate"). Each condition is stored with both forms:

```json
{ "said": "Only if the shot is marked animate", "rule": "item.animate == true" }
```

The engine executes only `rule`. (YAML recipes may omit `said`.)

## Validation rules

Implemented in `validate.ts`. Errors block publishing; warnings don't.

| Rule | Severity |
|---|---|
| Schema: required fields, types, strict keys, id format | error |
| Duplicate graph or node ids | error |
| Edge endpoints must be nodes (with "did you mean") | error |
| `map` / `subgraph` must point at an existing graph; a graph can't map over itself | error |
| A graph a `map` runs has one input, `item`; any other input it declares would always be empty | error |
| References in `uses`, `show`, `beside`, `{{prompt}}`, `over` and `outputs` must start at a step, a built-in scope (`item`, `inputs`, `run`, `assets`) or an inherited level; a known level that isn't inherited gets "add inherits: [series]" | error |
| Field types must be primitives or declared types | error |
| Conditions must parse | error |
| `action == 'x'` on an edge from a screen must name one of its buttons | error |
| `result` only on an edge from one model, agent or tool step that makes a single candidate | error |
| A screen that `show`s a step with no `locks: true` button | warning |
| Every cycle must pass through an edge with `max_loops` | error |
| There must be at least one start node | error |
| A screen button that no edge handles | warning |
| A node unreachable from the start | warning |
| A join without `wait` (defaults to `all`) | warning |

Planned: type-checking connections (an image can't feed an audio input), required-asset checks (blocks when a referenced facet is missing), cost estimates.

## Stored form (builder)

When authored in the builder, every node, field and condition also gets a **stable id** (e.g. `step_7f3a`, `cond_91e0`) so renames never break references, runs or locks. See [08-persistence.md](08-persistence.md).
