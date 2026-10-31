/**
 * The engine's event types (docs/03-engine.md §1). Every engine action is one
 * of these, appended to the log; current state is rebuilt by replaying them.
 *
 * Payloads hold recorded data only: no clocks, no live objects. Anything a
 * model, agent, checker or human produced is stored here the first time and
 * replayed afterwards, never generated again (design rule 1).
 *
 * Adopting (merging two versions) has no event of its own: it is a
 * `CandidateProduced` with two parents (D-49).
 */
import { z } from "zod";

/** A node instance in the run graph: `draw`, or `per_shot[P3-04].draw` inside a map. */
const NodeKey = z.string().min(1);
const Hash = z.string().regex(/^[0-9a-f]{64}$/, "a content hash is 64 lowercase hex characters");
const Usd = z.number().nonnegative();
const Count = z.number().int().min(1);

const on = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape }).strict();

/** One thing a check found wrong, with the fix it suggests; `keep` is the area a crop keeps (`x,y,w,h`, fractions). */
const Issue = z.object({ type: z.string(), where: z.string().optional(), what: z.string().optional(), fix: z.string().optional(), keep: z.string().optional() }).strict();

export const EngineEvent = z.discriminatedUnion("type", [
  on("RunStarted", {
    release: Hash,
    graph: z.string().min(1),
    inputs: z.record(z.unknown()).default({}),
    /** Locked context inherited from higher levels, by level: `{ series: { style, rules } }` (D-47). */
    context: z.record(z.record(z.unknown())).default({}),
  }),
  /** A higher level's locked context changed (e.g. the series style was re-locked). */
  on("ContextUpdated", { level: z.string().min(1), values: z.record(z.unknown()) }),
  /** An override of one asset facet: for one step (its key), or the whole run (`run`, the episode level). */
  on("OverrideSet", { scope: z.string().min(1), entity: z.string().min(1), facet: z.string().min(1), value: z.unknown() }),
  /** A step can't run until something exists, e.g. a character's look. */
  on("NodeBlocked", { node: NodeKey, reason: z.string().min(1) }),
  /** The creator added an asset or output to one step's context ("@P2-13 match this tone"), saved with the step. */
  on("MentionAdded", { node: NodeKey, ref: z.string().min(1), note: z.string().optional() }),
  /** The creator removed one automatic input from one step (✕ on a chip). */
  on("DefaultRemoved", { node: NodeKey, ref: z.string().min(1) }),
  /**
   * A step can run. `note` is set when a failed step is tried again with a change (Q-24): the next attempt's instruction.
   * `back` is set when an arrow goes back into a one-at-a-time for-each: it walks its items again.
   */
  on("NodeReady", { node: NodeKey, note: z.string().min(1).optional(), back: z.literal(true).optional() }),
  /**
   * The scheduler followed an edge. `edge` is its index in the graph's `edges`,
   * prefixed inside a map item (`per_shot[P3-04].1`), so each item counts its own loops toward `max_loops`.
   */
  on("EdgeFollowed", { edge: z.string().min(1), from: NodeKey, to: z.string().min(1) }),
  /**
   * A for-each (`map`) step read its list: one child run per key, in list order.
   * The items themselves stay in the source step's locked version (`source` @ `version`, at `path`).
   */
  on("MapExpanded", { node: NodeKey, keys: z.array(z.string()), source: NodeKey, version: z.string(), path: z.array(z.string()) }),
  /** A one-at-a-time for-each moved on to this item. Its order is the list's; this records how far it got. */
  on("ItemStarted", { node: NodeKey, item: z.string().min(1) }),
  on("AttemptStarted", { node: NodeKey, attempt: Count }),
  on("CandidateProduced", {
    node: NodeKey,
    attempt: Count,
    candidate: Count,
    /** Field values; media are blob hashes. */
    output: z.record(z.unknown()),
    /** Versions this one was made from (an edit's source; two for adopt). */
    parents: z.array(z.string()).default([]),
    /** The prompt exactly as the provider got it, refs filled in. */
    prompt: z.string().optional(),
    /** The reference images it was given, in order: what each one is, and its content hash or URL. */
    references: z.array(z.object({ label: z.string(), ref: z.string() }).strict()).optional(),
    /** Exact provider model version (rule 6). */
    model: z.string().optional(),
    seed: z.number().int().optional(),
    cost_usd: Usd.default(0),
    /** The instruction behind this version, e.g. the note "add the gamcha". `replay_change` re-applies it. */
    instruction: z.string().optional(),
    /** The step that made it, when another step refines this one (`edit` refines `draw`). */
    made_by: NodeKey.optional(),
    /** Set by `replay_change`: the version whose instruction was re-applied, as `node@version`. */
    replayed_from: z.string().optional(),
    /**
     * What this version was made from, one content hash per input (`spec`, `item`, `uses:pick.selected`,
     * `after:pick`, `over`). If any changes later, the version is stale (docs/03-engine.md §6).
     */
    inputs: z.record(Hash).optional(),
    /** Asset facet versions it used, `Entity.facet` → version, for lineage. */
    assets: z.record(z.string()).optional(),
  }),
  on("VerdictRecorded", {
    node: NodeKey,
    version: z.string(),
    by: z.enum(["code", "llm", "human"]),
    pass: z.boolean(),
    issues: z.array(Issue).default([]),
    model: z.string().optional(),
    cost_usd: Usd.default(0),
  }),
  on("FixChosen", {
    node: NodeKey,
    fix: z.enum(["retry", "regenerate_with_patch", "edit", "transform", "swap_provider", "decompose", "escalate", "waive"]),
    issue: z.string().optional(),
  }),
  on("Suspended", { node: NodeKey, ticket: z.string().min(1), kind: z.enum(["model_job", "tool_job", "check_job", "human", "timer", "manual_upload"]) }),
  on("Resumed", { node: NodeKey, ticket: z.string().min(1) }),
  on("HumanDecision", {
    node: NodeKey,
    action: z.string().min(1),
    selection: z.array(z.string()).optional(),
    note: z.string().optional(),
    region: z.unknown().optional(),
    /** Who pressed the button: a person, or the screen itself following its checks (`trust: when_confident`, Day 21). */
    by: z.enum(["human", "auto"]).optional(),
  }),
  on("AgentTurn", {
    node: NodeKey,
    turn: Count,
    response: z.unknown(),
    tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).strict(),
    model: z.string().min(1),
    cost_usd: Usd,
    /** The model's context window in tokens, so clearing decisions replay exactly (D-39 step 2). */
    context_window: z.number().int().positive().optional(),
  }),
  on("ToolCalled", { node: NodeKey, turn: Count, call: Count, tool: z.string().min(1), args: z.unknown() }),
  on("ToolResult", { node: NodeKey, turn: Count, call: Count, ok: z.boolean(), result: Hash }),
  on("HistoryCompacted", {
    node: NodeKey,
    turn: Count,
    covers: z.tuple([Count, Count]),
    digest: Hash,
    model: z.string().min(1),
    cost_usd: Usd,
  }),
  on("BranchCreated", { node: NodeKey, branch: z.string().regex(/^[a-z][a-z0-9_-]*$/, "a branch name uses lowercase letters, digits, - and _"), from: z.string() }),
  on("BranchSwitched", { node: NodeKey, branch: z.string().min(1) }),
  on("Locked", { node: NodeKey, version: z.string(), by: z.enum(["human", "auto"]), why: z.string().optional() }),
  on("Unlocked", { node: NodeKey }),
  on("MarkedStale", { node: NodeKey, reason: z.string().min(1) }),
  /** Its inputs match again (e.g. the original upstream version was re-locked): the work is valid again. */
  on("MarkedFresh", { node: NodeKey }),
  /**
   * The creator looked at stale work and kept it as it is (D-72): its locked version
   * is judged against these inputs from now on, so it stays fresh until one of them moves.
   */
  on("StaleKept", { node: NodeKey, version: z.string(), inputs: z.record(z.string()), why: z.string().optional() }),
  on("NodeCompleted", { node: NodeKey }),
  on("NodeFailed", { node: NodeKey, reason: z.string().min(1) }),
  on("RunCompleted", { status: z.enum(["completed", "failed", "cancelled"]) }),
  /** A finished run is opened again because the creator changed something in it. */
  on("RunReopened", { reason: z.string().min(1) }),
]);

export type EngineEvent = z.infer<typeof EngineEvent>;
/** An event as written by the engine: fields with defaults may be left out. */
export type EngineEventInput = z.input<typeof EngineEvent>;
export type EventType = EngineEvent["type"];
export type EventOf<T extends EventType> = Extract<EngineEvent, { type: T }>;

/** A version's id within its node: attempt 2, candidate 3 → "2.3". */
export const versionId = (attempt: number, candidate: number) => `${attempt}.${candidate}`;

/** Checks an event read from storage, with a plain message if it's damaged or from an unknown kriya. */
export function parseEvent(type: string, payload: unknown): EngineEvent {
  const r = EngineEvent.safeParse({ ...(payload as object), type });
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? ` (at ${first.path.join(".")})` : "";
    throw new Error(`event '${type}' in the log doesn't look right${where}: ${first?.message ?? "invalid"}`);
  }
  return r.data;
}
