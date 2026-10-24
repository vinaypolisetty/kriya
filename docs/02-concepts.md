# 02 · Core concepts

This page defines the vocabulary. Later docs go deeper on each part.

## The shape in one picture

```
Project: Mohalla Mitra                       ← level (top), holds the Library and templates
 └─ Story 1: Tanker Raja                     ← level, created from the "story" template
     └─ Part 3                               ← level, runs part_recipe
         ├─ shot_list        (node)          ← a step: model, agent, tool, screen, map, subgraph
         ├─ approve_shots    (node, screen)  ← a UI action: a human decides
         ├─ per_shot         (node, map)     ← runs shot_recipe once per shot
         │    └─ Shot P3-04                  ← level, runs shot_recipe
         │         ├─ draw   → versions A, B, C        (3 automatic candidates)
         │         ├─ pick   → you choose C, ask for an edit
         │         ├─ edit   → C2 🔒 locked             (only this flows on)
         │         └─ animate (only if shot.animate)
         ├─ voices           (node, map)
         ├─ assemble         (node, tool)
         └─ watch            (node, screen)
```

Three nested structures:

1. **Levels**: a tree of scopes (project → story → part → shot). Creators define their own levels.
2. **Graphs**: each level runs a graph of nodes and edges, created from a template.
3. **Version trees**: each node instance holds a tree of versions; one is locked.

## Levels

- A **level** is a scope with its own graph. Examples: series, story, part, shot, line. A channel → series → episode → shot setup is equally valid.
- Levels are **creator-defined**. Project/episode is only the starting template. ([Decision D-07](17-decisions.md))
- A node of kind `map` or `subgraph` **expands** into a lower level: `per_shot` creates one shot level per item in the shot list.
- Each level **inherits the locked context of the levels above it**. Every shot sees the locked cast sheets and style line without anyone attaching them.

## Nodes and step kinds

A node is one step. To the engine, all nodes are the same thing: a step that takes input, may take a long time, and produces output. They differ only in **who decides what happens next**:

| Kind | Who decides next | Typical use |
|---|---|---|
| `model` | The graph | One model call: write, draw, animate, speak |
| `agent` | The model, within listed tools and a budget | Choose and apply a fix; research; plan |
| `tool` | Nobody: runs code and returns | Crop, compress, assemble the Reel |
| `screen` | A human (a **UI action**) | Pick one, approve, fix an area, listen |
| `map` | The graph, once per item | Per shot, per voice line |
| `subgraph` | The graph, once | Story → its 3 parts |

Any kind can contain or call the others: a workflow includes an agent; an agent's tools include workflows and screens ("ask the user which looks more like Bheem"); a screen's button starts a workflow. A saved workflow becomes a tool other workflows can use.

### The single runtime primitive

```ts
interface Step {
  run(ctx: Context): Promise<Completed | Spawn | Suspend>;
}
// Completed(output)          → recorded; outgoing edges are evaluated
// Spawn(children)            → engine runs children, resumes this step with their results
// Suspend(waitingOn: Ticket) → parked until a model job, a human action or a timer resolves it
```

A workflow node spawns the next nodes along its edges. An agent spawns one child per tool call and resumes for its next turn. A screen suspends until the human submits.

## Edges and conditions

- **Edges** carry the logic: `when` (a condition), `max_loops` (required on any edge that closes a loop), `wait: all|any` (joins).
- **Conditions** are a small safe language that only reads recorded data: `action == 'redo'`, `item.animate == true and attempts < 4`. No function calls, no clock, no model calls. ([09-determinism.md](09-determinism.md))
- A screen's **buttons are its outgoing edges**: `pick → edit when action == 'edit'`.

## Candidates vs branches

Two kinds of "multiple", and they work differently ([Decision D-04](17-decisions.md)):

| | **Candidates** (automatic) | **Branches** (explicit) |
|---|---|---|
| Where | Declared in the node config (`options: 3`) | Created by the user mid-conversation |
| Example | 3 images per shot | "Branch off: try a darker ending" |
| Trigger | The engine, every time | The user says "branch off" or clicks Branch |
| What they are | Parallel outputs from one request | A separate path with its own conversation history |
| Lifetime | Pick one; the rest leave context | Saved, named, resumable; parked when another is locked |

