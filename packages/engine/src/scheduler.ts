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
  /**
   * What the step's `uses` resolve to: locked outputs only, never rejected
   * candidates (rule 3). Library facets (`@look`) arrive on Day 12.
   */
  uses: Record<string, unknown>;
  /** For an edit or a replayed change: the version it starts from. */
  parent?: { version: string; output: Record<string, unknown> };
  /** For an edit or a replayed change: what to change, e.g. "add the gamcha". */
  instruction?: string;
  /** For a screen: the candidates on show (latest attempt of the step it shows), with the shown field. */
  shows?: { version: string; value: unknown }[];
};

export type Decision = { action: string; selection?: string[]; note?: string };

/** Runs steps. Day 6–7 use fakes; real adapters implement the same shape. */
export interface Executors {
  /** model, tool and agent steps: one output per candidate. */
  produce(node: Node, ctx: StepContext): Record<string, unknown>[];
  /** screen steps: what the human chose, or undefined if there's no answer yet (the step waits; see `answer`). */
  decide(node: ScreenNode, ctx: StepContext): Decision | undefined;
}

/** One recipe being run: the top level, or one item of a map. */
type Context = { prefix: string; graph: Graph; inputs: Record<string, unknown> };
type Instance = { key: string; node: Node; ctx: Context };
type Producer = Extract<Node, { kind: "model" | "tool" | "agent" }>;

const isProducer = (n: Node): n is Producer => n.kind === "model" || n.kind === "tool" || n.kind === "agent";

