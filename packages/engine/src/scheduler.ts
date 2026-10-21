/**
 * The scheduler: decides which step runs next and records everything it does.
 *
 * It reads only the graphs and recorded state. Conditions are evaluated on
 * recorded outputs and decisions (rule 2), ready steps run in a fixed order,
 * and every edge it follows is an event, so the same recipe and the same
 * recorded results always take the same path.
 *
 * A for-each (`map`) step runs its child recipe once per item, inside the same
 * run: the child steps of item P3-04 are keyed `per_shot[P3-04].draw`, and
 * each item moves on as soon as its own steps finish (D-34). The map finishes
 * when every item has, and its output is one list per child output, in the
 * order of the source list, with `null` where an item produced nothing (D-41).
 *
 * Still to come: lock policy (Day 8), real tickets and waiting (Day 11),
 * re-running a map with reuse of unchanged items (Day 10), `subgraph` steps.
 */
import { END, type Graph, type Node, type ScreenNode } from "./spec.js";
import { evaluate, parseCondition, type Expr } from "./condition.js";
import { versionId } from "./events.js";
import type { Recorder } from "./recorder.js";
import type { NodeStatus, RunState } from "./state.js";
import { startNodes } from "./validate.js";

export type StepContext = {
  /** Which run of this step this is: 1 the first time, 2 after one loop back, … */
  visit: number;
  /** The recipe's inputs; inside a map, `{ item }` for this item. */
  inputs: Record<string, unknown>;
  /** The step's full key, e.g. `per_shot[P3-04].draw`. */
  key: string;
};

export type Decision = { action: string; selection?: string[]; note?: string };

/** Runs steps. Day 6–7 use fakes; real adapters implement the same shape. */
export interface Executors {
  /** model, tool and agent steps: one output per candidate. */
  produce(node: Node, ctx: StepContext): Record<string, unknown>[];
  /** screen steps: what the human chose. */
  decide(node: ScreenNode, ctx: StepContext): Decision;
}

/** One recipe being run: the top level, or one item of a map. */
type Context = { prefix: string; graph: Graph; inputs: Record<string, unknown> };
type Instance = { key: string; node: Node; ctx: Context };

const ACTIVE: NodeStatus[] = ["ready", "running", "checking", "fixing", "waiting_external", "awaiting_human"];
const ITEM_KEY = /^[A-Za-z0-9_-]+$/;
const MAX_STEPS = 100_000;

export class Scheduler {
  private readonly graphs: Map<string, Graph>;
  private readonly conditions = new Map<Graph, (Expr | undefined)[]>();

  /** `bundle` holds the recipes that `map` steps run (usually every graph loaded from the folder). */
  constructor(
    private readonly graph: Graph,
    private readonly rec: Recorder,
    private readonly exec: Executors,
    bundle: Graph[] = [],
  ) {
    this.graphs = new Map([...bundle, graph].map((g) => [g.graph, g]));
  }

  /** Starts a run: records RunStarted and makes the starting steps ready. */
  start(release: string, inputs: Record<string, unknown> = {}): void {
    this.rec.record({ type: "RunStarted", release, graph: this.graph.graph, inputs });
    for (const id of startNodes(this.graph)) this.rec.record({ type: "NodeReady", node: id });
  }

