# Locks and stale work: knowing exactly what a change breaks

*Draft, Day 28. For a blog post / LinkedIn article. About 1,100 words. Follows [Deterministic orchestration of non-deterministic models](writeup-determinism.md).*

---

Halfway through a Part of *Mohalla Mitra*, I change my mind about something upstream. Maybe Tiwari's voice should be pompous, not tired. Maybe the shot list should call the place "the reservoir", not "the water tank". The question every creative pipeline has to answer is: **what does that change break?**

There are two lazy answers. "Everything downstream" throws away 40 minutes of model time and $5 of drawings I'd already approved. "Nothing" means the Reel goes out with Tiwari sounding tired in four lines and pompous in two. Both are wrong. The right answer is "exactly the work whose inputs changed, and here's why". It falls out of two ideas: **locks** and **per-input hashes**.

## A lock is the only thing that flows

A step in kriya rarely produces one answer. The panel step draws three candidates. I edit one, retry another, branch off to try a darker sky. A node ends up with a version tree: `1.1`, `1.2`, `1.3`, then `2.1` (an edit of 1.2), then `3.1` on a branch called `darker-sky`.

Exactly one of those can be **locked**, and only the lock goes downstream. The clip step animates the locked panel, never "the latest one" or "the one with the best score". Rejected candidates and parked branches stay in history, where I can still look at them, but they never reach a prompt.

That sounds bureaucratic. In practice it's what makes everything else tractable. "What does the clip depend on?" has a precise answer: *the locked version of the panel*, not a fuzzy "whatever the panel step made".

Who gets to lock is explicit too. A screen button locks only if the recipe marks it `locks: true`; renaming the button "Approve" to "Looks good" never silently stops it locking. A step with `trust: always` locks itself. A `when_confident` step locks itself only when its checks pass, and the lock records `by: auto` so I can tell my locks from the machine's.

## Every version remembers its inputs, one hash each

When a version is made, kriya records a content hash for **each input separately**, not one hash for the whole bundle:

| Input | Example for a shot's panel |
|---|---|
| Settings (minus labels) | The model, the prompt template, `options: 3` |
| The item | Shot P3-04: characters, place, action |
| Library facets it used | `Bheem.look` v2, `Chai stall.look` v1 |
| Locked outputs it read | The series style, the shot list |
| Preceding steps | Which button was pressed on the screen before it |

When a lock moves, or a Library facet changes, or the recipe is edited, kriya re-checks every settled version downstream. For each one, it recomputes the hashes and compares them input by input:

- **All match**: the work is still good. Nothing happens.
- **Some differ**: the work is **stale**, with a plain reason built from *which* inputs changed: "Bheem's look changed", "its item changed", "'shot_list' changed".

One hash per input is what makes the reason possible. A single hash over everything can tell you *that* something changed, never *what*. And "what" is the difference between me trusting the system and me re-checking everything by hand.

Two details matter more than they look:

- **Labels don't count.** Renaming a step's display name or a button's label isn't a change to the work. Those fields are left out of the hash, so cosmetic edits never invalidate anything.
- **Only the button pressed counts.** A step after a review screen depends on *which* button I pressed (lock vs. edit), not on the note I typed, which already lives on the version it produced.

## Stale isn't deleted, and isn't redone

Stale work stays visible, greyed out, and out of context. It isn't thrown away and it isn't automatically redone. Two things can happen next.

**Re-lock the old version and the work comes back for free.** If I try a new shot list, decide I hated it, and re-lock the original, every panel drawn from the original matches its inputs again and turns fresh. No model is called. Nothing is redrawn. This is the property I care about most: experimenting upstream is cheap, because changing your mind back costs nothing.

**Or rebuild.** `kriya rebuild` restarts the earliest stale step in each recipe. For-each steps keep their unchanged items: if one shot's description changed, one shot is redrawn, not thirteen. Stale work the rebuild doesn't reach stays parked.

## A real one, from today

Earlier today I changed the Part recipe so the shot list can only name places that exist in the Library. Models kept inventing "Reservoir valve, morning" when the Library said "Reservoir valve". I copied the new recipe into the project while a real Part 3 run was mid-flight.

`kriya status` immediately showed:

```
↻ shot_list · stale: its settings changed · locked 1.1
```

That's exactly right. The shot list's prompt *did* change, so the locked list was made under different instructions. Nothing downstream was touched: the seven panels I'd already locked kept their locks, and nothing was redrawn, because staleness parks work and never redoes it on its own. I get to decide whether the new instructions are worth a new shot list. (They weren't, for this Part; I added the five invented places to the Library instead, and every shot that was waiting on a missing place could draw.)

Compare the two lazy answers. "Everything downstream" would have binned seven locked panels. "Nothing" would have hidden that the shot list no longer matches its recipe.

## What's built and what isn't

Built and tested: locks, per-input hashes with plain reasons, re-lock restores, rebuild that keeps unchanged items, and branches. On a branch, the review shows only that branch's candidates.

Designed, not built yet:

- **The rebuild estimate.** The design says a rebuild asks first: "9 shots, 3 clips and 14 voice lines need redoing, about $3.10". Today buttons show what they'll cost, but `rebuild` just goes.
- **Proposals for locked nodes.** A change from a higher-level agent that touches a lock should become a proposal (ask mode), or apply and be revertible in one step (auto mode). The events and the rule exist on paper; the agent that makes such changes doesn't yet.
- **Run upgrades.** When the recipe changes mid-run, the run carries on with the new recipe and warns. A proper upgrade would compare releases by stable id and show what moves.

## The one-line version

> **Lock one version per step; record a hash per input; when anything moves, mark stale exactly the work whose inputs changed, say why, and let re-locking undo it for free.**

It's the same move as the determinism write-up: record the facts the first time, and derive everything else from them. Stale tracking is just asking the log a question: was this made from what's locked now?
