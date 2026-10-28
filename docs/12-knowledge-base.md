# 12 · Knowledge base

A failure → fix knowledge base that grows over time.

## Entry shape

```yaml
id: kb_extra_character
scope: domain            # provider | domain | project
symptom: An extra character appears (e.g. Dhanpat at the chai stall)
stage: image.generate
detect:                  # becomes a checker rubric item
  rubric: "Only the listed characters appear; no extra people."
prevent:                 # applied to prompts before generating
  prompt_suffix: "Only these characters. No other people."
  attach: only_sheets_for_shot
repair:                  # fix routing when detected
  if_at_edge: crop
  else: edit
hits: 4
examples: [run_123/per_shot[P1-07]/draw/v2]
```

## Three ways a rule acts

| Role | When | Example |
|---|---|---|
| **Prevent** | Before generating | "Only these characters. No other people." is always in the prompt |
| **Detect** | During checks | Rubric item: "no readable text" |
| **Repair** | After a failed check | Extras at the edge → crop; one wrong detail → edit |

## Scopes

- **Provider-specific:** "Wan changes scene midway", "Wan adds unwanted audio". Carries over to every use case.
- **Domain-specific:** "Garbled text on signs".
- **Project-specific:** "Bheem's gamcha goes missing".

## What's built (Day 35, D-76)

- **Repair:** the fix loop (D-64) picks crop, edit or retry by issue type and words the edit the way that worked.
- **Prevent:** a rule's `prevent` words. When checks fail the same step 3 times for issues a rule knows, `kriya tips` and the inbox (terminal and browser) suggest adding them to that step's prompt. Apply → every new generation of that step gets them (the recorded prompt shows them); nothing already made changes. A tip isn't offered when the prompt already says it: Part 3's draw prompt said "No text, no speech bubbles, no sound-effect lettering" and writing still appeared 13 times, so the fix there is the repair, not more words.
- **Your own rules** live in `kb.yaml` with your answers to tips ([cli.md](cli.md)).
- **Not yet:** detect (rules as rubric items), counting human rejection notes (free text; needs a model to sort, so a checker step would do it), measuring which fix worked, and suggesting recipe changes beyond prompt words.

Part 3's checks, Oct 24–26, by issue: wrong look 19, writing 13, missing character 9, duplicate 7, extra character 4, voice line too long 5. On that project `kriya tips` offers two: the looks ("Draw each character exactly as in their reference sheet…") and missing characters. The other three were already in the prompt.

## How it grows (graduation)

1. A failure is observed once (from a human rejection note or a checker issue).
2. The engine proposes a new entry; the creator approves.
3. After repeated hits, the entry graduates into rules: prompt patch, rubric item, routing rule.
4. Creators see it as a one-tap tip: *"Extra characters keep appearing in your shots. Always add 'Only these characters' to your drawing step?"*
5. It can also suggest recipe changes: *"You've rejected Wan clips with camera moves 6 times. Add 'Camera static' to the prompt?"*

The event log makes this measurable: which fixes actually worked for which issue types.

## Seed data (from Mohalla Mitra Parts 1–2)

| Problem | Fix |
|---|---|
| An extra character appears (Dhanpat at the chai stall) | Attach only the sheets for that shot; add "Only these characters. No other people." |
| A character is duplicated after an edit | Add "Exactly one of each, do not add copies." If it persists, crop to the area and edit the crop |
| The location looks different in every shot | Attach the location sheet; add "Same chai stall as the reference sheet" |
| Style drifts toward a different look | Always attach the reference sheets; don't rely on words alone |
| A detail goes missing (Bheem's gamcha) | Edit: "Only add the gamcha, keep everything else" |
| Colors off (brown mud instead of red) | Name the color exactly: "bright brick-red mud" |
| Garbled writing on signs or notebooks | Add "no text, no signs with writing"; add real text in the edit if needed |
| Sound effects in the action (`SFX: THUD!`) get drawn as lettering | Prevent: "no sound-effect lettering" in the prompt. Repair: edit "Remove all writing…" (P3-08, Oct 25: all three panels had it; one edit fixed it) |
| A Wan clip changes scene midway | Use only the good part and hold the last good frame |
| Wan clip has unwanted audio | Ignore it; strip it in assembly |
| A voice line is too long | Regenerate at speed 1.1–1.2 (lines over ~8 s make the Reel drag) |
| A name viewers don't know (Madhav) | Use the known name in dialogue (Mitra chacha) |
| File too big to send | Compress under 30 MB |
| Video cut off on Instagram | Post as a Reel, not a regular post |