/** The generated approval screen for a step no screen shows (D-42). */
const approvalScreen = (node: Producer): ScreenNode => ({
  id: node.id,
  kind: "screen",
  name: `Approve '${node.name ?? node.id}'`,
  review: "approve",
  show: node.refines ?? node.id,
  beside: [],
  actions: [{ id: "approve", needs: [], locks: true }],
  trust: "ask_me",
  batch: false,
});

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
        // Waiting for a person (or, later, a provider): the run stays open; `answer` continues it.
        if (Object.values(this.rec.state.nodes).some((n) => n.status === "awaiting_human" || n.status === "waiting_external")) {
          return this.rec.state;
        }
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
    switch (node.kind) {
      case "model":
      case "tool":
      case "agent":
        return this.produce(key, node, ctx);
      case "screen":
        return this.show(key, node, ctx);
      case "map":
        return this.expand(key, node, ctx);
      case "subgraph":
        return this.fail(key, "'subgraph' steps can't run yet (coming in a later update)");
    }
  }

  /**
   * Runs a model, tool or agent step. Its candidates go into its own version
   * tree, or into the tree of the step it `refines` (D-44), so a screen showing
   * that step sees the edit. Then the lock policy decides who locks (D-42).
   */
  private produce(key: string, node: Producer, ctx: Context): void {
    const n = this.rec.state.nodes[key]!;
    const target = node.refines ? ctx.prefix + node.refines : key;
    let parent: string | undefined;
    let instruction: string | undefined;
    if (node.refines) {
      const t = this.rec.state.nodes[target];
      if (!t || Object.keys(t.versions).length === 0) return this.fail(key, `there's no '${node.refines}' yet to refine`);
      ({ parent, instruction } = this.refineSource(ctx, node.refines));
    }

    this.rec.record({ type: "AttemptStarted", node: key, attempt: n.attempts + 1 });
    if (target !== key) this.rec.record({ type: "AttemptStarted", node: target, attempt: this.rec.state.nodes[target]!.attempts + 1 });
    const attempt = this.rec.state.nodes[target]!.attempts;
    const sc = this.context(key, node, ctx, n.attempts + 1, target, parent, instruction);
    const outputs = this.exec.produce(node, sc);
    if (outputs.length === 0) return this.fail(key, "it produced no output");
    outputs.forEach((output, i) =>
      this.rec.record({
        type: "CandidateProduced",
        node: target,
        attempt,
        candidate: i + 1,
        output,
        parents: parent ? [parent] : [],
        cost_usd: 0,
        ...(instruction ? { instruction } : {}),
        ...(target !== key ? { made_by: key } : {}),
      }),
    );

    // Who locks it (D-42): a step a screen shows waits for that screen, even a tool;
    // otherwise code output and `trust: always` lock themselves; anything else asks.
    const targetId = node.refines ?? node.id;
    if (!this.reviewer(targetId, ctx)) {
      if (node.kind === "tool" || node.trust === "always") {
        this.rec.record({ type: "Locked", node: target, version: versionId(attempt, 1), by: "auto" });
      } else {
        return this.askApproval(key, node, ctx);
      }
    }
    this.finishProduce(key, node, ctx);
  }

  private finishProduce(key: string, node: Producer, ctx: Context): void {
    if (node.refines) this.rec.record({ type: "NodeCompleted", node: ctx.prefix + node.refines });
    this.complete(key, ctx);
  }

  /** Where a refining step starts from: what the reviewing screen last selected, else the locked or newest version. */
  private refineSource(ctx: Context, targetId: string): { parent: string; instruction?: string } {
    const t = this.rec.state.nodes[ctx.prefix + targetId]!;
    const screen = this.reviewer(targetId, ctx);
    const d = screen ? this.rec.state.nodes[ctx.prefix + screen.id]?.decisions.at(-1) : undefined;
    const parent = d?.selection?.[0] ?? t.locked?.version ?? Object.keys(t.versions).at(-1)!;
    return d?.note ? { parent, instruction: d.note } : { parent };
  }

  /** A screen step: asks, and continues now if the answer is already there. */
  private show(key: string, node: ScreenNode, ctx: Context): void {
    const n = this.rec.state.nodes[key]!;
    const visit = n.decisions.length + 1;
    this.rec.record({ type: "Suspended", node: key, ticket: `${key}:${visit}`, kind: "human" });
    const d = this.exec.decide(node, { ...this.context(key, node, ctx, visit), shows: this.onShow(ctx, node.show) });
    if (d) this.finishScreen(key, node, ctx, d);
  }

  private finishScreen(key: string, node: ScreenNode, ctx: Context, d: Decision): void {
    const button = node.actions.find((a) => a.id === d.action);
    if (!button) throw new Error(`step '${key}' has no button '${d.action}'`);
    this.rec.record({ type: "HumanDecision", node: key, ...clean(d) });
    this.rec.record({ type: "Resumed", node: key, ticket: this.rec.state.nodes[key]!.ticket! });
    if (button.locks && node.show && !this.lockShown(key, node, ctx, d)) return;
    this.complete(key, ctx);
  }

  /**
   * Asks for approval of a step no screen shows, on a generated screen (D-42).
   * `when_confident` asks too until checkers exist (Day 20).
   */
  private askApproval(key: string, node: Producer, ctx: Context): void {
    const n = this.rec.state.nodes[key]!;
    const visit = n.decisions.length + 1;
    this.rec.record({ type: "Suspended", node: key, ticket: `${key}:approve:${visit}`, kind: "human" });
    const screen = approvalScreen(node);
    const d = this.exec.decide(screen, { ...this.context(key, node, ctx, visit), shows: this.onShow(ctx, screen.show) });
    if (d) this.finishApproval(key, node, ctx, d);
  }

  private finishApproval(key: string, node: Producer, ctx: Context, d: Decision): void {
    if (d.action !== "approve") throw new Error(`the approval for '${key}' only has an 'approve' button, not '${d.action}'`);
    this.rec.record({ type: "HumanDecision", node: key, ...clean(d) });
    this.rec.record({ type: "Resumed", node: key, ticket: this.rec.state.nodes[key]!.ticket! });
    const target = node.refines ? ctx.prefix + node.refines : key;
    const version = this.chooseVersion(target, d, this.rec.state.nodes[target]!.attempts, key);
    if (!version) return;
    this.rec.record({ type: "Locked", node: target, version, by: "human", ...(d.note ? { why: d.note } : {}) });
    this.finishProduce(key, node, ctx);
  }

  private context(
    key: string,
    node: Node,
    ctx: Context,
    visit: number,
    target?: string,
    parent?: string,
    instruction?: string,
  ): StepContext {
    const sc: StepContext = { visit, inputs: ctx.inputs, key, uses: this.resolveUses(node, ctx) };
    if (parent && target) sc.parent = { version: parent, output: this.rec.state.nodes[target]!.versions[parent]!.output };
    if (instruction) sc.instruction = instruction;
    return sc;
  }

  // ── Things the creator does mid-run ─────────────────────────────────────

  /** Answers a step that is waiting for a human: a screen or a generated approval. Call `run()` after. */
  answer(key: string, d: Decision): void {
    const inst = this.instances().find((x) => x.key === key);
    if (!inst || this.status(key) !== "awaiting_human") throw new Error(`step '${key}' isn't waiting for an answer`);
    if (inst.node.kind === "screen") this.finishScreen(key, inst.node, inst.ctx, d);
    else if (isProducer(inst.node)) this.finishApproval(key, inst.node, inst.ctx, d);
  }

  /** Locks a version directly (the creator's call, not a screen's). */
  lock(key: string, version: string, why?: string): void {
    const n = this.rec.state.nodes[key];
    if (!n?.versions[version]) throw new Error(`'${key}' has no version ${version}`);
    this.rec.record({ type: "Locked", node: key, version, by: "human", ...(why ? { why } : {}) });
  }

  /** Branches off from a version: later versions of this step go on the new branch. */
  branch(key: string, name: string, from: string): void {
    this.rec.record({ type: "BranchCreated", node: key, branch: name, from });
    this.rec.record({ type: "BranchSwitched", node: key, branch: name });
  }

  switchBranch(key: string, name: string): void {
    this.rec.record({ type: "BranchSwitched", node: key, branch: name });
  }

  /**
   * Re-applies the instruction behind one version onto other instances of the
   * same step, e.g. the gamcha fix on P3-04's panel onto every shot with Bheem
   * (D-30). Each gets a new candidate from its own locked (or newest) version;
   * nothing is locked. Returns the new version ids by key.
   */
  replayChange(sourceKey: string, version: string, onto: string[]): Record<string, string[]> {
    const v = this.rec.state.nodes[sourceKey]?.versions[version];
    if (!v) throw new Error(`'${sourceKey}' has no version ${version}`);
    if (!v.instruction) throw new Error(`version ${version} of '${sourceKey}' wasn't made from an instruction, so there's nothing to replay`);
    const stepId = (v.madeBy ?? sourceKey).split(".").at(-1)!;
    const all = this.instances();
    const made: Record<string, string[]> = {};

    for (const target of onto) {
      const inst = all.find((x) => x.key === target);
      const t = this.rec.state.nodes[target];
      if (!inst || !t || Object.keys(t.versions).length === 0) throw new Error(`'${target}' has nothing yet to replay onto`);
      const step = inst.ctx.graph.nodes.find((n) => n.id === stepId);
      if (!step || !isProducer(step)) throw new Error(`'${target}' has no step '${stepId}' to replay with`);
      const stepKey = inst.ctx.prefix + stepId;
      const parent = t.locked?.version ?? Object.keys(t.versions).at(-1)!;

      const s = this.rec.state.nodes[stepKey];
      if (stepKey !== target) {
        if (!s) this.rec.record({ type: "NodeReady", node: stepKey });
        this.rec.record({ type: "AttemptStarted", node: stepKey, attempt: (this.rec.state.nodes[stepKey]?.attempts ?? 0) + 1 });
      }
      this.rec.record({ type: "AttemptStarted", node: target, attempt: t.attempts + 1 });
      const attempt = this.rec.state.nodes[target]!.attempts;
      const visit = this.rec.state.nodes[stepKey]!.attempts;
      const outputs = this.exec.produce(step, this.context(stepKey, step, inst.ctx, visit, target, parent, v.instruction));
      made[target] = outputs.map((output, i) => {
        this.rec.record({
          type: "CandidateProduced",
          node: target,
          attempt,
          candidate: i + 1,
          output,
          parents: [parent],
          cost_usd: 0,
          instruction: v.instruction!,
          replayed_from: `${sourceKey}@${version}`,
          ...(stepKey !== target ? { made_by: stepKey } : {}),
        });
        return versionId(attempt, i + 1);
      });
      // Back to rest: the new candidates wait to be locked; nothing downstream moves.
      this.rec.record({ type: "NodeCompleted", node: target });
      if (stepKey !== target) this.rec.record({ type: "NodeCompleted", node: stepKey });
    }
    return made;
  }

  /** What a screen shows: the latest attempt's candidates of the shown step, with the shown field. */
  private onShow(ctx: Context, show: string | undefined): { version: string; value: unknown }[] {
    if (!show) return [];
    const [root, ...path] = show.split(".");
    const t = this.rec.state.nodes[ctx.prefix + root];
    if (!t) return [];
    return Object.values(t.versions)
      .filter((v) => v.attempt === t.attempts)
      .map((v) => {
        let value: unknown = v.output;
        for (const k of path) value = value != null && typeof value === "object" ? (value as Record<string, unknown>)[k] : undefined;
        return { version: v.id, value };
      });
  }

  /** The screen in this recipe that shows a step, if any. */
  private reviewer(stepId: string, ctx: Context): ScreenNode | undefined {
    return ctx.graph.nodes.find((n): n is ScreenNode => n.kind === "screen" && n.show?.split(".")[0] === stepId);
  }

  /** A locking button on a screen locks the chosen version of the step it shows. */
  private lockShown(screenKey: string, screen: ScreenNode, ctx: Context, d: Decision): boolean {
    const target = ctx.prefix + screen.show!.split(".")[0];
    const t = this.rec.state.nodes[target];
    if (!t || Object.keys(t.versions).length === 0) {
      this.fail(screenKey, `there's nothing from '${screen.show}' to lock yet`);
      return false;
    }
    const version = this.chooseVersion(target, d, t.attempts, screenKey);
    if (!version) return false;
    this.rec.record({ type: "Locked", node: target, version, by: "human", ...(d.note ? { why: d.note } : {}) });
    return true;
  }

  /**
   * Which version a decision means: the one selected, or the only candidate of
   * the latest attempt. Fails plainly when it's ambiguous or doesn't exist.
   */
  private chooseVersion(target: string, d: Decision, attempt: number, failKey = target): string | undefined {
    const t = this.rec.state.nodes[target]!;
    if (d.selection && d.selection.length > 0) {
      if (d.selection.length > 1) return void this.fail(failKey, "pick exactly one version to lock");
      const id = d.selection[0]!;
      if (!t.versions[id]) return void this.fail(failKey, `version ${id} of '${target}' doesn't exist`);
      return id;
    }
    const latest = Object.values(t.versions).filter((v) => v.attempt === attempt);
    if (latest.length !== 1) return void this.fail(failKey, `pick one of the ${latest.length} options of '${target}' to lock`);
    return latest[0]!.id;
  }

  /** Resolves a step's `uses` against locked outputs only. */
  private resolveUses(node: Node, ctx: Context): Record<string, unknown> {
    if (!("uses" in node)) return {};
    const scope = this.scope(ctx);
    const out: Record<string, unknown> = {};
    for (const ref of node.uses) if (!ref.includes("@")) out[ref] = evaluate(parseCondition(ref), scope);
    return out;
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
        if (d) scope[node.id] = { action: d.action, selected: this.selected(ctx, node, d), note: d.note };
      } else if (n.locked) {
        scope[node.id] = n.versions[n.locked.version]?.output;
      }
    }
    scope.inputs = ctx.inputs;
    scope.item = ctx.inputs.item;
    if (fromKey) {
      const from = s.nodes[fromKey];
      scope.action = from?.decisions.at(-1)?.action;
      // D-43: an edge may read the candidate its source step just made as `result`.
      const id = fromKey.slice(ctx.prefix.length);
      const node = ctx.graph.nodes.find((n) => n.id === id);
      const made = node && "refines" in node && node.refines ? s.nodes[ctx.prefix + node.refines] : from;
      scope.result = made ? Object.values(made.versions).at(-1)?.output : undefined;
    }
    return scope;
  }

  /**
   * A screen's `selected`: the shown field (`show: draw.image` → the image) of
   * the version the decision chose: the selected one, or the one it locked.
   */
  private selected(ctx: Context, screen: ScreenNode, d: { selection?: string[] | undefined }): unknown {
    if (!screen.show) return d.selection;
    const [root, ...path] = screen.show.split(".");
    const t = this.rec.state.nodes[ctx.prefix + root];
    if (!t) return undefined;
    const ids = d.selection && d.selection.length > 0 ? d.selection : t.locked ? [t.locked.version] : [];
    const values = ids.map((id) => {
      let v: unknown = t.versions[id]?.output;
      for (const k of path) v = v != null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      return v;
    });
    return values.length === 1 ? values[0] : values;
  }
}

/** Drops undefined fields, which can't be recorded. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
