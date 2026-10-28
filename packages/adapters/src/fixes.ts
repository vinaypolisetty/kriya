/**
 * The fix loop (Day 21, D-64): what to do about a screen's candidates, from
 * what their checks said. A candidate that passed is locked; otherwise the one
 * cheapest to repair gets its fix: crop (free) before edit (one call) before
 * retry (all over again).
 *
 * Fixes come from the knowledge base first: rules seeded from the Mohalla
 * Mitra failure table (doc 12), each a known-good fix and the words that made
 * it work. An issue no rule knows takes the fix the judge suggested.
 *
 * A screen with `trust: when_confident` presses the suggested button itself,
 * for a few rounds; any other screen shows it as a suggestion.
 *
 * Rules also prevent (D-76): when the same issue keeps failing the same step,
 * `tips` offers the rule's `prevent` words for that step's prompt. A tip the
 * creator applies goes into every new generation of that step; nothing already
 * made changes.
 */
import type { Decision, ScreenNode, Shown } from "@kriya/engine";

type Fix = "crop" | "edit" | "retry";
type Issue = NonNullable<Shown["verdict"]>["issues"][number];

/**
 * A knowledge-base rule: which issues it knows, the fix, and the instruction for an
 * edit (`{what}`, `{where}` filled in). `prevent` is what to add to a step's prompt
 * so the issue doesn't happen, for steps of the listed `stages` (capabilities).
 */
export type FixRule = { id: string; issues: string[]; fix: Fix; note?: string; atEdge?: Fix; symptom?: string; prevent?: string; stages?: string[] };

const IMAGES = ["image.generate", "image.edit"];

/**
 * From the failure table (Parts 1–2) and Part 3's checks (Oct 24–26: 19 wrong
 * looks, 13 panels with writing, 9 missing characters, 7 duplicates, 4 extras):
 * the fixes that worked, worded the way they worked.
 */
export const SEED_RULES: FixRule[] = [
  { id: "kb_extra_character", issues: ["extra_character", "extra_person", "extra_people", "unlisted_character"], fix: "edit", atEdge: "crop", note: "Remove {what}. Exactly one of each character. Keep everything else exactly the same.", symptom: "extra people keep appearing", prevent: "Only these characters. No other people.", stages: IMAGES },
  { id: "kb_duplicate_character", issues: ["duplicate_character", "duplicated_character", "duplicate"], fix: "edit", note: "Exactly one of each character, do not add copies: remove {what}. Keep everything else exactly the same.", symptom: "characters keep appearing twice", prevent: "Exactly one of each.", stages: IMAGES },
  { id: "kb_missing_detail", issues: ["missing_detail", "missing_prop"], fix: "edit", note: "Only add {what}. Keep everything else exactly the same." },
  { id: "kb_readable_text", issues: ["readable_text", "text", "garbled_text", "signage", "sfx_lettering"], fix: "edit", note: "Remove all writing: {what}. No text, no signs with writing. Keep everything else exactly the same.", symptom: "writing keeps appearing in the pictures", prevent: "No text, no speech bubbles, no sound-effect lettering.", stages: IMAGES },
  { id: "kb_wrong_look", issues: ["wrong_look", "off_model", "wrong_outfit", "wrong_appearance"], fix: "edit", note: "Fix this to match the character's description: {what}. Keep everything else exactly the same.", symptom: "characters keep coming out looking different from their sheets", prevent: "Draw each character exactly as in their reference sheet: same face, hair, build, clothes and colors.", stages: IMAGES },
  { id: "kb_wrong_color", issues: ["wrong_color", "wrong_colour"], fix: "edit", note: "Name the color exactly: {what}. Keep everything else exactly the same." },
  { id: "kb_missing_character", issues: ["missing_character", "missing_characters", "character_missing"], fix: "retry", symptom: "listed characters keep going missing", prevent: "Every listed character must be clearly visible.", stages: IMAGES },
  { id: "kb_wrong_location", issues: ["wrong_location", "wrong_place", "location_mismatch"], fix: "retry", symptom: "the place keeps looking different", prevent: "Same place as its reference sheet.", stages: IMAGES },
];

const COST: Record<Fix, number> = { crop: 1, edit: 2, retry: 3 };
const EDGE = /\b(edge|corner|border|side)\b/i;

/** A suggested button press, and why, in words for the inbox. */
export type Suggestion = Decision & { why: string };

