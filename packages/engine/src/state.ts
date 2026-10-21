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
};

export type NodeState = {
  status: NodeStatus;
  attempts: number;
  versions: Record<string, Version>;
  locked?: { version: string; by: "human" | "auto"; why?: string };
  ticket?: string;
  decisions: Omit<EventOf<"HumanDecision">, "type" | "node">[];
  turns: number;
  /** Agent tool calls waiting for a result, as "turn.call". */
  openCalls: string[];
  costUsd: number;
  failure?: string;
  staleReason?: string;
};

export type RunState = {
  release: string;
  graph: string;
  inputs: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "cancelled";
  nodes: Record<string, NodeState>;
  /** How many times each edge (by index) has been followed. */
  edges: Record<string, number>;
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
  costUsd: 0,
});

/** Applies one event and returns the next state. The input state is not modified. */
export function apply(state: RunState | undefined, e: EngineEvent): RunState {
  if (e.type === "RunStarted") {
    if (state) fail(e, "the run has already started");
    return { release: e.release, graph: e.graph, inputs: e.inputs, status: "running", nodes: {}, edges: {}, costUsd: 0 };
  }
  if (!state) fail(e, "it came before RunStarted");
  if (state.status !== "running") fail(e, `the run is already ${state.status}`);

  if (e.type === "RunCompleted") return { ...state, status: e.status };

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
      return next({ status: "running", attempts: e.attempt });

    case "CandidateProduced": {
      if (e.attempt !== n.attempts) fail(e, `attempt ${e.attempt} was never started`);
      const id = versionId(e.attempt, e.candidate);
      if (n.versions[id]) fail(e, `version ${id} already exists`);
      for (const p of e.parents) if (!n.versions[p]) fail(e, `parent version ${p} doesn't exist`);
      const v: Version = { id, attempt: e.attempt, candidate: e.candidate, parents: e.parents, output: e.output, verdicts: [] };
      if (e.model !== undefined) v.model = e.model;
      return next({ status: "checking", versions: { ...n.versions, [id]: v } }, e.cost_usd);
    }

    case "VerdictRecorded": {
      const v = version(e, n, e.version);
      const { type: _t, node: _n, version: _v, ...verdict } = e;
      return next({ versions: { ...n.versions, [v.id]: { ...v, verdicts: [...v.verdicts, verdict] } } }, e.cost_usd);
    }

    case "FixChosen":
      return next({ status: "fixing" });

    case "Suspended":
      if (n.ticket) fail(e, `step is already waiting on ticket ${n.ticket}`);
      return next({ status: e.kind === "human" ? "awaiting_human" : "waiting_external", ticket: e.ticket });

    case "Resumed": {
      if (n.ticket !== e.ticket) fail(e, `step isn't waiting on ticket ${e.ticket}`);
      const { ticket: _t, ...rest } = n;
      return withNode(state, e.node, { ...rest, status: "running" });
    }

    case "HumanDecision": {
      const { type: _t, node: _n, ...d } = e;
      return next({ decisions: [...n.decisions, d] });
    }

    case "AgentTurn":
      if (e.turn !== n.turns + 1) fail(e, `expected turn ${n.turns + 1}, got ${e.turn}`);
      return next({ status: "running", turns: e.turn }, e.cost_usd);

    case "ToolCalled": {
      const call = `${e.turn}.${e.call}`;
      if (e.turn !== n.turns) fail(e, `turn ${e.turn} hasn't happened`);
      if (n.openCalls.includes(call)) fail(e, `tool call ${call} was already made`);
      return next({ openCalls: [...n.openCalls, call] });
    }

    case "ToolResult": {
      const call = `${e.turn}.${e.call}`;
      if (!n.openCalls.includes(call)) fail(e, `tool call ${call} was never made, or already returned`);
      return next({ openCalls: n.openCalls.filter((c) => c !== call) });
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
