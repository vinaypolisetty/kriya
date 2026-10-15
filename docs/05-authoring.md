# 05 · Authoring

How creators build and change workflows. The primary user is a **non-technical creator** ([Decision D-06](17-decisions.md)), so the builder speaks in steps and decisions, not nodes and variables. Underneath, everything is the graph from [04-graph-spec.md](04-graph-spec.md).

## Two modes

| Mode | Purpose |
|---|---|
| **Build** | Define a reusable recipe once: levels, Library kinds, steps, conditions, screens |
| **Run** | Use a published recipe: start a story, review, pick, fix, post |

You build Mohalla Mitra once and run it for every story.

## Four ways to author, one set of operations

All four produce the **same graph operations**, so they mix freely (drag a step in, then ask the assistant to configure it):

1. **Forms and clicks**: step cards with plain-language settings.
2. **Drag and drop**: blocks from a palette into the recipe or canvas.
3. **Chat with the builder assistant**: describe what you want; it proposes operations.
4. **Edit the spec**: YAML for technical users.

### Graph operations

| Operation | Example |
|---|---|
| `add_node` | Add "Animate an image" after "Pick one panel" |
| `remove_node` | Remove a step (its runs' outputs are archived, not deleted) |
| `move_node` | Reorder within dependency limits |
| `connect` / `disconnect` | Wire an output to an input |
| `set_config` | Model, prompt, options, trust, context mode |
| `set_condition` | Put a rule on an edge |
| `wrap_in_map` | Make a step run for each item |
| `add_field` | Add `shot.mood` to the shot list output |
| `add_button` | Add a button to a UI action and route it |

Each operation is **validated immediately**, **saved to the draft's history** (undo, redo, branch a draft) and produces the next draft version of the graph JSON.

## Starting a new workflow

Three starting points (never a blank page):
- **Describe it**: "I make a comic series. Each story has 3 parts…" → a drafted recipe to edit.
- **Template**: "Motion comic", "Product ad", "Faceless explainer channel".
- **Import a process doc**: e.g. paste the Episode Algorithm; Claude turns its phases into a draft.
- (Later) **Show it once**: do the process manually with the assistant alongside; it becomes a workflow.

## Authoring step by step (Mohalla Mitra)

1. **Define levels** as an outline:
   ```
   Series   Mohalla Mitra   has many Stories
    Story   Tanker Raja     has 3 Parts       makes: script (9 pages)
     Part   Part 3          has 10–13 Shots   makes: Reel
      Shot  P3-04           —                 makes: panel, clip?, voice lines
   ```
2. **Define Library kinds** (what kinds of things exist and their facets): Character (look, voice, speech style, name rules), Place (look), series-wide style line, music kit, rules. Then fill in instances: Mitra, Bheem, the chai stall.
3. **Build each level's recipe** with step cards. Every card answers six questions:

   | Question | Example: "Draw each shot" |
   |---|---|
   | What does it make? | One image per shot, 16:9 |
   | What does it use? | Shot description, @characters in the shot, @place, @Style |
   | Who does it? | AI: image model |
   | How many options? | 3 |
   | Who checks it? | AI pre-checks, then you pick one |
   | If it's not right? | Edit · Crop · Try again (up to 4), then ask me |

4. **Add conditions** (below).
5. **Test**: click-through with placeholders (free), then a one-shot real test with cost shown. Validation flags problems ("Voices use @Character.voice, but Tiwari has none"; "this loop has no limit").
6. **Publish**: the draft becomes an immutable **release**. Runs pin a release; editing later creates the next one. Runs can be **upgraded** (only changed work is rebuilt).

## Conditions for non-technical creators

Written as When / If → Then sentences, using pickers or free typing:

| Kind | Builder phrasing | Example |
|---|---|---|
| Only sometimes | If ___ then do this step | If the shot is marked *animate* → make a clip |
| For each | Do this for every ___ | For every shot in the shot list → draw it |
| Quality rule | If the result ___ then ___ | If a voice line is over 8 s → redo it faster |
| Wait for | Don't start until ___ | Don't start voices until the shot list is locked |
| Ask me when | Ask me if ___ | Ask me if the checker isn't confident |
| Retry limit | Try up to ___ times, then ___ | Try 4 times, then ask me |
| Same as before | If ___ reuse ___ | Two shots in a row in the same place → edit the first to make the second |

Free typing ("If two shots in a row are in the same place, make the second by editing the first") is converted by the assistant into a rule and shown back as pickers.

**The key that makes conditions possible:** outputs have **fields**, not just files. The shot list is a list of shots with *characters, place, action, lines, animate*. The assistant infers fields from the step's description and shows them as a simple list the creator can add to.

## Configuration layers

**1. Platform catalogs** (creators choose from these):

| Catalog | Defines |
|---|---|
| Node kinds | Each kind's settings, as a schema → the builder generates the settings form |
| Capabilities | Input/output types, e.g. `image.generate`: text + images → image |
| Providers and models | Which models offer each capability, their parameters |
| Review styles | pick_one, approve, fix_area, listen, edit_text, form |
| Tools | crop, compress, assemble_reel, … |
| Fix actions | edit, crop, retry, regenerate with note |

A new model or node kind added to the catalog appears in every builder automatically.

**2. Typed wiring.** The "What does it use?" picker only offers compatible things: matching upstream outputs, fields of the current item, Library facets of the right kind (`@Bheem · look` for image inputs, `@Bheem · voice` for voice steps). Creators can't wire something that won't run.

**3. Layered defaults:**
```
Platform default → Project default → Level → Node → This run / this action
```
Set the image model once per project; steps inherit unless overridden. Changing a project default marks only inheriting steps as changed in the next release.

## Drag and drop

| Drag | Onto | Operation |
|---|---|---|
| Block from the palette (AI step, **UI action**, logic, tool, custom block) | Between two steps | `add_node` + auto-connect |
| A step | Up/down in the recipe | `move_node` (if dependencies allow) |
| A step | Into a "For each shot" box | `wrap_in_map` |
| Library item (@Bheem) | A step | Adds it as an input (same as @mention) |
| A step's output | Another step's input (canvas) | `connect` |
| Condition chip ("Only if…") | An arrow | `set_condition` |
| Image/audio file from the computer | Library or a step | Upload as asset or reference |
| A saved custom block | Any recipe | Inserts that subgraph |

Rules: only valid drop zones light up (an image step only where an image input fits; invalid drops explain why); dropping between steps **auto-wires** matching inputs/outputs and asks once if ambiguous; every drop is one undoable change; the assistant can configure what you just dropped ("set this one up for me"); **every drag has a non-drag alternative** (Move up, Add after, Add input) for phones, keyboards and screen readers.

Where: **recipe view** (default; list-style dragging) and **canvas view** (free boxes and arrows, for branching flows; React Flow).

### UI actions are blocks

The palette has a **UI actions** group: Pick one, Approve or redo, Fix an area, Listen and approve, Edit text, Fill a form. A UI action's settings panel shows: what to show, what to show beside it, a table of **buttons → what each needs → which step it goes to**, who decides (Ask me / Decide when confident), "review all items on one screen", "AI pre-checks first", and **Preview this screen**. On the canvas, each button is its own outgoing arrow.

## The builder assistant (chat whenever stuck)

Always one click away, in Build mode and mid-run. **It can only do what clicks can do**: its tools are the graph operations above, plus read tools (inspect graph, catalog, Library, run history), validation and dry-run.

Example:

> **You:** I want the music to change when the villain shows up, but I don't know how.
>
> **Assistant:** Each shot gets a "mood" field. A new step picks the music section per shot from your Music kit, and assembly switches tracks when the mood changes.
> ```
> + field   shot.mood (calm · clue · villain · comedy)     on: Break it into shots
> + step    Pick music per shot   uses @MusicKit, shot.mood  after: Break it into shots
> ~ config  Assemble: switch tracks on mood change, crossfade 1s
> ```
> Extra cost per episode: $0. **[Apply] [Change something] [Discard]**

Proposed steps appear **highlighted in the recipe** before you accept. Apply = one undoable entry.

| You say | It does |
|---|---|
| "Add a step / change this / make it ask me first" | Proposes operations as a change set |
| "Why did P3-07 skip animation?" | Reads graph + run log: "the condition needs animate = yes; the shot list marked it no" |
| "This keeps failing" | Reads failures; proposes a prompt patch, checker rule or retry setting |
| "What's this step for?" | Explains, including which conversation added it and why (change sets keep their originating chat) |
| Builder shows an error | Offers a fix in place: "This loop has no limit. Set it to 4?" |

It offers help proactively when you seem stuck (an unfixed validation error, repeated undo, a step that keeps failing).

**Mid-run:** the change goes into a new draft of the recipe, not the running episode. Choose **just this episode** (an episode override) or **the recipe** (publish, then upgrade this run; only affected work goes stale, plan and cost first).

**Missing building block:** (1) **compose** it from existing blocks and save as a custom block (e.g. thumbnail = pick a frame + add title + resize); (2) **find a model** on a connected provider and add it to the catalog; (3) **can't be done**: say so plainly, log a feature request, never fake it.

Guarantees: the assistant **writes the graph, it doesn't run inside it** (chatting never changes how a published recipe executes); it asks one question with options when unclear; nothing is applied without approval.

The authoring experience is itself built on the platform: the author agent drafts, a screen shows the diff, the creator approves or refines, like locking a version of a shot. Recipes are just versioned outputs with branches and locks.

## Learning from runs

When runs keep failing at a step, or the creator keeps making the same choice at a screen, the platform suggests a change to the recipe: "You've rejected Wan clips with camera moves 6 times. Add 'Camera static' to the prompt?"

```
describe / draw / edit → validate → dry run → cheap test → publish
          ▲                                                   │
          └─────── learn from runs: failures, edits, KB ──────┘
```