/** What to press on this screen, or nothing if its candidates weren't checked or no button fits. */
export function suggestFix(screen: Pick<ScreenNode, "actions">, shows: Shown[], rules: FixRule[] = SEED_RULES): Suggestion | undefined {
  const has = (id: string) => screen.actions.some((a) => a.id === id);
  const checked = shows.filter((s) => s.verdict);
  if (checked.length === 0) return undefined;

  const passed = checked.find((s) => s.verdict!.pass);
  const lock = screen.actions.find((a) => a.locks);
  if (passed) return lock ? { action: lock.id, selection: [passed.version], why: `${passed.version} passed its checks` } : undefined;

  // Each candidate's repair is its costliest issue's fix: a crop can't bring back a missing character.
  const plans = checked.map((s) => {
    const steps = s.verdict!.issues.map((i) => plan(i, rules));
    const fix = steps.reduce<Fix>((a, p) => (COST[p.fix] > COST[a] ? p.fix : a), "crop");
    return { s, steps, fix };
  });
  plans.sort((a, b) => COST[a.fix] - COST[b.fix] || a.steps.length - b.steps.length);
  const best = plans[0]!;
  const what = best.s.verdict!.issues.map((i) => i.what ?? i.type).join("; ");

  if (best.fix === "crop") {
    const keep = best.steps.find((p) => p.keep)?.keep;
    if (keep && has("crop")) return { action: "crop", selection: [best.s.version], region: keep, why: `${best.s.version}: ${what}; crop to ${keep}` };
    best.fix = "edit"; // no area to keep: an edit removes it instead
  }
  if (best.fix === "edit" && has("edit")) {
    return { action: "edit", selection: [best.s.version], note: best.steps.map((p) => p.note).join(" "), why: `${best.s.version} is closest: ${what}` };
  }
  if (has("retry")) return { action: "retry", note: `Fix: ${plans.flatMap((p) => p.s.verdict!.issues.map((i) => i.what ?? i.type)).filter((x, i, a) => a.indexOf(x) === i).join("; ")}`, why: `no candidate is close: ${what}` };
  return undefined;
}

/** One issue's fix: the knowledge base's if a rule knows it, else the judge's. */
function plan(issue: Issue, rules: FixRule[]): { fix: Fix; note: string; keep?: string } {
  const what = (issue.what ?? issue.type.replace(/_/g, " ")).replace(/[.\s]+$/, ""); // the rule's words carry on after it
  const rule = rules.find((r) => r.issues.includes(issue.type));
  const fill = (t: string) => t.replace("{what}", what).replace("{where}", issue.where ?? "");
  if (rule) {
    const fix = rule.atEdge && issue.where && EDGE.test(issue.where) && issue.keep ? rule.atEdge : rule.fix;
    return { fix, note: fill(rule.note ?? "Fix: {what}. Keep everything else exactly the same."), ...(issue.keep ? { keep: issue.keep } : {}) };
  }
  const judged = issue.fix === "crop" || issue.fix === "edit" || issue.fix === "retry" ? issue.fix : "edit";
  return { fix: judged, note: `Fix: ${what}. Keep everything else exactly the same.`, ...(issue.keep ? { keep: issue.keep } : {}) };
}

// ── Tips (D-76) ─────────────────────────────────────────────────────────────

/** One issue a check found on one candidate of a step (`step` is `recipe.node`, the same in every run and item). */
export type Failure = { step: string; type: string };

/** A rule applied to one step: its `prevent` words go into that step's prompt. */
export type Applied = { rule: string; step: string };

/** A suggestion to the creator: this keeps failing here, add these words to the step. */
export type Tip = { id: string; rule: string; step: string; hits: number; symptom: string; prevent: string };

/** How many times an issue fails the same step before kriya suggests preventing it. */
export const TIP_AFTER = 3;

/**
 * The tips worth showing, most hits first: a rule with `prevent` words whose issues
 * failed a step at least `TIP_AFTER` times, where the step makes what the rule is
 * for (`stageOf`), and the creator hasn't applied or dismissed it. A rule whose
 * words the step's prompt already says isn't offered: adding them again won't help
 * (Part 3 kept failing on writing with "No text" in every prompt).
 */
export function tips(failures: Failure[], rules: FixRule[], opts: { applied?: Applied[]; dismissed?: string[]; stageOf: (step: string) => string | undefined; promptOf?: (step: string) => string }): Tip[] {
  const hits = new Map<string, { rule: FixRule; step: string; hits: number }>();
  for (const f of failures) {
    const rule = rules.find((r) => r.prevent && r.issues.includes(f.type));
    if (!rule) continue;
    const id = tipId(rule.id, f.step);
    const h = hits.get(id) ?? { rule, step: f.step, hits: 0 };
    h.hits++;
    hits.set(id, h);
  }
  const done = new Set([...(opts.applied ?? []).map((a) => tipId(a.rule, a.step)), ...(opts.dismissed ?? [])]);
  return [...hits.entries()]
    .filter(([id, h]) => h.hits >= TIP_AFTER && !done.has(id) && (!h.rule.stages || h.rule.stages.includes(opts.stageOf(h.step) ?? "")) && !says(opts.promptOf?.(h.step) ?? "", h.rule.prevent!))
    .map(([id, h]) => ({ id, rule: h.rule.id, step: h.step, hits: h.hits, symptom: h.rule.symptom ?? h.rule.issues[0]!.replace(/_/g, " "), prevent: h.rule.prevent! }))
    .sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id));
}

/** Whether a prompt already has every sentence of these words, ignoring case and spacing. */
function says(prompt: string, words: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const p = norm(prompt);
  return words.split(/(?<=[.!?])\s+/).every((sentence) => p.includes(norm(sentence)));
}

/** A tip's id: the rule without its `kb_`, then the step: `readable_text:shot_recipe.draw`. */
export const tipId = (rule: string, step: string) => `${rule.replace(/^kb_/, "")}:${step}`;

/** The words applied rules add to one step's prompt, in the order they were applied. */
export function prevention(step: string, rules: FixRule[], applied: Applied[]): string[] {
  return applied.filter((a) => a.step === step).flatMap((a) => rules.find((r) => r.id === a.rule)?.prevent ?? []);
}
