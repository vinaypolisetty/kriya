/**
 * The scheduler: decides which step runs next and records everything it does.
 *
 * It reads only the graph and recorded state. Conditions are evaluated on
 * recorded outputs and decisions (rule 2), ready steps run in the order they
 * are declared in the graph, and every edge it follows is an event, so the
 * same graph and the same recorded results always take the same path.
 *
 * Day 6 scope: executors return immediately (fakes), the first candidate is
 * locked automatically, and humans answer on the spot. Real tickets and
 * waiting arrive on Day 11, lock policy on Day 8, `map`/`subgraph` on Day 7.
 */
import { END, type Graph, type Node, type ScreenNode } from "./spec.js";
import { evaluate, parseCondition, type Expr } from "./condition.js";
import { versionId } from "./events.js";
import type { Recorder } from "./recorder.js";
import type { RunState } from "./state.js";
import { startNodes } from "./validate.js";

export type StepContext = {
  /** Which run of this step this is: 1 the first time, 2 after one loop back, … */
  visit: number;
  inputs: Record<string, unknown>;
};

export type Decision = { action: string; selection?: string[]; note?: string };

/** Runs steps. Day 6 uses fakes; real adapters implement the same shape. */
export interface Executors {
  /** model, tool and agent steps: one output per candidate. */
  produce(node: Node, ctx: StepContext): Record<string, unknown>[];
  /** screen steps: what the human chose. */
  decide(node: ScreenNode, ctx: StepContext): Decision;
}

const MAX_STEPS = 10_000;

export class Scheduler {
  private readonly conditions: (Expr | undefined)[];
  private readonly byId: Map<string, Node>;

  constructor(
    private readonly graph: Graph,
    private readonly rec: Recorder,
    private readonly exec: Executors,
  ) {
    this.conditions = graph.edges.map((e) => (e.when ? parseCondition(e.when) : undefined));
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
  }

  /** Starts a run: records RunStarted and makes the starting steps ready. */
  start(release: string, inputs: Record<string, unknown> = {}): void {
    this.rec.record({ type: "RunStarted", release, graph: this.graph.graph, inputs });
    for (const id of startNodes(this.graph)) this.rec.record({ type: "NodeReady", node: id });
  }

  /** Runs ready steps until the run finishes. Returns the final state. */
  run(): RunState {
    for (let i = 0; i < MAX_STEPS; i++) {
      const state = this.rec.state;
      if (state.status !== "running") return state;
      const next = this.graph.nodes.find((n) => state.nodes[n.id]?.status === "ready");
      if (!next) {
        const failed = Object.values(state.nodes).some((n) => n.status === "failed");
        this.rec.record({ type: "RunCompleted", status: this.endReached(state) && !failed ? "completed" : "failed" });
        return this.rec.state;
      }
      this.step(next);
    }
    throw new Error(`run '${this.rec.runId}' took more than ${MAX_STEPS} steps; this is a bug in kriya, not your recipe`);
  }

  /** Whether any edge into END has been followed. Read from state, so it survives a resume. */
  private endReached(state: RunState): boolean {
    return this.graph.edges.some((e, i) => e.to === END && (state.edges[i] ?? 0) > 0);
  }

  private step(node: Node): void {
    const n = this.rec.state.nodes[node.id]!;
    // Derived from recorded state, never kept in memory, so a resumed run counts the same.
    const visit = (node.kind === "screen" ? n.decisions.length : n.attempts) + 1;
    const ctx: StepContext = { visit, inputs: this.rec.state.inputs };

    switch (node.kind) {
      case "model":
      case "tool":
      case "agent": {
        const attempt = n.attempts + 1;
        this.rec.record({ type: "AttemptStarted", node: node.id, attempt });
        const outputs = this.exec.produce(node, ctx);
        if (outputs.length === 0) {
          this.rec.record({ type: "NodeFailed", node: node.id, reason: "it produced no output" });
          return;
        }
        outputs.forEach((output, i) =>
          this.rec.record({ type: "CandidateProduced", node: node.id, attempt, candidate: i + 1, output, parents: [], cost_usd: 0 }),
        );
        this.rec.record({ type: "Locked", node: node.id, version: versionId(attempt, 1), by: "auto" });
        break;
      }
      case "screen": {
        const ticket = `${node.id}:${ctx.visit}`;
        this.rec.record({ type: "Suspended", node: node.id, ticket, kind: "human" });
        const d = this.exec.decide(node, ctx);
        if (!node.actions.some((a) => a.id === d.action)) {
          throw new Error(`step '${node.id}' has no button '${d.action}'`);
        }
        this.rec.record({ type: "HumanDecision", node: node.id, ...d });
        this.rec.record({ type: "Resumed", node: node.id, ticket });
        break;
      }
      case "map":
      case "subgraph":
        this.rec.record({ type: "NodeFailed", node: node.id, reason: `'${node.kind}' steps can't run yet (coming in the next update)` });
        return;
    }
    this.rec.record({ type: "NodeCompleted", node: node.id });
    this.follow(node.id);
  }

  /** Follows every outgoing edge whose condition holds, within its loop limit. */
  private follow(from: string): void {
    const scope = this.scope(from);
    let followed = 0;
    let limited: string | undefined;

    this.graph.edges.forEach((edge, i) => {
      const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
      if (!sources.includes(from)) return;
      const cond = this.conditions[i];
      if (cond && !evaluate(cond, scope)) return;

      if (sources.length > 1) {
        const done = sources.filter((s) => this.rec.state.nodes[s]?.status === "completed");
        const wait = edge.wait ?? "all";
        if (wait === "all" && done.length < sources.length) return;
        if (wait === "any" && (this.rec.state.edges[i] ?? 0) > 0) return;
      }

      const count = this.rec.state.edges[i] ?? 0;
      if (edge.max_loops !== undefined && count >= edge.max_loops) {
        limited = `went back to '${edge.to}' ${count} times, the limit for that loop`;
        return;
      }

      this.rec.record({ type: "EdgeFollowed", edge: i, from, to: edge.to });
      followed++;
      if (edge.to !== END) this.rec.record({ type: "NodeReady", node: edge.to });
    });

    if (followed === 0 && limited) this.rec.record({ type: "NodeFailed", node: from, reason: limited });
  }

  /**
   * What a condition can read: each step's locked output by id (a screen's
   * action, selection and note), the graph inputs, `item` inside a map, and
   * `action` for the step the edge leaves from. Recorded data only.
   */
  private scope(from: string): Record<string, unknown> {
    const s = this.rec.state;
    const scope: Record<string, unknown> = {};
    for (const [id, n] of Object.entries(s.nodes)) {
      const node = this.byId.get(id);
      if (node?.kind === "screen") {
        const d = n.decisions.at(-1);
        if (d) scope[id] = { action: d.action, selected: d.selection, note: d.note };
      } else if (n.locked) {
        scope[id] = n.versions[n.locked.version]?.output;
      }
    }
    scope.inputs = s.inputs;
    scope.item = s.inputs.item;
    scope.action = s.nodes[from]?.decisions.at(-1)?.action;
    return scope;
  }
}
