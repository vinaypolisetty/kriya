/**
 * A kriya project on disk:
 *
 *   kriya.yaml   project settings: which models, the inherited context, the Library
 *   recipes/     the recipe files (the source of truth, D-33)
 *   .kriya/      run data: the event log and media (gitignored)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { REPLICATE_CAPABILITIES } from "@kriya/adapters";
import { loadDir, type Graph, type Problem } from "@kriya/engine";

export const ProjectFile = z
  .object({
    name: z.string().min(1),
    /**
     * Which providers run which steps. `fake` (the default): made-up outputs, no keys.
     * Per kind of step: `{ llm: anthropic, image: replicate, video: replicate, audio: replicate }`;
     * kinds left out stay fake. `anthropic` is short for `{ llm: anthropic }`.
     */
    models: z
      .union([
        z.enum(["fake", "anthropic"]),
        z
          .object({
            llm: z.enum(["fake", "anthropic"]).optional(),
            image: z.enum(["fake", "replicate"]).optional(),
            video: z.enum(["fake", "replicate"]).optional(),
            audio: z.enum(["fake", "replicate"]).optional(),
          })
          .strict(),
      ])
      .default("fake")
      .transform((m) => (m === "fake" ? {} : m === "anthropic" ? { llm: "anthropic" as const } : m)),
    /**
     * Replicate settings per capability (`image.generate`, `video.from_image`, `audio.speech`, …):
     * model (`owner/name`, or `owner/name:version`), params sent every time, the model's input field
     * names, and a price per output or per second. A step's own `model:` and `params:` win.
     */
    replicate: z
      .record(
        z.enum(REPLICATE_CAPABILITIES),
        z
          .object({
            model: z.string().optional(),
            params: z.record(z.unknown()).optional(),
            fields: z.object({ prompt: z.string().optional(), images: z.string().optional(), voice: z.string().optional(), style: z.string().optional() }).strict().optional(),
            price_usd: z.number().nonnegative().optional(),
            price_per_second_usd: z.number().nonnegative().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Claude settings for `models: anthropic`; steps can still pin their own `model`. */
    claude: z.object({ model: z.string().optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional() }).strict().optional(),
    recipes: z.string().default("recipes"),
    /** Locked context from higher levels, by level, e.g. `series: { style: … }` (D-47). */
    context: z.record(z.record(z.unknown())).default({}),
    /** Asset facets, `Entity.facet: value`, until the Library (Day 18). */
    library: z.record(z.unknown()).default({}),
  })
  .strict();
export type ProjectFile = z.infer<typeof ProjectFile>;

export type Project = {
  root: string;
  settings: ProjectFile;
  graphs: Graph[];
  problems: Problem[];
};

/**
 * Content hash of what one run uses: its recipe and every recipe its `map` and
 * `subgraph` steps run, so adding or editing an unrelated recipe doesn't flag
 * other runs as changed.
 */
export function releaseOf(graphs: Graph[], graphId: string): string {
  const used = new Map<string, Graph>();
  const visit = (id: string) => {
    const g = graphs.find((x) => x.graph === id);
    if (!g || used.has(id)) return;
    used.set(id, g);
    for (const n of g.nodes) if (n.kind === "map" || n.kind === "subgraph") visit(n.graph);
  };
  visit(graphId);
  return createHash("sha256")
    .update(JSON.stringify([...used.values()].sort((a, b) => a.graph.localeCompare(b.graph))))
    .digest("hex");
}

/** Finds kriya.yaml in `from` or a folder above it. */
export function findRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "kriya.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function loadProject(from: string): Project {
  const root = findRoot(from);
  if (!root) throw new UserError("there's no kriya.yaml here or in any folder above. Start a project with: kriya init <folder>");
  const raw = parse(readFileSync(join(root, "kriya.yaml"), "utf8")) ?? {};
  const parsed = ProjectFile.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new UserError(`kriya.yaml: ${i.path.join(".") || "(top)"}: ${i.message}`);
  }
  const dir = join(root, parsed.data.recipes);
  if (!existsSync(dir)) throw new UserError(`the recipes folder '${parsed.data.recipes}' doesn't exist`);
  const { graphs, problems } = loadDir(dir);
  return { root, settings: parsed.data, graphs, problems };
}

/** An error meant for the person at the terminal: printed as-is, no stack trace. */
export class UserError extends Error {}
