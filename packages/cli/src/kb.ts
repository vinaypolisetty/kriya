/**
 * The knowledge base on disk (Day 35, D-76): `kb.yaml` at the project root,
 * optional, holding the project's own rules and what the creator said to tips:
 *
 *   rules:       # your own, next to kriya's built-in ones (the same id replaces one)
 *     - id: kb_camera_moves
 *       issues: [camera_move]
 *       fix: retry
 *       symptom: the camera keeps moving
 *       prevent: Camera static. No pans, no zooms.
 *       stages: [video.from_image]
 *   applied:     # tips you said yes to: the rule's words go into that step's prompt
 *     - { rule: kb_readable_text, step: shot_recipe.draw }
 *   dismissed: [wrong_look:shot_recipe.draw]
 *
 * Tips come from what the checks recorded in every run (failed verdicts'
 * issues), so they need no model and no clock. Steps are `recipe.node`: the
 * same step in every run and every item of a for-each.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { prevention, SEED_RULES, tips, type Applied, type Failure, type FixRule, type Tip } from "@kriya/adapters";
import { findGraph, suggest, type Graph, type Node } from "@kriya/engine";
import type { Store } from "@kriya/store";

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/, "use lower_snake_case, e.g. kb_camera_moves");
const Fix = z.enum(["crop", "edit", "retry"]);

const KbFile = z
  .object({
    rules: z
      .array(
        z
          .object({
            id: Id,
            issues: z.array(z.string().min(1)).min(1),
            fix: Fix,
            note: z.string().optional(),
            at_edge: Fix.optional(),
            symptom: z.string().optional(),
            prevent: z.string().optional(),
            stages: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .default([]),
    applied: z.array(z.object({ rule: z.string().min(1), step: z.string().min(1) }).strict()).default([]),
    dismissed: z.array(z.string()).default([]),
  })
  .strict();
type KbFile = z.infer<typeof KbFile>;

/** The project's knowledge base: built-in rules with its own, and the tips it applied or dismissed. */
export type Kb = { rules: FixRule[]; applied: Applied[]; dismissed: string[]; own: KbFile };

/** Reads `kb.yaml` (none is fine). Problems say what's wrong and the nearest name. */
export function loadKb(root: string, graphs: Graph[]): { kb: Kb; problems: string[] } {
  const file = join(root, "kb.yaml");
  const raw = existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {};
  const parsed = KbFile.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return { kb: { rules: SEED_RULES, applied: [], dismissed: [], own: KbFile.parse({}) }, problems: [`kb.yaml: ${i.path.join(".") || "(top)"}: ${i.message}`] };
  }
  const own = parsed.data;
  const mine: FixRule[] = own.rules.map(({ at_edge, ...r }) => ({ ...r, ...(at_edge ? { atEdge: at_edge } : {}) }));
  const rules = [...SEED_RULES.filter((s) => !mine.some((m) => m.id === s.id)), ...mine];
  const problems: string[] = [];
  const steps = graphs.flatMap((g) => g.nodes.map((n) => `${g.graph}.${n.id}`));
  for (const a of own.applied) {
    if (!rules.some((r) => r.id === a.rule)) problems.push(`kb.yaml: applied: there's no rule '${a.rule}'${suggest(a.rule, rules.map((r) => r.id))}`);
    else if (!rules.find((r) => r.id === a.rule)!.prevent) problems.push(`kb.yaml: applied: the rule '${a.rule}' has no prevent words to add to a prompt`);
    if (!steps.includes(a.step)) problems.push(`kb.yaml: applied: there's no step '${a.step}' (steps are recipe.step)${suggest(a.step, steps)}`);
  }
  return { kb: { rules, applied: own.applied, dismissed: own.dismissed, own }, problems };
}

/** Writes the creator's answer to a tip back to `kb.yaml`, keeping their own rules as they are. */
export function saveKb(root: string, own: KbFile): void {
  const keep = { ...(own.rules.length ? { rules: own.rules } : {}), ...(own.applied.length ? { applied: own.applied } : {}), ...(own.dismissed.length ? { dismissed: own.dismissed } : {}) };
  writeFileSync(join(root, "kb.yaml"), `# kriya knowledge base: your own rules, and the tips you applied or dismissed (kriya tips)\n${stringify(keep)}`);
}

/** Which recipe and step a run's step key is: `per_shot[P3-04].draw` in a part run is `shot_recipe.draw`. */
export function stepOf(graphs: Graph[], graphId: string, key: string): string | undefined {
  let graph = graphId;
  let rest = key;
  for (;;) {
    const m = /^([^[.]+)\[.*?\]\.(.+)$/.exec(rest);
    // Named by the recipe's id now, so a renamed recipe's tips count its old runs too (D-78).
    const g = findGraph(graphs, graph);
    if (!m) return g?.nodes.some((n) => n.id === rest) ? `${g.graph}.${rest}` : undefined;
    const map = g?.nodes.find((n) => n.id === m[1]);
    if (map?.kind !== "map") return undefined;
    [graph, rest] = [map.graph, m[2]!];
  }
}

/** Every issue a failed check recorded, in every run, by step. */
export function failures(store: Store, graphs: Graph[]): Failure[] {
  const out: Failure[] = [];
  for (const run of store.events.runs()) {
    const events = store.events.read(run);
    const started = events.find((e) => e.type === "RunStarted")?.payload as { graph?: string } | undefined;
    if (!started?.graph) continue;
    for (const e of events) {
      if (e.type !== "VerdictRecorded") continue;
      const v = e.payload as { node: string; pass: boolean; issues?: { type: string }[] };
      if (v.pass) continue;
      const step = stepOf(graphs, started.graph, v.node);
      if (step) for (const i of v.issues ?? []) out.push({ step, type: i.type });
    }
  }
  return out;
}

/** What a step makes (its capability), for matching rules to steps. */
export function stageOf(graphs: Graph[]): (step: string) => string | undefined {
  return (step) => {
    const node = nodeOf(graphs, step);
    return node?.kind === "model" ? node.capability : undefined;
  };
}

function nodeOf(graphs: Graph[], step: string): Node | undefined {
  const dot = step.lastIndexOf(".");
  return findGraph(graphs, step.slice(0, dot))?.nodes.find((n) => n.id === step.slice(dot + 1));
}

/** The tips to show now. */
export function projectTips(store: Store, graphs: Graph[], kb: Kb): Tip[] {
  const promptOf = (step: string) => {
    const node = nodeOf(graphs, step);
    return node?.kind === "model" ? (node.prompt ?? "") : "";
  };
  return tips(failures(store, graphs), kb.rules, { applied: kb.applied, dismissed: kb.dismissed, stageOf: stageOf(graphs), promptOf });
}

/** For the adapters: a node's applied rules' words. Nodes are looked up by recipe, so the same id in two recipes stays apart. */
export function preventFor(graphs: Graph[], kb: Kb): (node: Node) => string[] {
  return (node) => {
    const g = graphs.find((x) => x.nodes.includes(node));
    if (!g) return [];
    return prevention(`${g.graph}.${node.id}`, kb.rules, kb.applied);
  };
}

/** Says yes or no to a tip: yes adds it to `applied`, no to `dismissed`. */
export function answerTip(root: string, kb: Kb, tip: Tip, yes: boolean): void {
  const own = { ...kb.own };
  if (yes) own.applied = [...own.applied, { rule: tip.rule, step: tip.step }];
  else own.dismissed = [...own.dismissed, tip.id];
  saveKb(root, own);
}
