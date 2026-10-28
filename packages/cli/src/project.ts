/**
 * A kriya project on disk:
 *
 *   kriya.yaml   project settings: which models, the inherited context, the Library's kinds
 *   recipes/     the recipe files (the source of truth, D-33)
 *   library/     the Library: one file per character, place, track… (Day 18)
 *   kb.yaml      the knowledge base: own rules, tips applied or dismissed (Day 35, optional)
 *   .kriya/      run data: the event log and media (gitignored)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { REPLICATE_CAPABILITIES } from "@kriya/adapters";
import { libraryKind, loadDir, suggest, type Graph, type Problem } from "@kriya/engine";
import { loadKb, type Kb } from "./kb.js";
import { loadLibrary, type Library } from "./library.js";

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
    /**
     * Tool steps (crop, compress, assemble_reel): `fake` (the default) makes up outputs;
     * `{ python, font }` runs them here with ffmpeg. `python` runs the Reel assembler and
     * needs Pillow (`~/…` is fine); `font` is a .ttf in the project for captions.
     */
    tools: z
      .union([z.literal("fake"), z.object({ python: z.string().optional(), font: z.string().optional() }).strict()])
      .default("fake"),
    /** Claude settings for `models: anthropic`; steps can still pin their own `model`. */
    claude: z.object({ model: z.string().optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional() }).strict().optional(),
    recipes: z.string().default("recipes"),
    /** Locked context from higher levels, by level, e.g. `series: { style: … }` (D-47). */
    context: z.record(z.record(z.unknown())).default({}),
    /** The Library's kinds and the facets each has, e.g. `character: [look, voice, speech]`; entities live in `library/`. */
    kinds: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/, "use lower_snake_case"), z.array(z.string().regex(/^[a-z][a-z0-9_]*$/, "use lower_snake_case"))).default({}),
  })
  .strict();
export type ProjectFile = z.infer<typeof ProjectFile>;

export type Project = {
  root: string;
  settings: ProjectFile;
  graphs: Graph[];
  problems: Problem[];
  library: Library;
  kb: Kb;
  /** What's wrong in kb.yaml, in plain words. */
  kbProblems: string[];
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
  if (raw && typeof raw === "object" && "library" in raw) {
    throw new UserError("kriya.yaml: the Library moved to the library/ folder, one file per entity (e.g. library/mitra.yaml with name, kind and facets). Move each Entity.facet there and delete library: from kriya.yaml; see docs/cli.md");
  }
  const parsed = ProjectFile.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new UserError(`kriya.yaml: ${i.path.join(".") || "(top)"}: ${i.message}`);
  }
  const dir = join(root, parsed.data.recipes);
  if (!existsSync(dir)) throw new UserError(`the recipes folder '${parsed.data.recipes}' doesn't exist`);
  const { graphs, problems } = loadDir(dir);
  const library = loadLibrary(root, parsed.data.kinds);
  // A recipe field typed `library.<kind>` needs that kind (when the project names its kinds).
  const kinds = Object.keys(parsed.data.kinds);
  if (kinds.length) {
    const used = new Set(graphs.flatMap((g) => [...Object.values(g.types).flatMap((t) => Object.values(t.fields)), ...g.nodes.flatMap((n) => ("out" in n ? Object.values(n.out) : []))]).flatMap((t) => libraryKind(t) ?? []));
    for (const k of used) if (!kinds.includes(k)) library.problems.push(`a recipe uses library.${k}, and there's no kind '${k}'${suggest(k, kinds)} Kinds: ${kinds.join(", ")} (kinds: in kriya.yaml)`);
  }
  const { kb, problems: kbProblems } = loadKb(root, graphs);
  return { root, settings: parsed.data, graphs, problems, library, kb, kbProblems };
}

/** An error meant for the person at the terminal: printed as-is, no stack trace. */
export class UserError extends Error {}