  /** Runs ready steps until the run finishes. Returns the final state. */
  run(): RunState {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (this.rec.state.status !== "running") return this.rec.state;
      const all = this.instances();
      if (this.settleMaps(all)) continue;
      const next = all.find((x) => this.status(x.key) === "ready");
      if (!next) {
        const top = this.root();
        const failed = Object.values(this.rec.state.nodes).some((n) => n.status === "failed");
        this.rec.record({ type: "RunCompleted", status: this.endReached(top) && !failed ? "completed" : "failed" });
        return this.rec.state;
      }
      this.step(next);
    }
    throw new Error(`run '${this.rec.runId}' took more than ${MAX_STEPS} steps; this is a bug in kriya, not your recipe`);
  }

  // ── Walking the run graph ───────────────────────────────────────────────

  private root(): Context {
    return { prefix: "", graph: this.graph, inputs: this.rec.state.inputs };
  }

  /**
   * Every step instance in a fixed order: the recipe's steps as declared, each
   * expanded map followed by its items in list order. All derived from recorded state.
   */
  private instances(ctx = this.root(), out: Instance[] = []): Instance[] {
    for (const node of ctx.graph.nodes) {
      const key = ctx.prefix + node.id;
      out.push({ key, node, ctx });
      if (node.kind === "map") for (const child of this.children(key, node.graph)) this.instances(child, out);
    }
    return out;
  }

  /** The item contexts of an expanded map step. */
  private children(mapKey: string, graphId: string): Context[] {
    const items = this.rec.state.nodes[mapKey]?.items;
    const graph = this.graphs.get(graphId);
    if (!items || !graph) return [];
    const list = this.readList(items.source, items.version, items.path) ?? [];
    return items.keys.map((k, i) => ({ prefix: `${mapKey}[${k}].`, graph, inputs: { item: list[i] } }));
  }

  private readList(source: string, version: string, path: string[]): unknown[] | undefined {
    let v: unknown = this.rec.state.nodes[source]?.versions[version]?.output;
    for (const k of path) v = v != null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return Array.isArray(v) ? v : undefined;
  }

  private status(key: string): NodeStatus | undefined {
    return this.rec.state.nodes[key]?.status;
  }

  // ── Running one step ────────────────────────────────────────────────────

  private step({ key, node, ctx }: Instance): void {
    const n = this.rec.state.nodes[key]!;
    // Derived from recorded state, never kept in memory, so a resumed run counts the same.
    const visit = (node.kind === "screen" ? n.decisions.length : n.attempts) + 1;
    const sc: StepContext = { visit, inputs: ctx.inputs, key };

    switch (node.kind) {
      case "model":
      case "tool":
      case "agent": {
        const attempt = n.attempts + 1;
        this.rec.record({ type: "AttemptStarted", node: key, attempt });
        const outputs = this.exec.produce(node, sc);
        if (outputs.length === 0) return this.fail(key, "it produced no output");
        outputs.forEach((output, i) =>
          this.rec.record({ type: "CandidateProduced", node: key, attempt, candidate: i + 1, output, parents: [], cost_usd: 0 }),
        );
        this.rec.record({ type: "Locked", node: key, version: versionId(attempt, 1), by: "auto" });
        break;
      }
      case "screen": {
        const ticket = `${key}:${visit}`;
        this.rec.record({ type: "Suspended", node: key, ticket, kind: "human" });
        const d = this.exec.decide(node, sc);
        if (!node.actions.some((a) => a.id === d.action)) throw new Error(`step '${key}' has no button '${d.action}'`);
        this.rec.record({ type: "HumanDecision", node: key, ...d });
        this.rec.record({ type: "Resumed", node: key, ticket });
        break;
      }
      case "map":
        return this.expand(key, node, ctx);
      case "subgraph":
        return this.fail(key, "'subgraph' steps can't run yet (coming in a later update)");
    }
    this.complete(key, ctx);
  }

  /** Starts a map: reads its list and makes each item's first steps ready. */
  private expand(key: string, node: Extract<Node, { kind: "map" }>, ctx: Context): void {
    const n = this.rec.state.nodes[key]!;
    if (n.attempts > 0) return this.fail(key, "running a for-each step a second time isn't supported yet (coming with stale tracking)");
    const child = this.graphs.get(node.graph);
    if (!child) return this.fail(key, `it runs recipe '${node.graph}', which isn't loaded`);

    const [root, ...path] = node.over.split(".");
    const sourceKey = ctx.prefix + root;
    const locked = this.rec.state.nodes[sourceKey]?.locked;
    if (!locked) return this.fail(key, `'${node.over}' isn't locked yet, so there's no list to go through`);
    const list = this.readList(sourceKey, locked.version, path);
    if (!list) return this.fail(key, `'${node.over}' isn't a list`);

    const keys: string[] = [];
    for (const [i, item] of list.entries()) {
      const k = item != null && typeof item === "object" ? (item as Record<string, unknown>)[node.key] : undefined;
      if (typeof k !== "string" && typeof k !== "number") return this.fail(key, `item ${i + 1} of '${node.over}' has no '${node.key}'`);
      const s = String(k);
      if (!ITEM_KEY.test(s)) return this.fail(key, `item key '${s}' can only use letters, digits, - and _`);
      if (keys.includes(s)) return this.fail(key, `two items in '${node.over}' have the same ${node.key} '${s}'`);
      keys.push(s);
    }

    this.rec.record({ type: "AttemptStarted", node: key, attempt: 1 });
    this.rec.record({ type: "MapExpanded", node: key, keys, source: sourceKey, version: locked.version, path });
    for (const k of keys) for (const id of startNodes(child)) this.rec.record({ type: "NodeReady", node: `${key}[${k}].${id}` });
  }

  /**
   * Finishes every expanded map whose items have all stopped: its output is one
   * list per child output, in item order, `null` where an item made nothing.
   * Returns whether it recorded anything.
   */
  private settleMaps(all: Instance[]): boolean {
    for (const { key, node, ctx } of all) {
      if (node.kind !== "map" || this.status(key) !== "running") continue;
      const items = this.children(key, node.graph);
      if (items.some((c) => this.busy(c))) continue;

      const failed = this.rec.state.nodes[key]!.items!.keys.filter((_, i) => !this.endReached(items[i]!) || this.hasFailure(items[i]!));
      if (failed.length > 0) {
        this.fail(key, `${failed.length === 1 ? "item" : "items"} ${failed.join(", ")} didn't finish`);
        return true;
      }
      const child = this.graphs.get(node.graph)!;
      const output: Record<string, unknown> = {};
      for (const [name, ref] of Object.entries(child.outputs)) {
        output[name] = items.map((c) => evaluate(parseCondition(ref), this.scope(c)) ?? null);
      }
      this.rec.record({ type: "CandidateProduced", node: key, attempt: 1, candidate: 1, output, parents: [], cost_usd: 0 });
      this.rec.record({ type: "Locked", node: key, version: versionId(1, 1), by: "auto" });
      this.complete(key, ctx);
      return true;
    }
    return false;
  }

  /** Whether any step of this item (including nested maps) is still going. */
  private busy(c: Context): boolean {
    return Object.entries(this.rec.state.nodes).some(([k, n]) => k.startsWith(c.prefix) && ACTIVE.includes(n.status));
  }

  private hasFailure(c: Context): boolean {
    return Object.entries(this.rec.state.nodes).some(([k, n]) => k.startsWith(c.prefix) && n.status === "failed");
  }

  private complete(key: string, ctx: Context): void {
    this.rec.record({ type: "NodeCompleted", node: key });
    this.follow(key, ctx);
  }

  private fail(key: string, reason: string): void {
    this.rec.record({ type: "NodeFailed", node: key, reason });
  }

  // ── Edges ───────────────────────────────────────────────────────────────

  /** Follows every outgoing edge whose condition holds, within its loop limit. */
  private follow(fromKey: string, ctx: Context): void {
    const from = fromKey.slice(ctx.prefix.length);
    const scope = this.scope(ctx, fromKey);
    const conds = this.conditionsOf(ctx.graph);
    let followed = 0;
    let limited: string | undefined;

    ctx.graph.edges.forEach((edge, i) => {
      const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
      if (!sources.includes(from)) return;
      const cond = conds[i];
      if (cond && !evaluate(cond, scope)) return;

      const edgeKey = ctx.prefix + i;
      if (sources.length > 1) {
        const done = sources.filter((s) => this.status(ctx.prefix + s) === "completed");
        const wait = edge.wait ?? "all";
        if (wait === "all" && done.length < sources.length) return;
        if (wait === "any" && (this.rec.state.edges[edgeKey] ?? 0) > 0) return;
      }

      const count = this.rec.state.edges[edgeKey] ?? 0;
      if (edge.max_loops !== undefined && count >= edge.max_loops) {
        limited = `went back to '${edge.to}' ${count} times, the limit for that loop`;
        return;
      }

      const to = edge.to === END ? END : ctx.prefix + edge.to;
      this.rec.record({ type: "EdgeFollowed", edge: edgeKey, from: fromKey, to });
      followed++;
      if (to !== END) this.rec.record({ type: "NodeReady", node: to });
    });

    if (followed === 0 && limited) this.fail(fromKey, limited);
  }

  /** Whether this recipe (top level or one item) has followed an edge into END. */
  private endReached(ctx: Context): boolean {
    return ctx.graph.edges.some((e, i) => e.to === END && (this.rec.state.edges[ctx.prefix + i] ?? 0) > 0);
  }

  private conditionsOf(g: Graph): (Expr | undefined)[] {
    let c = this.conditions.get(g);
    if (!c) this.conditions.set(g, (c = g.edges.map((e) => (e.when ? parseCondition(e.when) : undefined))));
    return c;
  }

  /**
   * What a condition or output reference can read, within one recipe: each
   * step's locked output by id (a screen's action, selected and note), the
   * recipe's inputs, `item` inside a map, and `action` for the step an edge
   * leaves from. Recorded data only.
   */
  private scope(ctx: Context, fromKey?: string): Record<string, unknown> {
    const s = this.rec.state;
    const scope: Record<string, unknown> = {};
    for (const node of ctx.graph.nodes) {
      const n = s.nodes[ctx.prefix + node.id];
      if (!n) continue;
      if (node.kind === "screen") {
        const d = n.decisions.at(-1);
        if (d) scope[node.id] = { action: d.action, selected: d.selection, note: d.note };
      } else if (n.locked) {
        scope[node.id] = n.versions[n.locked.version]?.output;
      }
    }
    scope.inputs = ctx.inputs;
    scope.item = ctx.inputs.item;
    if (fromKey) scope.action = s.nodes[fromKey]?.decisions.at(-1)?.action;
    return scope;
  }
}
