# 07 · Versions, branches and locks

## The version tree

Every node instance holds a tree of versions:

```
Node: Story
 ├─ A′
 ├─ A″ ── "make the villain funnier" → A″-2 ── "use A‴'s ending" → A″-3  🔒 locked
 └─ A‴
```

Each version records: parents (one, or two for adopt), the instruction that produced it, prompt, resolved inputs (by hash), model and version, seed, cost, verdicts, author (model, agent or human), timestamp.

Operations inside a node:

| Operation | Result |
|---|---|
| **Generate** | Candidates per the config (`options: 3`) |
| **Refine** | A child version from a conversational instruction |
| **Adopt** | A version with two parents: "take A″, but use A‴'s ending" (a merge). For media it is a model call with both as references, so the result goes through the normal check → fix loop. The model or agent step that refines the node makes it (for a panel, `edit`, given `parent` and `borrow`); otherwise the node's own step. It goes on the current branch and locks nothing ([D-49](17-decisions.md)) |
| **Replay change** | Re-apply the recorded instruction behind a version to another version, branch or item: "do the same gamcha fix on every shot with Bheem". One parent; a new attempt ([D-30](17-decisions.md)) |
| **Branch** | A separate, named path with its own conversation, from any version |
| **Fork context** | Copy everything up to this point into a new node or another workflow |
| **Lock** | Declare the node's output |
| **Unlock** | Remove the lock; downstream work goes stale |

## Talking to a step

Every model, agent and tool step has a conversation of its own ([D-87](17-decisions.md)): `kriya chat <run> <step>`, or **Talk to this step** in its box in the browser (right under the pictures when it waits for your review).

- **Versions are numbered** v1, v2, v3… in the order they were made, across branches, so "v3" always names one version. Each one says why it exists, in one line: `from recipe`, `"make him smile"`, `from v2: "night"`, `v4 + v2: "the sky"`, `made again`.
- **Asking is free of side effects.** "Why is v2 flatter than v3?" gets an answer from what's recorded: each version's prompt, model and checks, pictures of the latest ones, and the story so far (the run's inputs and every locked output). Nothing is made.
- **Saying what you want acts, the way a click would.** "Make v2 at night" makes a new version from v2 (by the step's edit step when it has one, else the step itself with the instruction); it waits to be locked, and the recipe doesn't move. "Lock v3, the smile reads" locks v3 with *the smile reads* as its why, word for word; if a pick is waiting on this step, that's the pick's answer and the recipe carries on. Vague praise isn't a lock: the chat asks.
- **Facts about a character, place or thing change for the whole run, then the Library if you keep it** ([D-88](17-decisions.md)). "Mitra should sound older" in a voice line's chat changes Mitra's voice for this run: every line he speaks here is redone, including takes still waiting for you to listen ([D-90](17-decisions.md)): you pick from takes in the new voice. The Library isn't touched. Then the chat asks whether to keep it for future runs; yes writes it to `library/mitra.yaml`, no leaves it in this run. One field at a time, never a file: a new sheet is drawn and changed in the Library by hand.
- **Point at things with @** ([D-96](17-decisions.md)). `@Mitra`, `@Library`, `@shot_list v2`, `@per_shot[P3-03].draw` or, beside this step in its shot, `@pick`: the chat is shown each one whole, with its pictures, even a version that isn't locked. In the browser, type @ for a list. It's for the chat to look at: it still acts only on this step and the Library's facets, and nothing pointed at goes into the next version yet.
- **A finished run is done and frozen.** You can talk about it; nothing in it is locked, made or changed, and a Library change doesn't make it stale: it keeps the voices and looks it was made with. Worked on again, it catches up.
- **In a run still going, a lock that leaves later work stale rebuilds it** at once: in progress follows the change.

Every message, answer and action is an event, recorded once and replayed (rule 1). The conversation never leaves the step: only its locked version and your lock's why flow downstream ([D-11](17-decisions.md), [D-29](17-decisions.md)).

Not built yet: @references to other steps' versions, and changes for one step only.

## Candidates vs branches

- **Candidates are automatic** and declared in config (images per shot). Pick one; the rest leave context.
- **Branches are explicit**: only when the user says "branch off" or clicks Branch. By default a conversation is a single path. ([Decision D-04](17-decisions.md))

```yaml
image:
  options: 3            # automatic: always 3 per shot
  branching: allowed    # user may still branch to try another direction
story:
  options: 1            # one draft at a time
  branching: allowed    # conversational: branch when the user wants
```

Branch operations: **branch off** (save current path, copy its conversation and context to this point, start a new named path), **switch** (each path keeps its history; the review shows the branch you're on, [D-71](17-decisions.md)), **compare** (latest of each side by side), **adopt** (borrow from another path into this one), **lock** (one path's version becomes the output; the others are **parked**: kept in history, out of context).

Branches are cheap: they store only what changes after the branch point.

### Branching at higher levels

"What if Part 3 ends with Tiwari arresting Dhanpat instead?" creates an alternate version of the episode from that point. Downstream nodes are copied only when you start changing them (copy-on-write), so cuts share everything identical.

## Locks and context

- **Only locked outputs flow downstream** (plus locked context from above).
- **Once a response is locked, its siblings vanish from context at that level** — but not from history. They can be re-locked later.

## Stale

When a lock moves (unlock + lock another version, adopt a branch, a new facet version):

1. The engine recomputes cache keys downstream along item-level edges.
2. Work whose key changed becomes **STALE**: visible, greyed, out of context, never used by assembly.
3. Work whose inputs are identical **carries over** (same shot description, characters and references → locked work stays valid).
4. Rebuilding asks first: *"9 shots, 3 clips and 14 voice lines need redoing, about $3.10."*
5. **Re-locking the original path restores its work** — nothing lost.

([Decision D-05](17-decisions.md): when a branched story is locked over the original, downstream work from the old path is **marked stale and parked**, not kept as an alternate cut.)

## Changes from higher levels

When the episode agent is asked "make Tiwari sweatier in every shot":
- It finds affected nodes (4 shots with @Tiwari).
- Unlocked nodes: it sends instructions to each node's micro-agent; each produces a new version.
- Locked nodes: it **proposes** instead: *"P3-08 is locked and includes Tiwari. Unlock and redo? This makes its clip and the Reel stale."*
- By default it shows the whole **plan and cost first**; the creator can enable automatic mode for a step or level. In automatic mode, changes to locked nodes apply without asking: each is recorded as an auto-approved proposal, shows up in the inbox as a notice, and can be reverted to the previous lock in one action ([D-28](17-decisions.md)).

## Run upgrades (recipe changed mid-run)

Runs pin a release. When the recipe changes (e.g. "add a music-pick step to Part 3 now"), the run can be **upgraded**. The engine compares releases **by stable id**:

| Change | Effect |
|---|---|
| Unchanged step | Keeps locked work |
| Changed step | Its work (and dependants) go stale; plan + cost shown first |
| New step | Runs |
| Removed step | Outputs archived, not deleted |

## Recipes have versions too

A draft recipe has history (undo, redo) and can be branched ("try a version with music chosen per scene"). **Publishing** freezes a release, exactly like locking a version of a shot.
