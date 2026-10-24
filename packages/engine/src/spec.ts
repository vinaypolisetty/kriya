/**
 * The graph spec: what a workflow definition looks like on disk.
 *
 * A bundle is a set of graphs. Each graph runs at one level (series, story,
 * part, shot…) and is made of nodes joined by edges. Conditions live on edges.
 * Nodes of kind `map` run another graph once per item; `subgraph` runs another
 * graph once. Everything here is plain data, so it can be hashed, diffed and
 * versioned.
 */
import { z } from "zod";

const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "use lower_snake_case: letters, digits and _, starting with a letter");

/** A field type: text, number, boolean, image, audio, video, a declared type, or list<...> of any of those. */
export const TypeRef = z
  .string()
  .regex(/^(list<)?[a-z][a-z0-9_]*(>)?$/, "a type is a name like text or image, or list<name>")
  .refine((s) => s.startsWith("list<") === s.endsWith(">"), "unbalanced list<...>");

export const PRIMITIVE_TYPES = ["text", "number", "boolean", "image", "audio", "video", "file", "json"] as const;

const Fields = z.record(Id, TypeRef);

/** Where a value comes from, e.g. "shot_list.shots", "item.characters@look", "series.style". */
const Ref = z.string().min(1);

const Base = {
  id: Id,
  name: z.string().optional(),
  description: z.string().optional(),
};

const Trust = z.enum(["ask_me", "when_confident", "always"]);
const ContextMode = z.enum(["full", "local", "isolated"]);

export const ModelNode = z
  .object({
    ...Base,
    kind: z.literal("model"),
    /** This step's outputs are new versions of another step (`edit` refines `draw`), D-44. */
    refines: Id.optional(),
    capability: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/, "a capability looks like image.generate"),
    model: z.string().optional(),
    prompt: z.string().optional(),
    /** Extra settings passed to the provider as they are, e.g. `aspect_ratio: "16:9"`. Part of the step's settings, so changing one makes its work stale. */
    params: z.record(z.unknown()).optional(),
    uses: z.array(Ref).default([]),
    options: z.number().int().min(1).max(8).default(1),
    /** Unset: `full`, or `local` for a step that `refines` another (D-13, D-55). */
    context: ContextMode.optional(),
    trust: Trust.default("ask_me"),
    out: Fields.default({}),
  })
  .strict();

export const AgentNode = z
  .object({
    ...Base,
    kind: z.literal("agent"),
    /** This step's outputs are new versions of another step (`edit` refines `draw`), D-44. */
    refines: Id.optional(),
    goal: z.string().min(1),
    tools: z.array(z.string()).min(1),
    uses: z.array(Ref).default([]),
    max_turns: z.number().int().min(1).default(8),
    /** Spend cap for the whole agent run, checked between turns. */
    budget: z.object({ usd: z.number().positive() }).strict().optional(),
    /** Unset: `full`, or `local` for a step that `refines` another (D-13, D-55). */
    context: ContextMode.optional(),
    trust: Trust.default("ask_me"),
    out: Fields.default({}),
  })
  .strict();

export const ToolNode = z
  .object({
    ...Base,
    kind: z.literal("tool"),
    /** This step's outputs are new versions of another step (`edit` refines `draw`), D-44. */
    refines: Id.optional(),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
    out: Fields.default({}),
  })
  .strict();

export const ScreenAction = z
  .object({
    id: Id,
    label: z.string().optional(),
    needs: z.array(z.enum(["selection", "note", "region"])).default([]),
    /** Pressing this button locks the chosen version of the step the screen shows (D-42). */
    locks: z.boolean().default(false),
  })
  .strict();

export const ScreenNode = z
  .object({
    ...Base,
    kind: z.literal("screen"),
    review: z.enum(["pick_one", "pick_many", "approve", "fix_area", "listen", "edit_text", "form"]),
    show: Ref.optional(),
    beside: z.array(Ref).default([]),
    actions: z.array(ScreenAction).min(1),
    trust: Trust.default("ask_me"),
    batch: z.boolean().default(false),
  })
  .strict();

export const MapNode = z
  .object({
    ...Base,
    kind: z.literal("map"),
    over: Ref,
    graph: Id,
    key: z.string().default("id"),
  })
  .strict();

export const SubgraphNode = z
  .object({
    ...Base,
    kind: z.literal("subgraph"),
    graph: Id,
    count: z.number().int().min(1).optional(),
  })
  .strict();

export const Node = z.discriminatedUnion("kind", [ModelNode, AgentNode, ToolNode, ScreenNode, MapNode, SubgraphNode]);

export const END = "END";

export const Edge = z
  .object({
    from: z.union([Id, z.array(Id).min(1)]),
    to: z.union([Id, z.literal(END)]),
    /** A condition on recorded data, e.g. `action == 'redo'` or `item.animate == true`. */
    when: z.string().optional(),
    /** Required on any edge that closes a loop. */
    max_loops: z.number().int().min(1).max(20).optional(),
    /** For joins: wait for all sources (default) or the first. */
    wait: z.enum(["all", "any"]).optional(),
  })
  .strict();

export const Graph = z
  .object({
    graph: Id,
    level: Id,
    description: z.string().optional(),
    /** Higher levels whose locked context this recipe reads, e.g. [series, story] → `series.style` (D-47). */
    inherits: z.array(Id).default([]),
    inputs: Fields.default({}),
    outputs: z.record(Id, Ref).default({}),
    types: z.record(Id, z.object({ fields: Fields }).strict()).default({}),
    nodes: z.array(Node).min(1),
    edges: z.array(Edge).default([]),
  })
  .strict();

export type Graph = z.infer<typeof Graph>;
export type Node = z.infer<typeof Node>;
export type Edge = z.infer<typeof Edge>;
export type ScreenNode = z.infer<typeof ScreenNode>;
export type AgentNode = z.infer<typeof AgentNode>;

/**
 * What a step sees (D-13): generating steps default to `full`, steps that
 * refine another (edits, fixes) to `local`. Screens and other kinds: `full`.
 */
export function contextMode(node: Node): "full" | "local" | "isolated" {
  if (node.kind !== "model" && node.kind !== "agent") return "full";
  return node.context ?? (node.refines ? "local" : "full");
}

/** The text a step's `{{refs}}` live in: a model's prompt or an agent's goal. */
export function stepText(node: Node): string {
  return node.kind === "model" ? (node.prompt ?? "") : node.kind === "agent" ? node.goal : "";
}
