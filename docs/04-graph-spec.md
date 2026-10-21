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
| `level` | yes | Any id; levels are creator-defined |
| `description` | no | Shown in the builder |
| `inputs` | no | Map of field → type |
| `types` | no | Named record types: `{ fields: { name: type } }` |
| `outputs` | no | Map of output name → reference (`node.field`) |
| `nodes` | yes | List of nodes (see below) |
| `edges` | no | List of edges (see below) |

## Types

`text`, `number`, `boolean`, `image`, `audio`, `video`, `file`, `json`, any declared type name, or `list<…>` of any of those. Undeclared types are a validation error with a suggestion.

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
| `options` | 1 | Number of automatic candidates |
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
  args: { aspect: "9:16", max_mb: 30, captions: english, music: duck_under_voices }
  out: { reel: video }
```

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
| `tool` | Itself, automatically (code output) |
| `model` / `agent` with `trust: always` | Itself, automatically |
| A step some screen `show`s | That screen, when a button with `locks: true` is pressed: the selected version, or the only candidate of the latest attempt |
| Any other `ask_me` / `when_confident` step | A **generated approval** screen ("Approve 'Animate the shot'"). `when_confident` asks too until checkers exist |

The creator's note on a locking button is kept as the lock's `why` (D-29).

### `map`: run a graph once per item

```yaml
- id: per_shot
  kind: map
  over: shot_list.shots   # list to iterate
  graph: shot_recipe      # graph to run per item
  key: id                 # stable item key (default: id)
```

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
- `<step>.<field>` always means that step's **locked** output. `result.<field>` means the candidate the edge's own source step **just made**, before anyone locks it: route on a fresh draft (`when: "result.seconds > 8"`) without waiting for review ([D-43](17-decisions.md)). `result` needs a single candidate: not on screens, maps or joins, or a step with `options` > 1.
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
| References must start at a node or a built-in scope | error |
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
