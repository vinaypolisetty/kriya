/**
 * Run state as a pure fold over events: state = events.reduce(apply, empty).
 *
 * `apply` never reads the clock, randomness or anything outside its arguments,
 * so replaying a log always rebuilds exactly the state the engine had live.
 * It also refuses events that can't happen (locking a version that doesn't
 * exist, a result for a tool that was never called), so a damaged log fails
 * loudly instead of producing a quietly wrong state.
 */
import { versionId, type EngineEvent, type EventOf } from "./events.js";

export type NodeStatus =
  | "blocked"
  | "ready"
  | "running"
  | "checking"
  | "fixing"
  | "waiting_external"
  | "awaiting_human"
  | "locked"
  | "stale"
  | "completed"
  | "failed";

export type Verdict = Omit<EventOf<"VerdictRecorded">, "type" | "node" | "version">;

export type Version = {
  id: string;
  attempt: number;
  candidate: number;
  parents: string[];
  output: Record<string, unknown>;
  model?: string;
  verdicts: Verdict[];
  /** The path this version was made on (`main` unless the creator branched off). */
  branch: string;
  instruction?: string;
  madeBy?: string;
  replayedFrom?: string;
  /** What the call that made it cost, in US$ (0 for fakes and people). */
  costUsd: number;
  /** The prompt and reference images the provider got, when it reported them. */
  prompt?: string;
  references?: { label: string; ref: string }[];
  /** Library facet versions it used, `Entity.facet` → version. */
  assets?: Record<string, string>;
  /** One content hash per input it was made from; see `CandidateProduced.inputs`. */
  inputs?: Record<string, string>;
};

/** One agent turn of the current attempt: the model's reply, its cost, and the tool calls it asked for. */
export type AgentStep = {
  turn: number;
  response: unknown;
  cost: number;
  /** Input tokens the provider reported for this turn, and the model's context window. */
  tokensIn: number;
  window?: number;
  /** `ok` and `result` (a content hash) are set once the tool returns. */
  calls: { call: number; tool: string; args: unknown; ok?: boolean; result?: string }[];
};

export type NodeState = {
  status: NodeStatus;
  attempts: number;
  versions: Record<string, Version>;
  locked?: { version: string; by: "human" | "auto"; why?: string };
  ticket?: string;
  /** What the ticket waits on: a person, a model job, a tool job, … */
  ticketKind?: string;
  decisions: Omit<EventOf<"HumanDecision">, "type" | "node">[];
  turns: number;
  /** Agent tool calls waiting for a result, as "turn.call". */
  openCalls: string[];
  /** An agent's turns in the current attempt, rebuilt from events on replay (D-26). */
  history: AgentStep[];
  costUsd: number;
  failure?: string;
  staleReason?: string;
  /** The branch new versions go on, and every branch with the version it started from. */
  branch: string;
  branches: Record<string, { from?: string }>;
  /** Mentions and removed defaults the creator saved on this step. */
  mentions: { ref: string; note?: string }[];
  removed: string[];
  blockedReason?: string;
  /** For a map step: its items, in list order, and where they were read from. */
  items?: { keys: string[]; source: string; version: string; path: string[] };
};

export type RunState = {
  release: string;
  graph: string;
  inputs: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "cancelled";
  nodes: Record<string, NodeState>;
  /** How many times each edge (by index) has been followed. */
  edges: Record<string, number>;
  /** Locked context inherited from higher levels, by level. */
  context: Record<string, Record<string, unknown>>;
  /** Facet overrides: scope (a step key, or `run`) → `Entity.facet` → value. */
  overrides: Record<string, Record<string, unknown>>;
  costUsd: number;
};

export class ReplayError extends Error {}

const newNode = (): NodeState => ({
  status: "ready",
  attempts: 0,
  versions: {},
  decisions: [],
  turns: 0,
  openCalls: [],
  history: [],
  costUsd: 0,
  branch: "main",
  branches: { main: {} },
  mentions: [],
  removed: [],
});