## Versions and locks

- Every output is a **version** in the node's **version tree**, with parents, prompt, inputs, model version and verdicts.
- **Refine** creates a child version ("make the villain funnier" → A2).
- **Adopt** creates a version with two parents ("take A2 but use the darker branch's ending").
- **Replay change** re-applies the instruction that produced a version somewhere else (another branch, or every shot with Bheem). Both create new candidates; neither touches the source or moves a lock.
- **Lock** marks one version as the node's output. Only the locked version, plus the locked context from above, crosses node boundaries.
- Siblings **vanish from context, not from history**: they stay in the tree, so you can unlock and lock another later.

Details: [07-versions-branches-locks.md](07-versions-branches-locks.md).

## Context

What a node sees:

```
context(node) = locked outputs from upstream nodes
              + locked context inherited from higher levels
              + assets the node picks up automatically (by facet)
              + assets @mentioned explicitly
              − anything the user removed
```

Three **context modes** ([06-context-and-assets.md](06-context-and-assets.md)):

| Mode | Uses | Default for |
|---|---|---|
| Full | Automatic defaults from all levels + mentions | Generating (new shot, script, voice line) |
| Local | The version it edits + its own declared inputs (`uses`, prompt refs) + mentions; no automatic defaults ([D-55](17-decisions.md)) | Edits and refinements (steps that `refines`) |
| Isolated | Only what the user explicitly gives it | Experiments |

## Assets and facets

- The **Library** holds entities: characters, places, style, voices, music kit, rules.
- Each entity has **facets** for different kinds of steps: `@Mitra · look` (images), `· voice` (TTS), `· speech` (scripts and voices), `· rules` (scripts).
- Nodes pull the facets that match their kind automatically; users can @mention any asset, facet, locked node output or pinned version, and remove defaults.
- Overrides by level: **node > episode > project**. "In this episode Mitra has a cold" doesn't change the project's @Mitra.

## Stale

- When a lock moves upstream (or a referenced asset version changes), downstream work whose **inputs actually changed** becomes **stale**.
- Stale work stays visible (greyed), leaves context, and is never used by assembly.
- Rebuilding shows a **plan and cost** first. Re-locking the old version restores the old work.
- Work whose inputs are unchanged is kept, even across branches and recipe versions (content-hash caching).

## Conversation at every level

Conversation happens at the node, episode and project levels, each with a scope:

| Level | Talking to | Sees | Can change |
|---|---|---|---|
| Node | Micro-agent (specialist) | Its versions + locked context | Only its own node |
| Episode | Episode agent (director) | Every node's locked output and status, summaries | Anything in the episode, **by directing node agents** |
| Project | Project agent (producer) | All episodes, Library, templates | Library, templates, directions to episodes |

Rules:
1. **Higher levels direct, they don't edit.** Changes become new versions in each node's tree.
2. **Locks are respected.** Touching a locked node becomes a proposal: approved by the creator in ask mode, auto-approved (recorded, notified, revertible) in auto mode.
3. **Context flows down, summaries flow up.**
4. **Questions go up.** A micro-agent that hits a continuity conflict asks the episode agent instead of guessing.
5. **Higher-level agents show a plan first** by default; creators can switch a step or level to automatic. In automatic mode locked nodes don't ask first; every change to a lock is still recorded, notified and revertible. ([D-08](17-decisions.md), [D-28](17-decisions.md))

In the UI this is **one chat panel whose scope follows the selection**, with a breadcrumb showing who you're talking to.

## Autonomy ("trust") per step

Each step has a trust setting: **Ask me · Decide for me when confident · Always decide**. Steps can move up as the AI checker's agreement with the human's verdicts improves. The same graph runs supervised today and mostly automatic later, with no restructuring.

## Knowledge base

Failures become rules that act in three ways: **prevent** (prompt patch), **detect** (checker rubric item), **repair** (fix routing). Creators see them as one-tap tips. See [12-knowledge-base.md](12-knowledge-base.md).
