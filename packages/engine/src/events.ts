/**
 * The engine's event types (docs/03-engine.md §1). Every engine action is one
 * of these, appended to the log; current state is rebuilt by replaying them.
 *
 * Payloads hold recorded data only: no clocks, no live objects. Anything a
 * model, agent, checker or human produced is stored here the first time and
 * replayed afterwards, never generated again (design rule 1).
 *
 * Branch events (BranchCreated, BranchSwitched, Adopted) arrive on Day 9.
 */
import { z } from "zod";

/** A node instance in the run graph: `draw`, or `per_shot[P3-04].draw` inside a map. */
const NodeKey = z.string().min(1);
const Hash = z.string().regex(/^[0-9a-f]{64}$/, "a content hash is 64 lowercase hex characters");
const Usd = z.number().nonnegative();
const Count = z.number().int().min(1);

const on = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape }).strict();

const Issue = z.object({ type: z.string(), where: z.string().optional(), what: z.string().optional(), fix: z.string().optional() }).strict();

export const EngineEvent = z.discriminatedUnion("type", [
  on("RunStarted", { release: Hash, graph: z.string().min(1), inputs: z.record(z.unknown()).default({}) }),
  on("NodeReady", { node: NodeKey }),
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
  on("AttemptStarted", { node: NodeKey, attempt: Count }),
  on("CandidateProduced", {
    node: NodeKey,
    attempt: Count,
    candidate: Count,
    /** Field values; media are blob hashes. */
    output: z.record(z.unknown()),
    /** Versions this one was made from (an edit's source; two for adopt). */
    parents: z.array(z.string()).default([]),
    prompt: z.string().optional(),
    /** Exact provider model version (rule 6). */
    model: z.string().optional(),
    seed: z.number().int().optional(),
    cost_usd: Usd.default(0),
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
  on("Suspended", { node: NodeKey, ticket: z.string().min(1), kind: z.enum(["model_job", "human", "timer", "manual_upload"]) }),
  on("Resumed", { node: NodeKey, ticket: z.string().min(1) }),
  on("HumanDecision", {
    node: NodeKey,
    action: z.string().min(1),
    selection: z.array(z.string()).optional(),
    note: z.string().optional(),
    region: z.unknown().optional(),
  }),
  on("AgentTurn", {
    node: NodeKey,
    turn: Count,
    response: z.unknown(),
    tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).strict(),
    model: z.string().min(1),
    cost_usd: Usd,
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
  on("Locked", { node: NodeKey, version: z.string(), by: z.enum(["human", "auto"]), why: z.string().optional() }),
  on("Unlocked", { node: NodeKey }),
  on("MarkedStale", { node: NodeKey, reason: z.string().min(1) }),
  on("NodeCompleted", { node: NodeKey }),
  on("NodeFailed", { node: NodeKey, reason: z.string().min(1) }),
  on("RunCompleted", { status: z.enum(["completed", "failed", "cancelled"]) }),
]);

export type EngineEvent = z.infer<typeof EngineEvent>;
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