/** Applies one event and returns the next state. The input state is not modified. */
export function apply(state: RunState | undefined, e: EngineEvent): RunState {
  if (e.type === "RunStarted") {
    if (state) fail(e, "the run has already started");
    return { release: e.release, graph: e.graph, inputs: e.inputs, status: "running", nodes: {}, edges: {}, context: e.context, overrides: {}, costUsd: 0 };
  }
  if (!state) fail(e, "it came before RunStarted");
  if (e.type === "RunReopened") {
    if (state.status === "running") fail(e, "the run is already open");
    return { ...state, status: "running" };
  }
  if (state.status !== "running") fail(e, `the run is already ${state.status}`);

  if (e.type === "RunCompleted") return { ...state, status: e.status };
  if (e.type === "ContextUpdated") return { ...state, context: { ...state.context, [e.level]: e.values } };
  if (e.type === "OverrideSet") {
    const scope = { ...(state.overrides[e.scope] ?? {}), [`${e.entity}.${e.facet}`]: e.value };
    return { ...state, overrides: { ...state.overrides, [e.scope]: scope } };
  }

  if (e.type === "EdgeFollowed") {
    const from = state.nodes[e.from];
    if (!from || from.status !== "completed") fail(e, `step '${e.from}' hasn't completed`);
    return { ...state, edges: { ...state.edges, [e.edge]: (state.edges[e.edge] ?? 0) + 1 } };
  }

  if (e.type === "NodeReady") {
    const prev = state.nodes[e.node];
    return withNode(state, e.node, prev ? { ...prev, status: "ready" } : newNode());
  }

  const n = state.nodes[e.node];
  if (!n) fail(e, `step '${e.node}' was never made ready`);
  const next = (patch: Partial<NodeState>, cost = 0) =>
    withNode({ ...state, costUsd: state.costUsd + cost }, e.node, { ...n, ...patch, costUsd: n.costUsd + cost });

  switch (e.type) {
    case "AttemptStarted":
      if (e.attempt !== n.attempts + 1) fail(e, `expected attempt ${n.attempts + 1}, got ${e.attempt}`);
      return next({ status: "running", attempts: e.attempt, history: [] });

    case "CandidateProduced": {
      if (e.attempt !== n.attempts) fail(e, `attempt ${e.attempt} was never started`);
      const id = versionId(e.attempt, e.candidate);
      if (n.versions[id]) fail(e, `version ${id} already exists`);
      for (const p of e.parents) if (!n.versions[p]) fail(e, `parent version ${p} doesn't exist`);
      const v: Version = { id, attempt: e.attempt, candidate: e.candidate, parents: e.parents, output: e.output, verdicts: [], branch: n.branch, costUsd: e.cost_usd };
      if (e.model !== undefined) v.model = e.model;
      if (e.prompt !== undefined) v.prompt = e.prompt;
      if (e.references !== undefined) v.references = e.references;
      if (e.assets !== undefined) v.assets = e.assets;
      if (e.instruction !== undefined) v.instruction = e.instruction;
      if (e.made_by !== undefined) v.madeBy = e.made_by;
      if (e.replayed_from !== undefined) v.replayedFrom = e.replayed_from;
      if (e.inputs !== undefined) v.inputs = e.inputs;
      return next({ status: "checking", versions: { ...n.versions, [id]: v } }, e.cost_usd);
    }

    case "VerdictRecorded": {
      const v = version(e, n, e.version);
      const { type: _t, node: _n, version: _v, ...verdict } = e;
      return next({ versions: { ...n.versions, [v.id]: { ...v, verdicts: [...v.verdicts, verdict] } } }, e.cost_usd);
    }

    case "MapExpanded": {
      const src = state.nodes[e.source];
      if (!src?.versions[e.version]) fail(e, `source ${e.source} @ ${e.version} doesn't exist`);
      if (new Set(e.keys).size !== e.keys.length) fail(e, "two items share a key");
      return next({ items: { keys: e.keys, source: e.source, version: e.version, path: e.path } });
    }

    case "BranchCreated":
      if (n.branches[e.branch]) fail(e, `there's already a branch called '${e.branch}'`);
      version(e, n, e.from);
      return next({ branches: { ...n.branches, [e.branch]: { from: e.from } } });

    case "BranchSwitched":
      if (!n.branches[e.branch]) fail(e, `there's no branch called '${e.branch}'`);
      return next({ branch: e.branch });

    case "NodeBlocked":
      return next({ status: "blocked", blockedReason: e.reason });

    case "MentionAdded": {
      const m: { ref: string; note?: string } = { ref: e.ref };
      if (e.note !== undefined) m.note = e.note;
      return next({ mentions: [...n.mentions.filter((x) => x.ref !== e.ref), m] });
    }

    case "DefaultRemoved":
      return next({ removed: n.removed.includes(e.ref) ? n.removed : [...n.removed, e.ref] });

    case "FixChosen":
      return next({ status: "fixing" });

    case "Suspended":
      if (n.ticket) fail(e, `step is already waiting on ticket ${n.ticket}`);
      return next({ status: e.kind === "human" ? "awaiting_human" : "waiting_external", ticket: e.ticket, ticketKind: e.kind });

    case "Resumed": {
      if (n.ticket !== e.ticket) fail(e, `step isn't waiting on ticket ${e.ticket}`);
      const { ticket: _t, ticketKind: _k, ...rest } = n;
      return withNode(state, e.node, { ...rest, status: "running" });
    }

    case "HumanDecision": {
      const { type: _t, node: _n, ...d } = e;
      return next({ decisions: [...n.decisions, d] });
    }

    case "AgentTurn":
      if (e.turn !== n.turns + 1) fail(e, `expected turn ${n.turns + 1}, got ${e.turn}`);
      return next({ status: "running", turns: e.turn, history: [...n.history, { turn: e.turn, response: e.response, cost: e.cost_usd, tokensIn: e.tokens.input, ...(e.context_window ? { window: e.context_window } : {}), calls: [] }] }, e.cost_usd);

    case "ToolCalled": {
      const call = `${e.turn}.${e.call}`;
      if (e.turn !== n.turns) fail(e, `turn ${e.turn} hasn't happened`);
      if (n.openCalls.includes(call)) fail(e, `tool call ${call} was already made`);
      const last = n.history.at(-1);
      if (!last || last.turn !== e.turn) fail(e, `turn ${e.turn} isn't part of this attempt`);
      const step = { ...last, calls: [...last.calls, { call: e.call, tool: e.tool, args: e.args }] };
      return next({ openCalls: [...n.openCalls, call], history: [...n.history.slice(0, -1), step] });
    }

    case "ToolResult": {
      const call = `${e.turn}.${e.call}`;
      if (!n.openCalls.includes(call)) fail(e, `tool call ${call} was never made, or already returned`);
      const history = n.history.map((h) => (h.turn !== e.turn ? h : { ...h, calls: h.calls.map((c) => (c.call === e.call ? { ...c, ok: e.ok, result: e.result } : c)) }));
      return next({ openCalls: n.openCalls.filter((c) => c !== call), history });
    }

    case "HistoryCompacted":
      if (e.covers[0] > e.covers[1] || e.covers[1] > n.turns) fail(e, `can't compact turns ${e.covers.join("–")}`);
      return next({}, e.cost_usd);

    case "Locked": {
      version(e, n, e.version);
      const locked: NodeState["locked"] = { version: e.version, by: e.by };
      if (e.why !== undefined) locked.why = e.why;
      const { staleReason: _s, ...rest } = n;
      return withNode(state, e.node, { ...rest, status: "locked", locked });
    }

    case "Unlocked": {
      if (!n.locked) fail(e, "nothing is locked");
      const { locked: _l, ...rest } = n;
      return withNode(state, e.node, { ...rest, status: "ready" });
    }

    case "MarkedStale":
      if (!n.locked) fail(e, "only locked work can go stale");
      return next({ status: "stale", staleReason: e.reason });

    case "MarkedFresh": {
      if (n.status !== "stale") fail(e, "it isn't stale");
      const { staleReason: _s, ...rest } = n;
      return withNode(state, e.node, { ...rest, status: "completed" });
    }

    case "NodeCompleted":
      return next({ status: "completed" });

    case "NodeFailed":
      return next({ status: "failed", failure: e.reason });
  }
}

/** Rebuilds run state from a log. */
export function replay(events: Iterable<EngineEvent>): RunState {
  let state: RunState | undefined;
  for (const e of events) state = apply(state, e);
  if (!state) throw new ReplayError("this run has no events yet");
  return state;
}

function withNode(state: RunState, key: string, node: NodeState): RunState {
  return { ...state, nodes: { ...state.nodes, [key]: node } };
}

function version(e: EngineEvent, n: NodeState, id: string): Version {
  const v = n.versions[id];
  if (!v) fail(e, `version ${id} doesn't exist`);
  return v;
}

function fail(e: EngineEvent, why: string): never {
  const where = "node" in e ? ` for step '${e.node}'` : "";
  throw new ReplayError(`can't apply ${e.type}${where}: ${why}`);
}
