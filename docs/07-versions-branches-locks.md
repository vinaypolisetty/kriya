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

## Candidates vs branches

- **Candidates are automatic** and declared in config (images per shot). Pick one; the rest leave context.
- **Branches are explicit**: only when the user says "branch off" or clicks Branch. By default a conversation is a single path; each message refines the current version. ([Decision D-04](17-decisions.md))

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
