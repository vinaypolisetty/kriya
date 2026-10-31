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
 * Everything that leaves the engine goes through the interfaces below
 * (`Executors`, `Tools`, `Blobs`, `Assets`). Events between two outside calls
 * are written in one transaction (`atomic`), and committed before each call
 * (`external`), so a crash falls between calls, never inside a step (D-46).
 *
 * Not built yet: `subgraph` steps, run upgrades, proposals for locked nodes (D-28).
 */
import { contextMode, END, SO_FAR, stepText, type AgentNode, type Graph, type Node, type ScreenNode } from "./spec.js";
import { createHash } from "node:crypto";
import { evaluate, parseCondition, type Expr } from "./condition.js";
import { versionId } from "./events.js";
import type { Recorder } from "./recorder.js";
import type { NodeState, NodeStatus, RunState, Verdict, Version } from "./state.js";
import { promptRefs, startNodes } from "./validate.js";

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
  /** For a step with `send`: the text to send word for word. Nothing is added to it. */
  send?: string;
  /** For a refining step: the region the person marked on the screen (`--region`), e.g. for a crop. */
  region?: unknown;
  /** For an adopt: the other version to take from ("use its ending"); `parent` is the one it builds on. */
  borrow?: { version: string; output: Record<string, unknown> };
  /** For a screen: the candidates on show (latest attempt of the step it shows), with the shown field and what its checks said. */
  shows?: Shown[];
  /** For a model, tool or agent call: the same for every try of this attempt, across crashes (`run/step#attempt`). */
  idempotencyKey?: string;
  /** Asset facet versions in what it received, `Entity.facet` → version. */
  assets?: Record<string, string>;
  /** For an agent: its working notes (`note` tool), latest per key, always in its prompt (D-39). */
  notes?: Record<string, string>;
};

export type Decision = { action: string; selection?: string[]; note?: string; region?: unknown; by?: "human" | "auto" };

/** One thing waiting on a person: a screen, or a generated approval. */
/** One candidate on a screen: its version, the shown field, and its checks (all passed or not, and the issues). */
export type Shown = { version: string; value: unknown; verdict?: { pass: boolean; issues: Verdict["issues"] } };

/** What a judge said about one candidate (`check.rubric`). */
export type Judged = { version: string; pass: boolean; issues: Verdict["issues"]; model?: string; cost_usd?: number };

export type InboxItem = {
  key: string;
  title: string;
  review: ScreenNode["review"];
  shows: Shown[];
  /** What the recipe puts beside the candidates (`beside:`), e.g. the line to be spoken and its caption. */
  beside: { ref: string; value: unknown }[];
  buttons: { id: string; label?: string; needs: ("selection" | "note" | "region")[]; locks: boolean }[];
};

/** Runs steps. Day 6–7 use fakes; real adapters implement the same shape. */
export interface Executors {
  /**
   * model, tool and agent steps: one output per candidate, or a ticket for a job
   * that finishes later (the step waits; see `deliver`). Use `ctx.idempotencyKey`
   * when submitting to a provider, so asking again after a crash never pays twice.
   */
  produce(node: Node, ctx: StepContext): Record<string, unknown>[] | { ticket: string };
  /**
   * Judges a step's candidates against its `check.rubric` (Day 20): one verdict
   * per candidate, or `{ ticket: "check:" + ctx.idempotencyKey }` for a judge
   * that answers later (see `deliverVerdicts`). Without it, a rubric fails the step.
   */
  check?(node: Producer, ctx: StepContext, candidates: { version: string; output: Record<string, unknown> }[]): Judged[] | { ticket: string };
  /** screen steps: what the human chose, or undefined if there's no answer yet (the step waits; see `answer`). */
  decide(node: ScreenNode, ctx: StepContext): Decision | undefined;
  /**
   * agent steps: one model call, one turn (D-26). The engine owns the loop: it
   * records the reply, runs the tools, and decides whether there's another turn.
   * `history` is this attempt's earlier turns, rebuilt from the log on resume.
   */
  turn?(node: AgentNode, ctx: StepContext, history: AgentHistory): AgentTurnResult | Pending;
  /**
   * The provider trims old tool results itself, server-side (e.g. Claude's context
   * editing), so the engine sends history unchanged: rewriting earlier turns would
   * break providers that check the conversation is append-only.
   */
  managesContext?: boolean;
}

/**
 * What an agent asks for on one turn: tools to call (in order), or its final
 * output. `raw` is the provider's own reply (e.g. Claude's content blocks),
 * recorded so the next turn can send the conversation back exactly.
 */
export type AgentReply = ({ calls: { tool: string; args?: unknown }[] } | { final: Record<string, unknown> }) & { raw?: unknown };

export type AgentTurnResult = {
  reply: AgentReply;
  tokens: { input: number; output: number };
  /** Exact provider model version (rule 6). */
  model: string;
  cost_usd: number;
  /** The model's context window, when known: clearing starts at 70% of it (D-39 step 2). */
  context_window?: number;
};

/** An agent's earlier turns in this attempt, with what each tool returned. */
export type AgentHistory = { turn: number; reply: AgentReply; results: { call: number; tool: string; ok: boolean; result: unknown }[] }[];

/**
 * The tools agents can call. Throw to report a failure: the agent is told and
 * carries on. A slow tool returns `new Pending(ticket)` and the agent waits for
 * `deliverTool(ticket, result)`. A tool with side effects (post, send, pay) must
 * use `idempotencyKey`, because a crash after it ran but before its result was
 * recorded runs it again with the same key.
 */
export interface Tools {
  call(tool: string, args: unknown, ctx: { key: string; idempotencyKey: string }): unknown;
  /** What a model is told about a tool: a description and a JSON Schema for its arguments. */
  describe?(tool: string): ToolSpec | undefined;
}

/** What a provider reports about one call: the exact model version, what it cost, and exactly what it was asked. */
export type CallMeta = { model?: string; cost_usd?: number; prompt?: string; references?: { label: string; ref: string }[] };

export type ToolSpec = { description: string; input_schema: Record<string, unknown> };

/**
 * What a slow call returns instead of its result: a model job, an agent turn or
 * a tool. The step waits on the ticket until it's delivered (`deliver`,
 * `deliverTurn`, `deliverTool`) or fails (`failJob`). Asking again with the same
 * idempotency key must give back the same ticket.
 */
export class Pending {
  constructor(readonly ticket: string) {}
}

/**
 * Tools every agent has, run by the engine itself (D-39, D-52): `ask_human`
 * asks you and waits, `recall` reads back a large result, `note` keeps working
 * memory, and the file tools work on the step's own workspace.
 */
export const BUILT_IN_TOOLS = ["ask_human", "recall", "note", "write_file", "read_file", "list_files"] as const;

/** A workspace path: relative, with no `..`, like `drafts/part3.md`. */
const FILE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** What the built-in tools take, for models that need a schema. */
export const BUILT_IN_TOOL_SPECS: Record<(typeof BUILT_IN_TOOLS)[number], ToolSpec> = {
  ask_human: {
    description: "Ask the person running this step a question and wait for their answer. Use it when you need a decision or a fact only they have.",
    input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
  },
  recall: {
    description: "Read back a large earlier tool result by its hash, in pieces of up to 8,000 characters.",
    input_schema: { type: "object", properties: { hash: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } }, required: ["hash"], additionalProperties: false },
  },
  note: {
    description: "Save a working note under a key. Your notes are shown to you on every later turn; a new note replaces the old one for the same key.",
    input_schema: { type: "object", properties: { key: { type: "string" }, text: { type: "string" } }, required: ["key", "text"], additionalProperties: false },
  },
  write_file: {
    description: "Write a text file in your workspace (replaces it if it exists). Paths are relative, like drafts/part3.md.",
    input_schema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"], additionalProperties: false },
  },
  read_file: {
    description: "Read a file from your workspace, in pieces of up to 8,000 characters.",
    input_schema: { type: "object", properties: { path: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } }, required: ["path"], additionalProperties: false },
  },
  list_files: {
    description: "List the files in your workspace with their sizes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
};

/** A tool result longer than this (about 2k tokens) reaches the agent as a preview it can `recall`. */
export const OFFLOAD_CHARS = 8000;
const PREVIEW_CHARS = 400;
/** Clearing (D-39 step 2): once a turn uses 70% of the context window, older results become stubs; the last 6 turns stay. */
const CLEAR_AT = 0.7;
const KEEP_TURNS = 6;

/** Content-addressed storage for tool results (the store's blob folder, or memory in tests). */
export interface Blobs {
  /** Stores a JSON value and returns its content hash. */
  put(value: unknown): string;
  get(hash: string): unknown;
}

/** Blobs kept in memory: fine for tests and a single process, gone after a restart. */
export function memoryBlobs(): Blobs {
  const m = new Map<string, string>();
  return {
    put(value) {
      const h = hash(value);
      m.set(h, JSON.stringify(value ?? null));
      return h;
    },
    get(h) {
      const s = m.get(h);
      if (s === undefined) throw new Error(`there's no stored result ${h}`);
      return JSON.parse(s);
    },
  };
}

/** Where asset facets come from (the Library, Day 18). Behind an interface so tests use fakes. */
export interface Assets {
  /** The locked version of one facet of one entity, e.g. ("Bheem", "look"), or undefined if it doesn't exist yet. */
  facet(entity: string, facet: string): { version: string; value: unknown } | undefined;
}

/** What a step receives, by its context mode (D-47). */
type Received = { uses: Record<string, unknown>; assets: Record<string, string>; missing: string[]; parent: boolean };

/** One recipe being run: the top level, or one item of a map. */
type Context = { prefix: string; graph: Graph; inputs: Record<string, unknown> };
type Instance = { key: string; node: Node; ctx: Context };
type Producer = Extract<Node, { kind: "model" | "tool" | "agent" }>;

const isFinal = (r: unknown): r is { final: Record<string, unknown> } => r != null && typeof r === "object" && "final" in r;

const isProducer = (n: Node): n is Producer => n.kind === "model" || n.kind === "tool" || n.kind === "agent";

/** The screen for an agent's `ask_human`: the question, answered with a note. */
const questionScreen = (node: AgentNode, question: string): ScreenNode => ({
  id: node.id,
  kind: "screen",
  name: `${node.name ?? node.id} asks: ${question}`,
  review: "edit_text",
  beside: [],
  actions: [{ id: "reply", needs: ["note"], locks: false }],
  trust: "ask_me",
  batch: false,
});

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

const ACTIVE: NodeStatus[] = ["blocked", "ready", "running", "checking", "fixing", "waiting_external", "awaiting_human"];
const ITEM_KEY = /^[A-Za-z0-9_-]+$/;
const MAX_STEPS = 100_000;
/** A map's source when its list is the recipe's own inputs (`inputs.filings`): the key `inputs`, the version `inputs`. */
export const INPUTS = "inputs";

export class Scheduler {
  private readonly graphs: Map<string, Graph>;
  private readonly conditions = new Map<Graph, (Expr | undefined)[]>();

  private readonly assets: Assets;
  private readonly tools: Tools;
  private readonly blobs: Blobs;

  /** `bundle` holds the recipes that `map` steps run (usually every graph loaded from the folder). */
  constructor(
    private readonly graph: Graph,
    private readonly rec: Recorder,
    private readonly exec: Executors,
    bundle: Graph[] = [],
    options: { assets?: Assets; tools?: Tools; blobs?: Blobs } = {},
  ) {
    // By id and by any id a recipe had before (D-78), so a for-each naming an old id still finds it.
    this.graphs = new Map([...bundle, graph].flatMap((g) => [g.graph, ...(g.was ?? [])].map((id) => [id, g] as const)));
    this.assets = options.assets ?? { facet: () => undefined };
    this.tools = options.tools ?? { call: () => { throw new Error("no tools are set up"); } };
    this.blobs = options.blobs ?? memoryBlobs();
  }

  /** Starts a run: records RunStarted and makes the starting steps ready. */
  start(release: string, inputs: Record<string, unknown> = {}, context: Record<string, Record<string, unknown>> = {}): void {
    for (const g of this.recipesUsed()) {
      for (const level of g.inherits) {
        if (!context[level]) throw new Error(`recipe '${g.graph}' reads from '${level}', but the run wasn't given any '${level}' context`);
      }
    }
    this.atomic(() => {
      this.rec.record({ type: "RunStarted", release, graph: this.graph.graph, inputs, context });
      for (const id of startNodes(this.graph)) this.rec.record({ type: "NodeReady", node: id });
    });
  }

  /** Runs ready steps until the run finishes. Returns the final state. */
  run(): RunState {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (this.rec.state.status !== "running") return this.rec.state;
      const all = this.instances();
      if (this.atomic(() => this.settleMaps(all))) continue;
      const next = all.find((x) => this.status(x.key) === "ready");
      if (!next && this.atomic(() => this.rejoin(all))) continue;
      if (!next) {
        // Waiting for a person, a provider job or a missing asset: the run stays open.
        if (Object.values(this.rec.state.nodes).some((n) => n.status === "awaiting_human" || n.status === "waiting_external" || n.status === "blocked")) {
          return this.rec.state;
        }
        const top = this.root();
        const failed = Object.values(this.rec.state.nodes).some((n) => n.status === "failed");
        // Stale work waits for a rebuild or a keep; it hasn't failed. A finished run whose
        // recipe changed under it ended "failed" with nothing failed (Oct 27, a step added after pick).
        if (!failed && !this.endReached(top) && Object.values(this.rec.state.nodes).some((n) => n.status === "stale")) return this.rec.state;
        this.atomic(() => this.rec.record({ type: "RunCompleted", status: this.endReached(top) && !failed ? "completed" : "failed" }));
        return this.rec.state;
      }
      this.atomic(() => this.step(next));
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
  private instances(ctx = this.root(), out: Instance[] = [], current = false): Instance[] {
    for (const node of ctx.graph.nodes) {
      const key = ctx.prefix + node.id;
      out.push({ key, node, ctx });
      if (node.kind === "map") {
        const kids = current ? this.currentChildren(key, node, ctx) : this.children(key, node.graph);
        for (const child of kids) this.instances(child, out, current);
      }
    }
    return out;
  }

  /**
   * A map's items as its list reads *now* (the source's current lock), for
   * stale checks before the map runs again. Items no longer in the list are
   * left out: they're parked.
   */
  private currentChildren(mapKey: string, node: Extract<Node, { kind: "map" }>, ctx: Context): Context[] {
    const graph = this.graphs.get(node.graph);
    const from = this.listSource(node.over, ctx);
    const list = graph && "source" in from ? this.readList(from.source, from.version, from.path) : undefined;
    if (!graph || !list) return this.children(mapKey, node.graph);
    return list.flatMap((item) => {
      const k = itemKey(item, node.key);
      return typeof k === "string" || typeof k === "number" ? [{ prefix: `${mapKey}[${k}].`, graph, inputs: { item } }] : [];
    });
  }

  /** The item contexts of an expanded map step. */
  private children(mapKey: string, graphId: string): Context[] {
    const items = this.rec.state.nodes[mapKey]?.items;
    const graph = this.graphs.get(graphId);
    if (!items || !graph) return [];
    const list = this.readList(items.source, items.version, items.path) ?? [];
    return items.keys.map((k, i) => ({ prefix: `${mapKey}[${k}].`, graph, inputs: { item: list[i] } }));
  }

  /**
   * Where a map's list comes from: a step's locked output (`shot_list.shots`),
   * or, since D-73, this recipe's own inputs (`inputs.filings`, or `item.lines`
   * inside another map). Inputs are recorded already (the run's at RunStarted,
   * an item's in its parent's list), so the map reads recorded data either way.
   */
  private listSource(over: string, ctx: Context): { source: string; version: string; path: string[] } | { missing: string } {
    const [root, ...path] = over.split(".");
    if (root === "inputs" || root === "item") return { source: `${ctx.prefix}${INPUTS}`, version: INPUTS, path: root === "item" ? ["item", ...path] : path };
    const locked = this.rec.state.nodes[ctx.prefix + root]?.locked;
    return locked ? { source: ctx.prefix + root, version: locked.version, path } : { missing: `'${over}' isn't locked yet, so there's no list to go through` };
  }

  /** The inputs of the recipe at `prefix`: the run's at the top, an item's inside a map. Also what `kriya web` shows on a run's Inputs box. */
  inputsAt(prefix: string): Record<string, unknown> | undefined {
    if (prefix === "") return this.rec.state.inputs;
    // `per_company[ACME].` → ACME's entry in the list per_company went through, read from its record.
    const [, mapKey, k] = /^(.*)\[([^\]]+)\]\.$/.exec(prefix) ?? [];
    const items = mapKey ? this.rec.state.nodes[mapKey]?.items : undefined;
    if (!items) return undefined;
    const list = this.readList(items.source, items.version, items.path);
    return list ? { item: list[items.keys.indexOf(k!)] } : undefined;
  }

  private readList(source: string, version: string, path: string[]): unknown[] | undefined {
    let v: unknown = version === INPUTS ? this.inputsAt(source.slice(0, -INPUTS.length)) : this.rec.state.nodes[source]?.versions[version]?.output;
    for (const k of path) v = v != null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    if (Array.isArray(v)) return v;
    // A for-each step's results, as a whole (`over: find`, D-74): one row per item, its outputs
    // side by side and its key as `id`, so a second for-each goes through what the first made.
    const keys = path.length === 0 ? this.rec.state.nodes[source]?.items?.keys : undefined;
    if (!keys || !v || typeof v !== "object") return undefined;
    const columns = Object.entries(v as Record<string, unknown>);
    if (!columns.every(([, c]) => Array.isArray(c) && c.length === keys.length)) return undefined;
    return keys.map((id, i) => ({ id, ...Object.fromEntries(columns.map(([f, c]) => [f, (c as unknown[])[i]])) }));
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

    // A missing facet (Tiwari has no look yet) blocks the step until it exists; nothing is spent.
    const missing = this.received(key, node, ctx).missing;
    if (missing.length > 0) return void this.rec.record({ type: "NodeBlocked", node: key, reason: [...new Set(missing)].join("; ") });

    this.rec.record({ type: "AttemptStarted", node: key, attempt: n.attempts + 1 });
    if (target !== key) this.rec.record({ type: "AttemptStarted", node: target, attempt: this.rec.state.nodes[target]!.attempts + 1 });
    this.call(key, node, ctx);
  }

  /**
   * The outside call of a started attempt, then everything that follows it.
   * `recover` calls this again for an attempt that was in flight at a crash:
   * same attempt, same idempotency key, so the provider doesn't charge twice.
   */
  private call(key: string, node: Producer, ctx: Context): void {
    if (node.kind === "agent") return this.agent(key, node, ctx);
    const sc = this.produceRequest(key, node, ctx);
    if (node.kind === "model" && node.send && sc.send === undefined) return this.fail(key, `it sends '${node.send}', and there's no text there to send`);
    const result = this.external(() => this.exec.produce(node, sc));
    if (!Array.isArray(result)) {
      this.rec.record({ type: "Suspended", node: key, ticket: result.ticket, kind: "model_job" });
      return;
    }
    this.accept(key, node, ctx, result);
  }

  /**
   * An agent's turns (D-26), from wherever the attempt is: finish the tool
   * calls of the last turn, then check the limits, then take one more turn.
   * Each model call and each tool call is an outside call, so everything before
   * it is written first; after a crash, `recover` lands here and picks up at the
   * same turn, asking again with the same idempotency key.
   */
  private agent(key: string, node: AgentNode, ctx: Context): void {
    const turn = this.exec.turn?.bind(this.exec);
    if (!turn) return this.fail(key, "agent steps need an agent runner, and none is set up");
    for (;;) {
      const n = this.rec.state.nodes[key]!;
      const base = `${this.rec.runId}/${key}#${n.attempts}`;
      const last = n.history.at(-1);
      if (last && isFinal(last.response)) return this.accept(key, node, ctx, [last.response.final]);

      // The last turn's calls, in order. A question or a slow tool pauses the agent right there.
      for (const c of last?.calls.filter((x) => x.ok === undefined) ?? []) {
        const ticket = `${key}:t${last!.turn}.c${c.call}`;
        if (c.tool === "ask_human") {
          this.rec.record({ type: "Suspended", node: key, ticket, kind: "human" });
          return this.askAgent(key, node, ctx);
        }
        const { ok, result } = this.runTool(key, node, c, `${base}/t${last!.turn}.c${c.call}`);
        if (result instanceof Pending) return void this.rec.record({ type: "Suspended", node: key, ticket: result.ticket, kind: "tool_job" });
        this.rec.record({ type: "ToolResult", node: key, turn: last!.turn, call: c.call, ok, result: this.blobs.put(result) });
      }

      const used = n.history.length;
      const spent = n.history.reduce((s, h) => s + h.cost, 0);
      if (used >= node.max_turns) return this.fail(key, `it used all ${node.max_turns} of its turns without finishing; raise max_turns or narrow the goal`);
      if (node.budget && spent >= node.budget.usd) return this.fail(key, `it spent $${spent.toFixed(2)} of its $${node.budget.usd.toFixed(2)} budget without finishing`);

      const { sc, history } = this.turnRequest(key, node, ctx);
      const r = this.external(() => turn(node, sc, history));
      if (r instanceof Pending) return void this.rec.record({ type: "Suspended", node: key, ticket: r.ticket, kind: "model_job" });
      if (!this.recordTurn(key, r)) return;
    }
  }

  /** What the next turn is asked with: the same every time for the same recorded state, so a resubmission matches. */
  private turnRequest(key: string, node: AgentNode, ctx: Context): { sc: StepContext; history: AgentHistory } {
    const n = this.rec.state.nodes[key]!;
    const sc = this.context(key, node, ctx, n.attempts);
    sc.idempotencyKey = `${this.rec.runId}/${key}#${n.attempts}/t${n.history.length + 1}`;
    const notes = this.agentNotes(key);
    if (Object.keys(notes).length > 0) sc.notes = notes;
    return { sc, history: this.agentHistory(key) };
  }

  /** Records one turn's reply and the tool calls it asks for. False if the step failed. */
  private recordTurn(key: string, r: AgentTurnResult): boolean {
    const t = this.rec.state.nodes[key]!.turns + 1;
    this.rec.record({ type: "AgentTurn", node: key, turn: t, response: r.reply, tokens: r.tokens, model: r.model, cost_usd: r.cost_usd, ...(r.context_window ? { context_window: r.context_window } : {}) });
    if (isFinal(r.reply)) return true; // accepted at the top of the loop
    if (!Array.isArray(r.reply.calls) || r.reply.calls.length === 0) {
      this.fail(key, "the agent answered with neither a tool call nor a final answer");
      return false;
    }
    r.reply.calls.forEach((c, i) => this.rec.record({ type: "ToolCalled", node: key, turn: t, call: i + 1, tool: c.tool, args: c.args ?? null }));
    return true;
  }

  /**
   * One tool call: a built-in, or the step's own tools. Only the tool's own
   * failure goes back to the agent; a failed write before the call is a crash.
   */
  private runTool(key: string, node: AgentNode, c: { tool: string; args: unknown }, idempotencyKey: string): { ok: boolean; result: unknown } {
    const failed = (error: string) => ({ ok: false, result: { error } });
    const args = (c.args ?? {}) as Record<string, unknown>;
    if (c.tool === "recall") {
      const h = this.rec.state.nodes[key]!.history.flatMap((x) => x.calls).find((x) => x.result === args.hash);
      if (!h) return failed(`there's no result ${String(args.hash)} in this step's history`);
      const text = JSON.stringify(this.blobs.get(h.result!));
      const from = Math.max(0, Number(args.from ?? 0) || 0);
      const to = Math.min(text.length, from + OFFLOAD_CHARS, Number(args.to ?? text.length) || text.length);
      return { ok: true, result: { hash: args.hash, from, to, size: text.length, text: text.slice(from, to) } };
    }
    if (c.tool === "note") {
      if (typeof args.key !== "string" || typeof args.text !== "string") return failed("note needs a key and a text, e.g. { key: 'plan', text: '…' }");
      return { ok: true, result: { saved: args.key } };
    }
    if (c.tool === "write_file") {
      if (typeof args.path !== "string" || !FILE_PATH.test(args.path) || args.path.length > 200) return failed(`write_file needs a relative path like 'drafts/part3.md' (letters, digits, . _ - and /, no '..'), not ${JSON.stringify(args.path)}`);
      if (typeof args.text !== "string") return failed("write_file needs the file's text");
      return { ok: true, result: { path: args.path, hash: this.blobs.put(args.text), size: args.text.length } };
    }
    if (c.tool === "read_file") {
      const f = typeof args.path === "string" ? this.workspace(key)[args.path] : undefined;
      if (!f) return failed(`there's no file ${JSON.stringify(args.path)} in this step's workspace (${Object.keys(this.workspace(key)).join(", ") || "it's empty"})`);
      const text = this.blobs.get(f.hash) as string;
      const from = Math.max(0, Number(args.from ?? 0) || 0);
      const to = Math.min(text.length, from + OFFLOAD_CHARS, Number(args.to ?? text.length) || text.length);
      return { ok: true, result: { path: args.path, from, to, size: text.length, text: text.slice(from, to) } };
    }
    if (c.tool === "list_files") {
      return { ok: true, result: { files: Object.entries(this.workspace(key)).sort(([a], [b]) => a.localeCompare(b)).map(([path, f]) => ({ path, size: f.size })) } };
    }
    if (!node.tools.includes(c.tool)) return failed(`'${c.tool}' isn't one of this step's tools (${[...node.tools, ...BUILT_IN_TOOLS].join(", ")})`);
    return this.external(() => {
      try {
        return { ok: true, result: this.tools.call(c.tool, c.args, { key, idempotencyKey }) };
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
    });
  }

  /**
   * This attempt's turns as the agent sees them, results read back by hash.
   * A large result arrives as a preview with its hash, for `recall` (D-39 step 1).
   */
  private agentHistory(key: string): AgentHistory {
    // Clearing (D-39 step 2), in batches: each time a turn reached 70% of the context window,
    // results older than the last 6 turns became stubs. Decided from recorded token counts only.
    let clearedUpTo = 0;
    for (const h of this.exec.managesContext ? [] : this.rec.state.nodes[key]!.history) {
      if (h.window && h.tokensIn >= CLEAR_AT * h.window) clearedUpTo = h.turn - KEEP_TURNS;
    }
    return this.rec.state.nodes[key]!.history.map((h) => ({
      turn: h.turn,
      reply: h.response as AgentReply,
      results: h.calls
        .filter((c) => c.ok !== undefined)
        .map((c) => {
          // Your answers and the agent's own notes are never cleared.
          if (h.turn <= clearedUpTo && c.tool !== "ask_human" && c.tool !== "note") {
            return { call: c.call, tool: c.tool, ok: c.ok!, result: { cleared: c.result!, note: "cleared to save context; recall it by hash if you need it" } };
          }
          const value = this.blobs.get(c.result!);
          const text = JSON.stringify(value);
          const result = c.tool !== "recall" && c.tool !== "read_file" && text.length > OFFLOAD_CHARS ? { offloaded: c.result!, size: text.length, preview: text.slice(0, PREVIEW_CHARS) } : value;
          return { call: c.call, tool: c.tool, ok: c.ok!, result };
        }),
    }));
  }

  /**
   * The step's workspace: every file it wrote in this attempt, latest write per
   * path. Folded from history, contents in blobs by hash, so replay rebuilds it exactly.
   */
  private workspace(key: string): Record<string, { hash: string; size: number }> {
    const files: Record<string, { hash: string; size: number }> = {};
    for (const h of this.rec.state.nodes[key]!.history) {
      for (const c of h.calls) {
        if (c.tool !== "write_file" || !c.ok) continue;
        const r = this.blobs.get(c.result!) as { path: string; hash: string; size: number };
        files[r.path] = { hash: r.hash, size: r.size };
      }
    }
    return files;
  }

  /** The agent's working notes: the latest successful `note` per key, in this attempt. */
  private agentNotes(key: string): Record<string, string> {
    const notes: Record<string, string> = {};
    for (const h of this.rec.state.nodes[key]!.history) {
      for (const c of h.calls) {
        const a = c.args as { key?: unknown; text?: unknown } | null;
        if (c.tool === "note" && c.ok && typeof a?.key === "string" && typeof a.text === "string") notes[a.key] = a.text;
      }
    }
    return notes;
  }

  /** The `ask_human` call the agent is waiting on, if any. */
  private openQuestion(key: string): { turn: number; call: number; question: string } | undefined {
    const n = this.rec.state.nodes[key];
    const last = n?.history.at(-1);
    const c = last?.calls.find((x) => x.ok === undefined);
    if (!n || n.status !== "awaiting_human" || !last || c?.tool !== "ask_human") return undefined;
    const q = (c.args as { question?: unknown } | null)?.question;
    return { turn: last.turn, call: c.call, question: typeof q === "string" ? q : JSON.stringify(c.args) };
  }

  /** Puts the agent's question in front of the person (again, after a crash), and carries on if they've answered. */
  private askAgent(key: string, node: AgentNode, ctx: Context): void {
    const q = this.openQuestion(key)!;
    const screen = questionScreen(node, q.question);
    const visit = this.rec.state.nodes[key]!.decisions.length + 1;
    const d = this.external(() => this.exec.decide(screen, { ...this.context(key, node, ctx, visit), shows: [] }));
    if (d) this.finishQuestion(key, node, ctx, d);
  }

  private finishQuestion(key: string, node: AgentNode, ctx: Context, d: Decision): void {
    const q = this.openQuestion(key)!;
    if (d.action !== "reply" || !d.note?.trim()) throw new Error(`'${key}' asked you: "${q.question}". Answer with 'reply' and your answer as the note`);
    this.rec.record({ type: "HumanDecision", node: key, ...clean(d) });
    this.rec.record({ type: "Resumed", node: key, ticket: this.rec.state.nodes[key]!.ticket! });
    this.rec.record({ type: "ToolResult", node: key, turn: q.turn, call: q.call, ok: true, result: this.blobs.put({ answer: d.note }) });
    this.agent(key, node, ctx);
  }

  /** What a model or tool step is asked with: the same every time for the same recorded state. */
  private produceRequest(key: string, node: Producer, ctx: Context): StepContext {
    const n = this.rec.state.nodes[key]!;
    const target = node.refines ? ctx.prefix + node.refines : key;
    const { parent, instruction, region } = this.source(key, node, ctx);
    const sc = this.context(key, node, ctx, n.attempts, target, parent, instruction);
    if (region !== undefined) sc.region = region;
    sc.idempotencyKey = `${this.rec.runId}/${key}#${n.attempts}`;
    if (node.kind === "model" && node.send) {
      const text = evaluate(parseCondition(node.send), this.scope(ctx));
      if (typeof text === "string" && text.trim()) sc.send = text;
    }
    return sc;
  }

  /** Records a call's outputs as candidates and applies the lock policy. */
  private accept(key: string, node: Producer, ctx: Context, outputs: Record<string, unknown>[], meta: CallMeta[] = []): void {
    const target = node.refines ? ctx.prefix + node.refines : key;
    const { parent, instruction } = this.source(key, node, ctx);
    const attempt = this.rec.state.nodes[target]!.attempts;
    const inputs = this.inputsOf(key, node, ctx);
    const assets = this.received(key, node, ctx).assets;
    if (outputs.length === 0) return this.fail(key, "it produced no output");
    outputs.forEach((output, i) =>
      this.rec.record({
        type: "CandidateProduced",
        node: target,
        attempt,
        candidate: i + 1,
        output,
        parents: parent ? [parent] : [],
        cost_usd: meta[i]?.cost_usd ?? 0,
        ...(meta[i]?.model ? { model: meta[i]!.model } : {}),
        ...(meta[i]?.prompt !== undefined ? { prompt: meta[i]!.prompt } : {}),
        ...(meta[i]?.references?.length ? { references: meta[i]!.references } : {}),
        inputs,
        ...(Object.keys(assets).length > 0 ? { assets } : {}),
        ...(instruction ? { instruction } : {}),
        ...(target !== key ? { made_by: key } : {}),
      }),
    );

    if (node.kind !== "agent" && node.check) {
      this.codeChecks(target, attempt, outputs, node.check);
      if (node.check.rubric) return this.judge(key, node, ctx);
    }
    this.decideLock(key, node, ctx);
  }

  /**
   * Who locks it (D-42): a step a screen shows waits for that screen, even a tool;
   * otherwise code output and `trust: always` lock themselves, `when_confident`
   * locks the first candidate that passed its checks, and anything else asks.
   */
  private decideLock(key: string, node: Producer, ctx: Context): void {
    const target = node.refines ? ctx.prefix + node.refines : key;
    const t = this.rec.state.nodes[target]!;
    if (!this.reviewer(node.refines ?? node.id, ctx)) {
      const passed = Object.values(t.versions).find((v) => v.attempt === t.attempts && summary(v)?.pass);
      if (node.kind === "tool" || node.trust === "always") {
        this.rec.record({ type: "Locked", node: target, version: versionId(t.attempts, 1), by: "auto" });
      } else if (node.trust === "when_confident" && passed) {
        this.rec.record({ type: "Locked", node: target, version: passed.id, by: "auto" });
      } else {
        return this.askApproval(key, node, ctx);
      }
    }
    this.finishProduce(key, node, ctx);
  }

  /** Limits on the numbers each candidate made (`seconds: { max: 8 }`): one code verdict per candidate. */
  private codeChecks(target: string, attempt: number, outputs: Record<string, unknown>[], check: NonNullable<Extract<Node, { kind: "model" }>["check"]>): void {
    const { rubric: _r, ...limits } = check;
    if (Object.keys(limits).length === 0) return;
    outputs.forEach((output, i) => {
      const issues: Verdict["issues"] = [];
      for (const [field, { min, max, is }] of Object.entries(limits)) {
        const v = output[field];
        // `found: { is: true }` (D-74): "not found" when it isn't.
        if (is !== undefined) {
          if (v !== is) issues.push({ type: `${is ? "not_" : ""}${field}`, what: `${is ? "not " : ""}${field.replace(/_/g, " ")}` });
          continue;
        }
        if (typeof v !== "number") issues.push({ type: "missing", what: `no ${field}` });
        else if (max !== undefined && v > max) issues.push({ type: `${field}_over`, what: `${field} is ${v}, over ${max}` });
        else if (min !== undefined && v < min) issues.push({ type: `${field}_under`, what: `${field} is ${v}, under ${min}` });
      }
      this.rec.record({ type: "VerdictRecorded", node: target, version: versionId(attempt, i + 1), by: "code", pass: issues.length === 0, issues });
    });
  }

  /**
   * Asks the judge about this attempt's candidates. The wait is recorded before
   * the call, so a crash mid-judgement asks the judge again rather than
   * making the step again.
   */
  private judge(key: string, node: Producer, ctx: Context): void {
    if (!this.exec.check) return this.fail(key, "it has a rubric, and nothing here can judge it: set up a vision model (models: { llm: anthropic })");
    const { sc, candidates } = this.judgeRequest(key, node, ctx);
    const ticket = `check:${sc.idempotencyKey}`;
    this.rec.record({ type: "Suspended", node: key, ticket, kind: "check_job" });
    const r = this.external(() => this.exec.check!(node, sc, candidates));
    if (Array.isArray(r)) this.finishJudge(key, node, ctx, r);
  }

  private judgeRequest(key: string, node: Producer, ctx: Context): { sc: StepContext; candidates: { version: string; output: Record<string, unknown> }[] } {
    const target = this.rec.state.nodes[node.refines ? ctx.prefix + node.refines : key]!;
    const sc = this.produceRequest(key, node, ctx);
    sc.idempotencyKey = `${sc.idempotencyKey}/check`;
    const candidates = Object.values(target.versions).filter((v) => v.attempt === target.attempts).map((v) => ({ version: v.id, output: v.output }));
    return { sc, candidates };
  }

  private finishJudge(key: string, node: Producer, ctx: Context, judged: Judged[]): void {
    this.rec.record({ type: "Resumed", node: key, ticket: this.rec.state.nodes[key]!.ticket! });
    this.recordJudged(node.refines ? ctx.prefix + node.refines : key, judged);
    this.decideLock(key, node, ctx);
  }

  private recordJudged(target: string, judged: Judged[]): void {
    for (const j of judged) {
      this.rec.record({ type: "VerdictRecorded", node: target, version: j.version, by: "llm", pass: j.pass, issues: j.issues, ...(j.model ? { model: j.model } : {}), cost_usd: j.cost_usd ?? 0 });
    }
  }

  private finishProduce(key: string, node: Producer, ctx: Context): void {
    if (node.refines) this.rec.record({ type: "NodeCompleted", node: ctx.prefix + node.refines });
    this.complete(key, ctx);
  }

  /**
   * What a model or tool step starts from: a refining step's source version and
   * the screen's note, else a retry note; plus the change a failed step was
   * tried again with (Q-24), added to either.
   */
  private source(key: string, node: Producer, ctx: Context): { parent?: string; instruction?: string; region?: unknown } {
    const n = this.rec.state.nodes[key]!;
    const change = n.retry?.attempt === n.attempts ? n.retry.note : undefined;
    const got = node.refines ? this.refineSource(ctx, node.refines) : { instruction: change ? undefined : this.retryNote(key, node, ctx) };
    const instruction = [got.instruction, change].filter(Boolean).join(". ") || undefined;
    return { ...got, instruction };
  }

  /**
   * A step made again from the screen that reviews it ("Try again" with a
   * note): the note is its instruction, so the next try knows what was wrong
   * (Day 23). Recorded on the new versions like an edit's.
   */
  private retryNote(key: string, node: Producer, ctx: Context): string | undefined {
    if (this.rec.state.nodes[key]!.attempts < 2) return undefined;
    const screen = this.reviewer(node.id, ctx);
    return screen ? this.rec.state.nodes[ctx.prefix + screen.id]?.decisions.at(-1)?.note : undefined;
  }

  /**
   * Where a refining step starts from: what the reviewing screen last selected,
   * else the locked version if it's on the branch you're on, else the newest
   * there (D-71).
   */
  private refineSource(ctx: Context, targetId: string): { parent: string; instruction?: string; region?: unknown } {
    const t = this.rec.state.nodes[ctx.prefix + targetId]!;
    const screen = this.reviewer(targetId, ctx);
    const d = screen ? this.rec.state.nodes[ctx.prefix + screen.id]?.decisions.at(-1) : undefined;
    const locked = t.locked && t.versions[t.locked.version]?.branch === t.branch ? t.locked.version : undefined;
    const parent = d?.selection?.[0] ?? locked ?? onBranch(t).at(-1)?.id ?? Object.keys(t.versions).at(-1)!;
    return { parent, ...(d?.note ? { instruction: d.note } : {}), ...(d?.region !== undefined ? { region: d.region } : {}) };
  }

  /** A screen step: asks, and continues now if the answer is already there. */
  private show(key: string, node: ScreenNode, ctx: Context): void {
    const n = this.rec.state.nodes[key]!;
    const visit = n.decisions.length + 1;
    this.rec.record({ type: "Suspended", node: key, ticket: `${key}:${visit}`, kind: "human" });
    this.ask(key, node, ctx);
  }

  /** Puts the screen in front of the person (again, after a crash: no cost) and continues if they've answered. */
  private ask(key: string, node: ScreenNode, ctx: Context): void {
    const visit = this.rec.state.nodes[key]!.decisions.length + 1;
    const d = this.external(() => this.exec.decide(node, { ...this.context(key, node, ctx, visit), shows: this.onShow(ctx, node.show) }));
    if (d) this.finishScreen(key, node, ctx, d);
  }

  private finishScreen(key: string, node: ScreenNode, ctx: Context, d: Decision): void {
    const button = node.actions.find((a) => a.id === d.action);
    if (!button) throw new Error(`step '${key}' has no button '${d.action}' (it has: ${node.actions.map((a) => a.id).join(", ")})`);
    const missing = button.needs.filter((n) => (n === "selection" ? !d.selection?.length : n === "note" ? !d.note : d.region === undefined));
    if (missing.length > 0) throw new Error(`the '${d.action}' button needs ${missing.map((m) => (m === "selection" ? "a pick" : `a ${m}`)).join(" and ")}`);
    this.rec.record({ type: "HumanDecision", node: key, ...clean(d) });
    this.rec.record({ type: "Resumed", node: key, ticket: this.rec.state.nodes[key]!.ticket! });
    if (button.locks && node.show && !this.lockShown(key, node, ctx, d)) return;
    this.complete(key, ctx);
  }

  /**
   * Asks for approval of a step no screen shows, on a generated screen (D-42).
   * `when_confident` asks when no candidate passed its checks.
   */
  private askApproval(key: string, node: Producer, ctx: Context): void {
    const n = this.rec.state.nodes[key]!;
    const visit = n.decisions.length + 1;
    this.rec.record({ type: "Suspended", node: key, ticket: `${key}:approve:${visit}`, kind: "human" });
    this.askAgain(key, node, ctx);
  }

  private askAgain(key: string, node: Producer, ctx: Context): void {
    const visit = this.rec.state.nodes[key]!.decisions.length + 1;
    const screen = approvalScreen(node);
    const d = this.external(() => this.exec.decide(screen, { ...this.context(key, node, ctx, visit), shows: this.onShow(ctx, screen.show) }));
    if (d) this.finishApproval(key, node, ctx, d);
  }

  private finishApproval(key: string, node: Producer, ctx: Context, d: Decision): void {
    if (d.action !== "approve") throw new Error(`the approval for '${key}' only has an 'approve' button, not '${d.action}'`);
    this.rec.record({ type: "HumanDecision", node: key, ...clean(d) });
    this.rec.record({ type: "Resumed", node: key, ticket: this.rec.state.nodes[key]!.ticket! });
    const target = node.refines ? ctx.prefix + node.refines : key;
    const version = this.chooseVersion(target, d, key);
    if (!version) return;
    this.rec.record({ type: "Locked", node: target, version, by: d.by === "auto" ? "auto" : "human", ...(d.note ? { why: d.note } : {}) });
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
    const got = this.received(key, node, ctx);
    const sc: StepContext = { visit, inputs: ctx.inputs, key, uses: got.uses };
    if (Object.keys(got.assets).length > 0) sc.assets = got.assets;
    if (got.parent && parent && target) sc.parent = { version: parent, output: this.rec.state.nodes[target]!.versions[parent]!.output };
    if (instruction) sc.instruction = instruction;
    return sc;
  }

  // ── Durable waits and crash recovery ────────────────────────────────────

  /**
   * A provider job finished: continues the step waiting on its ticket. `meta`
   * gives each candidate's exact model version and cost (rule 6). Call `run()` after.
   */
  deliver(ticket: string, outputs: Record<string, unknown>[], meta: CallMeta[] = []): void {
    this.atomic(() => {
      const inst = this.waitingOn(ticket);
      if (!inst || !isProducer(inst.node) || inst.node.kind === "agent") throw new Error(`no step is waiting on ticket '${ticket}'`);
      this.rec.record({ type: "Resumed", node: inst.key, ticket });
      this.accept(inst.key, inst.node, inst.ctx, outputs, meta);
    });
  }

  /** A slow tool an agent called has finished: records its result and the agent carries on. Call `run()` after. */
  deliverTool(ticket: string, result: unknown, error?: string): void {
    this.atomic(() => {
      const inst = this.waitingOn(ticket);
      if (!inst || inst.node.kind !== "agent" || this.rec.state.nodes[inst.key]!.ticketKind !== "tool_job") throw new Error(`no agent is waiting on ticket '${ticket}'`);
      const n = this.rec.state.nodes[inst.key]!;
      const last = n.history.at(-1)!;
      const c = last.calls.find((x) => x.ok === undefined)!;
      this.rec.record({ type: "Resumed", node: inst.key, ticket });
      const ok = error === undefined;
      this.rec.record({ type: "ToolResult", node: inst.key, turn: last.turn, call: c.call, ok, result: this.blobs.put(ok ? result : { error }) });
      this.agent(inst.key, inst.node, inst.ctx);
    });
  }

  /** A model call for an agent's turn has finished: records the turn and the agent carries on. Call `run()` after. */
  deliverTurn(ticket: string, result: AgentTurnResult): void {
    this.atomic(() => {
      const inst = this.waitingOn(ticket);
      if (!inst || inst.node.kind !== "agent") throw new Error(`no agent is waiting on ticket '${ticket}'`);
      this.rec.record({ type: "Resumed", node: inst.key, ticket });
      if (this.recordTurn(inst.key, result)) this.agent(inst.key, inst.node, inst.ctx);
    });
  }

  /**
   * For checking a step's latest candidates again (`kriya check`), e.g. after
   * its rubric changed: the step, what a judge needs, and the candidates.
   * Nothing is recorded until `recordVerdicts`.
   */
  checkRequest(key: string): { node: Producer; ctx: StepContext; candidates: { version: string; output: Record<string, unknown> }[] } {
    const inst = this.instances().find((x) => x.key === key);
    if (!inst || !this.rec.state.nodes[key]) throw new Error(`there's no step '${key}' in this run`);
    if (!isProducer(inst.node) || inst.node.kind === "agent" || !inst.node.check?.rubric) throw new Error(`'${key}' has no rubric to check against; add check: { rubric: [...] } to it`);
    if (inst.node.refines) throw new Error(`'${key}' makes versions of '${inst.node.refines}'; check that step instead`);
    const { sc, candidates } = this.judgeRequest(key, inst.node, inst.ctx);
    return { node: inst.node, ctx: sc, candidates };
  }

  /** Records a judge's verdicts on a step's candidates (`kriya check`). It doesn't move locks: a person decides. */
  recordVerdicts(key: string, judged: Judged[]): void {
    this.atomic(() => this.recordJudged(key, judged));
  }

  /** The judge answered (`check.rubric`): its verdicts are recorded and the step carries on to its lock. Call `run()` after. */
  deliverVerdicts(ticket: string, judged: Judged[]): void {
    this.atomic(() => {
      const inst = this.waitingOn(ticket);
      if (!inst || !isProducer(inst.node) || this.rec.state.nodes[inst.key]!.ticketKind !== "check_job") throw new Error(`no step is waiting on a judge with ticket '${ticket}'`);
      this.finishJudge(inst.key, inst.node, inst.ctx, judged);
    });
  }

  /** A slow job failed for good (the provider refused, or gave up): the step fails with the reason. Call `run()` after. */
  failJob(ticket: string, reason: string): void {
    this.atomic(() => {
      const inst = this.waitingOn(ticket);
      if (!inst) throw new Error(`no step is waiting on ticket '${ticket}'`);
      this.rec.record({ type: "Resumed", node: inst.key, ticket });
      this.fail(inst.key, reason);
    });
  }

  private waitingOn(ticket: string): Instance | undefined {
    return this.instances().find((x) => this.rec.state.nodes[x.key]?.ticket === ticket && this.status(x.key) === "waiting_external");
  }

  /**
   * Starts slow jobs again after a restart, with the same idempotency key, so a
   * provider that kept the job hands back the same ticket and one that lost it
   * (an in-process request) starts it again. Nothing is recorded unless the job
   * answers straight away.
   */
  private resubmit(key: string, node: Producer, ctx: Context, kind: string | undefined): void {
    const n = this.rec.state.nodes[key]!;
    const ticket = n.ticket!;
    if (node.kind === "agent" && kind === "model_job") {
      const { sc, history } = this.turnRequest(key, node, ctx);
      const r = this.external(() => this.exec.turn!(node, sc, history));
      if (!(r instanceof Pending)) {
        this.rec.record({ type: "Resumed", node: key, ticket });
        if (this.recordTurn(key, r)) this.agent(key, node, ctx);
      }
    } else if (node.kind === "agent" && kind === "tool_job") {
      const last = n.history.at(-1)!;
      const c = last.calls.find((x) => x.ok === undefined)!;
      const { ok, result } = this.runTool(key, node, c, `${this.rec.runId}/${key}#${n.attempts}/t${last.turn}.c${c.call}`);
      if (!(result instanceof Pending)) {
        this.rec.record({ type: "Resumed", node: key, ticket });
        this.rec.record({ type: "ToolResult", node: key, turn: last.turn, call: c.call, ok, result: this.blobs.put(result) });
        this.agent(key, node, ctx);
      }
    } else if (kind === "check_job") {
      const { sc, candidates } = this.judgeRequest(key, node, ctx);
      const r = this.external(() => this.exec.check!(node, sc, candidates));
      if (Array.isArray(r)) this.finishJudge(key, node, ctx, r);
    } else if (kind === "model_job") {
      const r = this.external(() => this.exec.produce(node, this.produceRequest(key, node, ctx)));
      if (Array.isArray(r)) {
        this.rec.record({ type: "Resumed", node: key, ticket });
        this.accept(key, node, ctx, r);
      }
    }
  }

  /**
   * After a restart (`Recorder.resume` + a new Scheduler): asks again for every
   * outside call that was in flight. A model call is repeated with the same
   * idempotency key, so the provider returns the job it already ran; screens
   * are simply shown again; slow jobs are submitted again under the same key
   * (see `resubmit`). Then `run()`.
   */
  recover(): void {
    this.atomic(() => {
      for (const { key, node, ctx } of this.instances()) {
        const n = this.rec.state.nodes[key];
        if (!n) continue;
        if (isProducer(node) && n.status === "running" && !this.beingRemade(node, ctx)) this.call(key, node, ctx);
        else if (isProducer(node) && n.status === "waiting_external") this.resubmit(key, node, ctx, n.ticketKind);
        else if (node.kind === "screen" && n.status === "awaiting_human") this.ask(key, node, ctx);
        else if (node.kind === "agent" && this.openQuestion(key)) this.askAgent(key, node, ctx);
        else if (isProducer(node) && n.status === "awaiting_human") this.askAgain(key, node, ctx);
      }
    });
  }

  /**
   * Whether a refining step is making this step's next version right now. The
   * target shows as running, but it isn't the one calling out: repeating it after
   * a crash would pay to draw the original again, and collide with the edit.
   */
  private beingRemade(node: Node, ctx: Context): boolean {
    return ctx.graph.nodes.some((o) => isProducer(o) && o.refines === node.id && ACTIVE.includes(this.status(ctx.prefix + o.id)!));
  }

  /** Runs `fn` as one batch of events: written together, or not at all. */
  private atomic<T>(fn: () => T): T {
    if (this.rec.batching) return fn();
    this.rec.begin();
    try {
      const r = fn();
      this.rec.commit();
      return r;
    } catch (err) {
      this.rec.rollback();
      throw err;
    }
  }

  /**
   * An outside call (model, tool, person). Everything recorded so far is
   * written first, so a crash during the call loses nothing that happened
   * before it; what follows goes in a new batch.
   */
  private external<T>(fn: () => T): T {
    if (!this.rec.batching) return fn();
    this.rec.commit();
    try {
      return fn();
    } finally {
      this.rec.begin();
    }
  }

  // ── Things the creator does mid-run ─────────────────────────────────────

  /** Every step that has started, in recipe order (each map's items grouped under it). */
  steps(): string[] {
    return this.instances().map((x) => x.key).filter((k) => this.rec.state.nodes[k]);
  }

  /** Everything waiting on a person right now, in run order. */
  inbox(): InboxItem[] {
    return this.instances().flatMap(({ key, node, ctx }) => {
      if (this.status(key) !== "awaiting_human") return [];
      const q = node.kind === "agent" ? this.openQuestion(key) : undefined;
      const screen = node.kind === "screen" ? node : q && node.kind === "agent" ? questionScreen(node, q.question) : isProducer(node) ? approvalScreen(node) : undefined;
      if (!screen) return [];
      return [{
        key,
        title: screen.name ?? screen.id,
        review: screen.review,
        shows: this.onShow(ctx, screen.show),
        beside: this.beside(ctx, screen.beside),
        buttons: screen.actions.map((a) => ({ id: a.id, ...(a.label ? { label: a.label } : {}), needs: a.needs, locks: a.locks })),
      }];
    });
  }

  /** What a screen shows next to its candidates (`beside: [item.hinglish, item.caption_en]`): locked or recorded values only. */
  private beside(ctx: Context, refs: string[]): { ref: string; value: unknown }[] {
    if (refs.length === 0) return [];
    const scope = this.scope(ctx);
    return refs.flatMap((ref) => {
      try {
        const value = evaluate(parseCondition(ref.split("@")[0]!), scope);
        return value === undefined ? [] : [{ ref, value }];
      } catch {
        return []; // a facet reference or something conditions can't read: left out, not an error
      }
    });
  }

  /** Answers a step that is waiting for a human: a screen or a generated approval. Call `run()` after. */
  answer(key: string, d: Decision): void {
    return this.atomic(() => {
    const inst = this.instances().find((x) => x.key === key);
    if (!inst || this.status(key) !== "awaiting_human") throw new Error(`step '${key}' isn't waiting for an answer`);
    if (inst.node.kind === "screen") this.finishScreen(key, inst.node, inst.ctx, d);
    else if (inst.node.kind === "agent" && this.openQuestion(key)) this.finishQuestion(key, inst.node, inst.ctx, d);
    else if (isProducer(inst.node)) this.finishApproval(key, inst.node, inst.ctx, d);
    });
  }

  /** Locks a version directly (the creator's call, not a screen's). */
  lock(key: string, version: string, why?: string): void {
    return this.atomic(() => {
    const n = this.rec.state.nodes[key];
    if (!n?.versions[version]) throw new Error(`'${key}' has no version ${version}`);
    this.reopen(`'${key}' was locked to version ${version}`);
    this.rec.record({ type: "Locked", node: key, version, by: "human", ...(why ? { why } : {}) });
    this.refreshStale();
    });
  }

  /** Adds a version the creator wrote or edited by hand (e.g. a corrected shot list). Returns its id. */
  writeVersion(key: string, output: Record<string, unknown>, instruction?: string): string {
    return this.atomic(() => {
    const n = this.rec.state.nodes[key];
    if (!n) throw new Error(`there's no step '${key}' in this run`);
    this.reopen(`'${key}' got a new version`);
    const attempt = n.attempts + 1;
    this.rec.record({ type: "AttemptStarted", node: key, attempt });
    const parents = n.locked ? [n.locked.version] : [];
    this.rec.record({ type: "CandidateProduced", node: key, attempt, candidate: 1, output, parents, cost_usd: 0, ...(instruction ? { instruction } : {}) });
    this.rec.record({ type: "NodeCompleted", node: key });
    return versionId(attempt, 1);
    });
  }

  /** Stale work right now, in run order, with the reason (what a rebuild would redo). */
  stale(): { key: string; reason: string }[] {
    return this.instances(this.root(), [], true)
      .map((x) => ({ key: x.key, n: this.rec.state.nodes[x.key] }))
      .filter((x) => x.n?.status === "stale")
      .map((x) => ({ key: x.key, reason: x.n!.staleReason! }));
  }

  /**
   * Re-runs stale work: the earliest stale step of each recipe is made ready,
   * and edges take it from there. A map runs again and keeps unchanged items.
   * Stale work the recipe no longer reaches stays stale (parked). Call `run()` after.
   */
  rebuild(): string[] {
    return this.atomic(() => {
    this.refreshStale();
    if (this.stale().length > 0) this.reopen("rebuilding stale work");
    const all = this.instances(this.root(), [], true);
    const staleMaps = all.filter((x) => x.node.kind === "map" && this.status(x.key) === "stale").map((x) => x.key);
    return this.readyEarliestStale(all.filter((x) => !staleMaps.some((m) => x.key.startsWith(`${m}[`))));
    });
  }

  /** A higher level's locked context changed (e.g. the series style). Work that read it goes stale. */
  updateContext(level: string, values: Record<string, unknown>): void {
    this.atomic(() => {
      this.reopen(`'${level}' context changed`);
      this.rec.record({ type: "ContextUpdated", level, values });
      this.refreshStale();
    });
  }

  /**
   * Overrides one facet for one step (its key) or the whole episode (`run`),
   * without touching the Library: "in this episode Mitra has a cold" (node > episode > project).
   */
  override(scope: string, entity: string, facet: string, value: unknown): void {
    this.atomic(() => {
      if (scope !== "run" && !this.rec.state.nodes[scope]) throw new Error(`there's no step '${scope}' in this run; use 'run' for the whole episode`);
      this.reopen(`@${entity} ${facet} was overridden`);
      this.rec.record({ type: "OverrideSet", scope, entity, facet, value });
      this.refreshStale();
    });
  }

  /** Adds an asset or output to one step's context, saved with the step: `@P2-13`-style mentions. */
  mention(key: string, ref: string, note?: string): void {
    this.atomic(() => {
      if (!this.rec.state.nodes[key]) throw new Error(`there's no step '${key}' in this run`);
      this.reopen(`a step's context changed`);
      this.rec.record({ type: "MentionAdded", node: key, ref, ...(note ? { note } : {}) });
      this.refreshStale();
    });
  }

  /** Removes one automatic input from one step (✕ on a chip). */
  removeDefault(key: string, ref: string): void {
    this.atomic(() => {
      if (!this.rec.state.nodes[key]) throw new Error(`there's no step '${key}' in this run`);
      this.reopen(`a step's context changed`);
      this.rec.record({ type: "DefaultRemoved", node: key, ref });
      this.refreshStale();
    });
  }

  /**
   * Keeps stale work as it is (D-72): "the recipe changed, but this shot list is
   * still what I want." Its locked version is judged against today's inputs from
   * now on; work after it is re-checked, and the run carries on.
   */
  keep(key: string, why?: string): void {
    this.atomic(() => {
      const inst = this.instances(this.root(), [], true).find((x) => x.key === key);
      const n = this.rec.state.nodes[key];
      if (!inst || !n) throw new Error(`there's no step '${key}' in this run`);
      if (n.status !== "stale" || !n.locked) throw new Error(`'${key}' isn't stale, so there's nothing to keep`);
      const v = n.versions[n.locked.version]!;
      const makerId = v.madeBy ? v.madeBy.slice(inst.ctx.prefix.length) : inst.node.id;
      const maker = inst.ctx.graph.nodes.find((x) => x.id === makerId) ?? inst.node;
      this.reopen(`kept ${key} as it is`);
      this.rec.record({ type: "StaleKept", node: key, version: v.id, inputs: this.inputsOf(inst.ctx.prefix + maker.id, maker, inst.ctx), ...(why ? { why } : {}) });
      this.refreshStale();
    });
  }

  /** The Library changed (a new facet version): work that used the old version goes stale. */
  assetsChanged(): void {
    this.atomic(() => this.refreshStale());
  }

  /** Tries blocked steps again, e.g. after the missing look was added to the Library. Call `run()` after. */
  unblock(): string[] {
    return this.atomic(() => {
      // Only steps whose missing facets exist now: calling this on every command records nothing for the rest.
      const ready = this.instances()
        .filter((x) => this.status(x.key) === "blocked" && this.received(x.key, x.node, x.ctx).missing.length === 0)
        .map((x) => x.key);
      for (const k of ready) this.rec.record({ type: "NodeReady", node: k });
      return ready;
    });
  }

  /**
   * Tries a failed step again as a new attempt (Q-23), so a provider that
   * refused or gave up is asked afresh under a new idempotency key. Naming a
   * failed map retries its failed items; failed maps around the step run again
   * and keep their finished items (D-35). With a change (Q-24) the step tries
   * again with a note as its instruction and without the inputs it leaves out,
   * both recorded, so a provider that refuses the same input every time gets a
   * different one. Call `run()` after.
   */
  retry(key: string, change: { note?: string; leaveOut?: string[] } = {}): string[] {
    return this.atomic(() => {
      const n = this.rec.state.nodes[key];
      if (!n) throw new Error(`there's no step '${key}' in this run`);
      if (n.status !== "failed") throw new Error(`'${key}' hasn't failed (it's ${n.status}), so there's nothing to retry`);
      const note = change.note?.trim();
      const leaveOut = change.leaveOut ?? [];
      if (note || leaveOut.length) {
        const kind = this.instances().find((x) => x.key === key)?.node.kind;
        if (kind !== "model" && kind !== "agent") throw new Error(`a change goes on the step that failed, not on '${key}': try again with a change on one of its failed items (kriya status lists them)`);
        const can = this.leavable(key);
        for (const ref of leaveOut) {
          if (!can.includes(ref)) throw new Error(`'${key}' can't leave out '${ref}'${can.length ? `: it can leave out ${can.join(", ")}` : ": it has nothing it can do without"}`);
        }
      }
      const failed = this.instances().filter(
        (x) => this.status(x.key) === "failed" && (x.key === key || key.startsWith(`${x.key}[`) || x.key.startsWith(`${key}[`)),
      );
      this.reopen(`retrying ${key}`);
      for (const ref of leaveOut) this.rec.record({ type: "DefaultRemoved", node: key, ref });
      for (const x of failed) this.rec.record({ type: "NodeReady", node: x.key, ...(note && x.key === key ? { note } : {}) });
      const steps = failed.filter((x) => x.node.kind !== "map").map((x) => x.key);
      return steps.length ? steps : [key];
    });
  }

  /**
   * The inputs a step can be tried again without (Q-24): what it declares in
   * `uses` but not in its prompt (the words to say or draw stay), and hasn't
   * already left out. An emotion, a facet, a style.
   */
  leavable(key: string): string[] {
    const node = this.instances().find((x) => x.key === key)?.node;
    if (!node || (node.kind !== "model" && node.kind !== "agent")) return [];
    const inPrompt = new Set(promptRefs(stepText(node)));
    const removed = this.rec.state.nodes[key]?.removed ?? [];
    return [...new Set("uses" in node ? node.uses : [])].filter((r) => !inPrompt.has(r) && !removed.includes(r));
  }

  private reopen(reason: string): void {
    if (this.rec.state.status !== "running") this.rec.record({ type: "RunReopened", reason });
  }

  /** Branches off from a version: later versions of this step go on the new branch. */
  branch(key: string, name: string, from: string): void {
    return this.atomic(() => {
    this.rec.record({ type: "BranchCreated", node: key, branch: name, from });
    this.rec.record({ type: "BranchSwitched", node: key, branch: name });
    });
  }

  switchBranch(key: string, name: string): void {
    return this.atomic(() => {
    this.rec.record({ type: "BranchSwitched", node: key, branch: name });
    });
  }

  /**
   * Re-applies the instruction behind one version onto other instances of the
   * same step, e.g. the gamcha fix on P3-04's panel onto every shot with Bheem
   * (D-30). Each gets a new candidate from its own locked (or newest) version;
   * nothing is locked. Returns the new version ids by key.
   */
  replayChange(sourceKey: string, version: string, onto: string[]): Record<string, string[]> {
    return this.atomic(() => {
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
      const inputs = this.inputsOf(stepKey, step, inst.ctx);
      const sc = this.context(stepKey, step, inst.ctx, visit, target, parent, v.instruction);
      sc.idempotencyKey = `${this.rec.runId}/${stepKey}#${visit}`;
      const result = this.external(() => this.exec.produce(step, sc));
      if (!Array.isArray(result)) throw new Error(`'${stepKey}' answered with a ticket; replaying a change onto a slow job isn't supported yet`);
      const outputs = result;
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
          inputs,
          ...(stepKey !== target ? { made_by: stepKey } : {}),
        });
        return versionId(attempt, i + 1);
      });
      // Back to rest: the new candidates wait to be locked; nothing downstream moves.
      this.rec.record({ type: "NodeCompleted", node: target });
      if (stepKey !== target) this.rec.record({ type: "NodeCompleted", node: stepKey });
    }
    return made;
    });
  }

  /**
   * Merges two versions of one step into new candidates: "take 1.2, but use
   * 1.3's sky" (D-30). The model or agent step that refines this one makes them
   * (for a panel, `edit`), given `base` as its parent and `from` to borrow from;
   * a step nothing refines makes them itself. Each has both versions as parents
   * and goes on the step's current branch. Nothing is locked: the result is a
   * candidate like any other. Returns the new version ids.
   */
  adopt(key: string, base: string, from: string, instruction: string): string[] {
    return this.atomic(() => {
    const t = this.rec.state.nodes[key];
    const inst = this.instances().find((x) => x.key === key);
    if (!t || !inst) throw new Error(`there's no step '${key}' in this run`);
    if (!isProducer(inst.node)) throw new Error(`'${key}' is a ${inst.node.kind} step; only model, agent and tool steps have versions to adopt`);
    for (const v of [base, from]) if (!t.versions[v]) throw new Error(`'${key}' has no version ${v}`);
    if (base === from) throw new Error(`adopt takes two different versions, but both are ${base}`);
    if (!instruction.trim()) throw new Error(`say what to take from ${from}, e.g. "use its ending"`);

    const own = inst.node;
    const step = inst.ctx.graph.nodes.find((n): n is Producer => (n.kind === "model" || n.kind === "agent") && n.refines === own.id) ?? own;
    const stepKey = inst.ctx.prefix + step.id;
    this.reopen(`'${key}' got an adopted version`);
    if (stepKey !== key) {
      if (!this.rec.state.nodes[stepKey]) this.rec.record({ type: "NodeReady", node: stepKey });
      this.rec.record({ type: "AttemptStarted", node: stepKey, attempt: (this.rec.state.nodes[stepKey]?.attempts ?? 0) + 1 });
    }
    this.rec.record({ type: "AttemptStarted", node: key, attempt: t.attempts + 1 });
    const attempt = this.rec.state.nodes[key]!.attempts;
    const visit = this.rec.state.nodes[stepKey]!.attempts;
    const inputs = this.inputsOf(stepKey, step, inst.ctx);
    const output = (v: string) => this.rec.state.nodes[key]!.versions[v]!.output;
    // Both versions are given whatever the step's context mode: adopting them is an explicit choice.
    const sc = { ...this.context(stepKey, step, inst.ctx, visit), parent: { version: base, output: output(base) }, borrow: { version: from, output: output(from) }, instruction };
    sc.idempotencyKey = `${this.rec.runId}/${stepKey}#${visit}`;
    const result = this.external(() => this.exec.produce(step, sc));
    if (!Array.isArray(result)) throw new Error(`'${stepKey}' answered with a ticket; adopting with a slow job isn't supported yet`);
    const made = result.map((out, i) => {
      this.rec.record({
        type: "CandidateProduced",
        node: key,
        attempt,
        candidate: i + 1,
        output: out,
        parents: [base, from],
        cost_usd: 0,
        instruction,
        inputs,
        ...(stepKey !== key ? { made_by: stepKey } : {}),
      });
      return versionId(attempt, i + 1);
    });
    // Back to rest: the new candidates wait to be locked; nothing downstream moves.
    this.rec.record({ type: "NodeCompleted", node: key });
    if (stepKey !== key) this.rec.record({ type: "NodeCompleted", node: stepKey });
    return made;
    });
  }

  // ── Cache keys and stale (docs/03-engine.md §6) ─────────────────────────

  /**
   * What a step reads, one content hash per input: its settings (not its
   * label), the run inputs or its item, each `uses` and `{{ref}}` in its prompt
   * (locked, non-stale outputs only), the steps that lead to it (not loop-backs),
   * a map's list, and for a map each item's outputs.
   */
  private inputsOf(key: string, node: Node, ctx: Context): Record<string, string> {
    const { name: _n, description: _d, ...spec } = node;
    const out: Record<string, string> = { spec: hash(spec) };
    if (ctx.prefix === "") out.inputs = hash(ctx.inputs);
    else out.item = hash(ctx.inputs.item ?? null);
    const scope = this.scope(ctx);
    const read = (ref: string) => evaluate(parseCondition(ref), scope) ?? null;
    // Only what the step actually receives (its context mode, mentions, removed defaults, facet versions).
    // A refining step's reads from the screen reviewing its target (`pick.selected`, `pick.note`) aren't inputs:
    // they're its parent and instruction, recorded on the version, and they move as soon as its own result is locked.
    const reviewer = "refines" in node && node.refines ? this.reviewer(node.refines, ctx)?.id : undefined;
    for (const [r, v] of Object.entries(this.received(key, node, ctx).uses)) {
      if (reviewer && r.split(/[.@[]/)[0] === reviewer) continue;
      // `so_far` is a look at the moment, not an input: redoing shot 2 shouldn't mark the movie made after shots 3, 4 and 5 stale.
      if (r.startsWith(`${SO_FAR}.`)) continue;
      out[`uses:${r}`] = hash(v ?? null);
    }
    for (const e of ctx.graph.edges) {
      if (e.to !== node.id || e.max_loops !== undefined) continue;
      for (const s of Array.isArray(e.from) ? e.from : [e.from]) {
        // A preceding screen isn't an input: screens are revisited, and what they pass on
        // (`pick.selected`, the shot list) is tracked through `uses` and `over`.
        if (ctx.graph.nodes.find((x) => x.id === s)?.kind === "screen") continue;
        // Nor is the step a refining step remakes: its result becomes that step's lock, so counting it
        // made a faster take of a voice line stale because of itself (Oct 26). Its parent is on the version.
        if (ownTarget(node, `after:${s}`)) continue;
        out[`after:${s}`] = hash(scope[s] ?? null);
      }
    }
    if (node.kind === "map") {
      out.over = hash(read(node.over));
      const child = this.graphs.get(node.graph);
      if (child) {
        for (const c of this.children(key, node.graph)) {
          const s = this.scope(c);
          const values = Object.fromEntries(Object.entries(child.outputs).map(([k, ref]) => [k, evaluate(parseCondition(ref), s) ?? null]));
          out[`item:${c.prefix.slice(key.length + 1, -2)}`] = hash(values);
        }
      }
    }
    return out;
  }

  /**
   * Marks locked work whose inputs changed as stale, and stale work whose inputs
   * match again as fresh (re-locking the original restores everything, D-05).
   */
  private refreshStale(): void {
    for (let pass = 0; pass < 50; pass++) {
      let changed = false;
      for (const { key, node, ctx } of this.instances(this.root(), [], true)) {
        const n = this.rec.state.nodes[key];
        // Only settled work is checked; a step that's running right now will record fresh inputs.
        if (!n?.locked || node.kind === "screen" || ACTIVE.includes(n.status)) continue;
        const v = n.versions[n.locked.version];
        if (!v?.inputs) continue;
        const makerId = v.madeBy ? v.madeBy.slice(ctx.prefix.length) : node.id;
        const maker = ctx.graph.nodes.find((x) => x.id === makerId) ?? node;
        const now = this.inputsOf(ctx.prefix + maker.id, maker, ctx);
        // Versions recorded before Oct 26 still list a refining step's own target; it isn't an input.
        const diff = [...new Set([...Object.keys(now), ...Object.keys(v.inputs)])].filter((k) => now[k] !== v.inputs![k] && !ownTarget(maker, k));
        if (diff.length > 0 && n.status !== "stale") {
          // Name the Library change itself ("Bheem's look changed"), not just the reference that reads it.
          const used = this.received(ctx.prefix + maker.id, maker, ctx).assets;
          const facets = Object.keys({ ...v.assets, ...used }).filter((f) => v.assets?.[f] !== used[f]);
          this.reopen("something its work used changed");
          this.rec.record({ type: "MarkedStale", node: key, reason: describe(diff, node, facets) });
          changed = true;
        } else if (diff.length === 0 && n.status === "stale") {
          this.reopen("something its work used changed");
          this.rec.record({ type: "MarkedFresh", node: key });
          changed = true;
        }
      }
      if (!changed) return;
    }
  }

  /** Makes ready each stale step that no other stale step in its recipe leads to. */
  private readyEarliestStale(list: Instance[]): string[] {
    const stale = list.filter((x) => this.status(x.key) === "stale");
    const ready: string[] = [];
    for (const x of stale) {
      const reachedByOther = stale.some((o) => o !== x && o.ctx.prefix === x.ctx.prefix && reaches(x.ctx.graph, o.node.id, x.node.id));
      if (reachedByOther) continue;
      this.rec.record({ type: "NodeReady", node: x.key });
      ready.push(x.key);
    }
    return ready;
  }

  /** What a screen shows: the shown step's latest candidates on the branch it's on, with the shown field. */
  private onShow(ctx: Context, show: string | undefined): Shown[] {
    if (!show) return [];
    const [root, ...path] = show.split(".");
    const t = this.rec.state.nodes[ctx.prefix + root];
    if (!t) return [];
    return onBranch(t).map((v) => {
      let value: unknown = v.output;
      for (const k of path) value = value != null && typeof value === "object" ? (value as Record<string, unknown>)[k] : undefined;
      const verdict = summary(v);
      return verdict ? { version: v.id, value, verdict } : { version: v.id, value };
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
    const version = this.chooseVersion(target, d, screenKey);
    if (!version) return false;
    this.rec.record({ type: "Locked", node: target, version, by: d.by === "auto" ? "auto" : "human", ...(d.note ? { why: d.note } : {}) });
    return true;
  }

  /**
   * Which version a decision means: the one selected, or the only one on show
   * (the latest candidates on the branch you're on). Fails plainly when it's
   * ambiguous or doesn't exist.
   */
  private chooseVersion(target: string, d: Decision, failKey = target): string | undefined {
    const t = this.rec.state.nodes[target]!;
    if (d.selection && d.selection.length > 0) {
      if (d.selection.length > 1) return void this.fail(failKey, "pick exactly one version to lock");
      const id = d.selection[0]!;
      if (!t.versions[id]) return void this.fail(failKey, `version ${id} of '${target}' doesn't exist`);
      return id;
    }
    const latest = onBranch(t);
    if (latest.length !== 1) return void this.fail(failKey, `pick one of the ${latest.length} options of '${target}' to lock`);
    return latest[0]!.id;
  }

  /** Resolves a step's `uses` against locked outputs only. */
  /**
   * What a step receives (D-47), by its context mode:
   * - `full`: its `uses` and prompt `{{refs}}` (minus removed defaults), facets included, plus mentions and its parent;
   * - `local`: the same, its own declared inputs, but none of the automatic defaults (D-55): today the two match;
   *   they differ once the Library attaches facets by kind (Day 18);
   * - `isolated`: only mentions.
   * Outputs are read locked and non-stale; facets resolve step override > run override > Library.
   */
  private received(key: string, node: Node, ctx: Context): Received {
    const mode = contextMode(node);
    const n = this.rec.state.nodes[key];
    const mentions = n?.mentions.map((m) => m.ref) ?? [];
    let refs: string[] = [];
    if (mode !== "isolated" && node.kind !== "screen") {
      const declared = [...("uses" in node ? node.uses : []), ...promptRefs(stepText(node))];
      refs = [...new Set(declared)].filter((r) => !n?.removed.includes(r));
    }
    refs = [...new Set([...refs, ...mentions])];

    const scope = this.scope(ctx);
    const got: Received = { uses: {}, assets: {}, missing: [], parent: mode !== "isolated" };
    for (const ref of refs) got.uses[ref] = ref.startsWith(`${SO_FAR}.`) ? this.soFar(ref, ctx) : this.resolve(ref, key, scope, got);
    return got;
  }

  /**
   * What a one-at-a-time for-each has made up to and including this item:
   * `so_far.items` is the items themselves, `so_far.<output>` one list per
   * output of the recipe, as the map's own result will read (D-41). Only when a
   * step asks for it: it reads every item before this one.
   */
  private soFar(ref: string, ctx: Context): unknown[] {
    const [, mapKey, k] = /^(.*)\[([^\]]+)\]\.$/.exec(ctx.prefix) ?? [];
    const map = this.instances().find((x) => x.key === mapKey)?.node;
    if (map?.kind !== "map" || !map.one_at_a_time) throw new Error(`'${ref}' only works in a recipe that a one-at-a-time for-each runs`);
    const items = this.children(mapKey!, map.graph);
    const upTo = items.slice(0, items.findIndex((c) => c.prefix === ctx.prefix) + 1);
    const field = ref.slice(SO_FAR.length + 1);
    if (field === "items") return upTo.map((c) => c.inputs.item);
    const output = ctx.graph.outputs[field];
    if (!output) throw new Error(`'${ref}' isn't one of this recipe's outputs (it has ${Object.keys(ctx.graph.outputs).join(", ")})`);
    return upTo.map((c) => evaluate(parseCondition(output), this.scope(c)) ?? null);
  }

  /** One reference: `@Mitra.voice` (a facet), `item.characters@look` (facets of named entities), or a path. */
  private resolve(ref: string, key: string, scope: Record<string, unknown>, got: Received): unknown {
    if (ref.startsWith("@")) {
      const [entity, facet] = ref.slice(1).split(".");
      return this.facet(entity!, facet ?? "", key, got);
    }
    const at = ref.indexOf("@");
    if (at < 0) return evaluate(parseCondition(ref), scope);
    const names = evaluate(parseCondition(ref.slice(0, at)), scope);
    const facet = ref.slice(at + 1);
    if (Array.isArray(names)) return names.map((e) => this.facet(String(e), facet, key, got));
    return names == null ? undefined : this.facet(String(names), facet, key, got);
  }

  private facet(entity: string, facet: string, key: string, got: Received): { entity: string; facet: string; version: string; value: unknown } | undefined {
    const o = this.rec.state.overrides;
    const name = `${entity}.${facet}`;
    const override = o[key]?.[name] !== undefined ? o[key]![name] : o.run?.[name];
    const found = override !== undefined ? { version: `override:${hash(override).slice(0, 12)}`, value: override } : this.assets.facet(entity, facet);
    if (!found) {
      got.missing.push(`@${entity} has no ${facet} yet; add it to the Library`);
      return undefined;
    }
    got.assets[name] = found.version;
    return { entity, facet, version: found.version, value: found.value };
  }

  /** This recipe and every recipe its maps run. */
  private recipesUsed(g = this.graph, seen = new Set<Graph>()): Graph[] {
    if (seen.has(g)) return [];
    seen.add(g);
    for (const n of g.nodes) if (n.kind === "map") { const c = this.graphs.get(n.graph); if (c) this.recipesUsed(c, seen); }
    return [...seen];
  }

  /** Starts a map: reads its list and makes each item's first steps ready. */
  private expand(key: string, node: Extract<Node, { kind: "map" }>, ctx: Context): void {
    const n = this.rec.state.nodes[key]!;
    if (!this.graphs.has(node.graph)) return this.fail(key, `it runs recipe '${node.graph}', which isn't loaded`);

    const from = this.listSource(node.over, ctx);
    if ("missing" in from) return this.fail(key, from.missing);
    const list = this.readList(from.source, from.version, from.path);
    if (!list) return this.fail(key, `'${node.over}' isn't a list`);

    const keys: string[] = [];
    for (const [i, item] of list.entries()) {
      const k = itemKey(item, node.key);
      if (typeof k !== "string" && typeof k !== "number") return this.fail(key, `item ${i + 1} of '${node.over}' has no '${node.key}'`);
      const s = String(k);
      if (!ITEM_KEY.test(s)) return this.fail(key, `item key '${s}' can only use letters, digits, - and _`);
      if (keys.includes(s)) return this.fail(key, `two items in '${node.over}' have the same ${node.key} '${s}'`);
      keys.push(s);
    }

    this.rec.record({ type: "AttemptStarted", node: key, attempt: n.attempts + 1 });
    this.rec.record({ type: "MapExpanded", node: key, keys, source: from.source, version: from.version, path: from.path });
    if (node.one_at_a_time) {
      this.nextItem(key, node);
      return;
    }
    for (const k of keys) this.startItem(key, node, k);
  }

  /** Makes one item's work ready. Returns the steps of an item from before that are running again. */
  private startItem(key: string, node: Extract<Node, { kind: "map" }>, k: string): string[] {
    const prefix = `${key}[${k}].`;
    const seen = Object.keys(this.rec.state.nodes).some((s) => s.startsWith(prefix));
    if (!seen) {
      for (const id of startNodes(this.graphs.get(node.graph)!)) this.rec.record({ type: "NodeReady", node: prefix + id });
      return [];
    }
    // An item from before: unchanged work is kept; only its stale steps run again (D-35).
    this.refreshStale();
    const c = this.children(key, node.graph).find((x) => x.prefix === prefix)!;
    return this.readyEarliestStale(this.instances(c, [], true));
  }

  /**
   * Gives the next item of a one-at-a-time for-each its turn: the first this pass
   * hasn't reached that has something to do. Going back over items already made
   * (an arrow into the map), each one's last review asks again, so a person can
   * change it or carry on; nothing is remade unless they say. Returns whether an
   * item started.
   */
  private nextItem(key: string, node: Extract<Node, { kind: "map" }>): boolean {
    for (const k of this.rec.state.nodes[key]!.items!.keys) {
      const items = this.rec.state.nodes[key]!.items!;
      if (items.started?.includes(k)) continue;
      this.rec.record({ type: "ItemStarted", node: key, item: k });
      const again = this.startItem(key, node, k);
      const c = this.children(key, node.graph).find((x) => x.prefix === `${key}[${k}].`)!;
      if (items.walking && again.length === 0 && !this.busy(c)) {
        for (const screen of lastReviews(c.graph)) this.rec.record({ type: "NodeReady", node: c.prefix + screen });
      }
      if (this.busy(c)) return true;
    }
    return false;
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

      // In turn, only items that have had theirs can have fallen short; the rest are still to come.
      const state = this.rec.state.nodes[key]!.items!;
      const reached = (k: string) => !node.one_at_a_time || state.started?.includes(k);
      const failed = state.keys.filter((k, i) => reached(k) && (!this.endReached(items[i]!) || this.hasFailure(items[i]!)));
      if (failed.length > 0) {
        this.fail(key, `${failed.length === 1 ? "item" : "items"} ${failed.join(", ")} didn't finish`);
        return true;
      }
      if (node.one_at_a_time && this.nextItem(key, node)) return true;
      const child = this.graphs.get(node.graph)!;
      const output: Record<string, unknown> = {};
      for (const [name, ref] of Object.entries(child.outputs)) {
        output[name] = items.map((c) => evaluate(parseCondition(ref), this.scope(c)) ?? null);
      }
      const attempt = this.rec.state.nodes[key]!.attempts;
      const inputs = this.inputsOf(key, node, ctx);
      this.rec.record({ type: "CandidateProduced", node: key, attempt, candidate: 1, output, parents: [], cost_usd: 0, inputs });
      this.rec.record({ type: "Locked", node: key, version: versionId(attempt, 1), by: "auto" });
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
    // A refining step started an attempt on its target too; failing, it hands the target back
    // done, as `finishProduce` does. Left running, `recover` would make the target again.
    const x = this.instances().find((i) => i.key === key);
    const target = x && isProducer(x.node) && x.node.refines ? x.ctx.prefix + x.node.refines : undefined;
    if (target && this.rec.state.nodes[target]?.status === "running") this.rec.record({ type: "NodeCompleted", node: target });
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
        // Nor while stale work leads into it: it would run on a parked shot list (see rejoin).
        if (wait === "all" && this.staleInto(ctx, edge.to)) return;
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
      const target = ctx.graph.nodes.find((n) => n.id === edge.to);
      const back = edge.max_loops !== undefined && target?.kind === "map" && target.one_at_a_time;
      if (to !== END) this.rec.record({ type: "NodeReady", node: to, ...(back ? { back: true as const } : {}) });
    });

    if (followed === 0 && limited) this.fail(fromKey, limited);
  }

  /**
   * Before a run ends with nothing to do, joins that never fired get one more
   * look: when the shots finished while the voices were stale, "wait for all"
   * didn't fire, and once the voices were valid again nothing looked, so the
   * Reel was never assembled (Oct 26). A join fires only when every side is
   * done and nothing stale leads into it, so it never runs on parked work.
   * Returns whether it made anything ready.
   */
  private rejoin(all: Instance[]): boolean {
    let readied = false;
    const contexts = new Map(all.map((x) => [x.ctx.prefix, x.ctx]));
    for (const ctx of contexts.values()) {
      const conds = this.conditionsOf(ctx.graph);
      ctx.graph.edges.forEach((edge, i) => {
        const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
        if (sources.length < 2 || (edge.wait ?? "all") !== "all" || edge.to === END) return;
        const edgeKey = ctx.prefix + i;
        if ((this.rec.state.edges[edgeKey] ?? 0) > 0 || this.status(ctx.prefix + edge.to) !== undefined) return;
        if (!sources.every((s) => this.status(ctx.prefix + s) === "completed")) return;
        if (this.staleInto(ctx, edge.to)) return;
        const last = ctx.prefix + sources.at(-1)!;
        const cond = conds[i];
        if (cond && !evaluate(cond, this.scope(ctx, last))) return;
        this.rec.record({ type: "EdgeFollowed", edge: edgeKey, from: last, to: ctx.prefix + edge.to });
        this.rec.record({ type: "NodeReady", node: ctx.prefix + edge.to });
        readied = true;
      });
    }
    return readied;
  }

  /** Whether stale work in this recipe leads into a step: a join into it waits until that's rebuilt or kept. */
  private staleInto(ctx: Context, to: string): boolean {
    return ctx.graph.nodes.some((n) => this.status(ctx.prefix + n.id) === "stale" && reaches(ctx.graph, n.id, to));
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
      if (!n || n.status === "stale") continue; // stale work is out of context, like rejected candidates
      if (node.kind === "screen") {
        const d = n.decisions.at(-1);
        if (d) scope[node.id] = { action: d.action, selected: this.selected(ctx, node, d), note: d.note, prompt: this.sentFor(ctx, node, d) };
      } else if (n.locked) {
        scope[node.id] = n.versions[n.locked.version]?.output;
      }
    }
    for (const level of ctx.graph.inherits) if (s.context[level]) scope[level] = s.context[level];
    scope.inputs = ctx.inputs;
    scope.item = ctx.inputs.item;
    if (fromKey) {
      const from = s.nodes[fromKey];
      scope.action = from?.decisions.at(-1)?.action;
      // D-43: an edge may read the candidate its source step just made as `result`.
      const id = fromKey.slice(ctx.prefix.length);
      const node = ctx.graph.nodes.find((n) => n.id === id);
      const made = node && "refines" in node && node.refines ? s.nodes[ctx.prefix + node.refines] : from;
      const last = made ? Object.values(made.versions).at(-1) : undefined;
      scope.result = last?.output;
      // Day 20: and what its checks said, as `verdict.pass` and `verdict.issues`.
      scope.verdict = last ? summary(last) : undefined;
    }
    return scope;
  }

  /**
   * A screen's `selected`: the shown field (`show: draw.image` → the image) of
   * the version the decision chose: the selected one, or the one it locked.
   */
  private selected(ctx: Context, screen: ScreenNode, d: { action?: string; selection?: string[] | undefined }): unknown {
    if (!screen.show) return d.selection;
    const [, ...path] = screen.show.split(".");
    const chosen = this.chosen(ctx, screen, d);
    if (!chosen) return undefined;
    const values = chosen.map((v) => {
      let out: unknown = v.output;
      for (const k of path) out = out != null && typeof out === "object" ? (out as Record<string, unknown>)[k] : undefined;
      return out;
    });
    return values.length === 1 ? values[0] : values;
  }

  /** The prompt that made what a screen's decision chose, as the provider got it: `pick.prompt`. Recorded data, so a redo can start from what was really sent. */
  private sentFor(ctx: Context, screen: ScreenNode, d: { action?: string; selection?: string[] | undefined }): string | undefined {
    const chosen = screen.show ? this.chosen(ctx, screen, d) : undefined;
    return chosen?.length === 1 ? chosen[0]!.prompt : undefined;
  }

  /** The versions a screen's decision means: the selected ones, the locked one, or the only one on show. Undefined when the shown step is stale. */
  private chosen(ctx: Context, screen: ScreenNode, d: { action?: string; selection?: string[] | undefined }): Version[] | undefined {
    const t = this.rec.state.nodes[ctx.prefix + screen.show!.split(".")[0]!];
    if (!t || t.status === "stale") return undefined; // stale work is out of context
    // A locking button's pick is whatever is locked *now*: if the creator moved the lock later, that wins.
    const locking = screen.actions.find((a) => a.id === d.action)?.locks;
    if (locking && t.locked) return [t.versions[t.locked.version]!];
    if (d.selection && d.selection.length > 0) return d.selection.flatMap((id) => t.versions[id] ?? []);
    if (t.locked) return [t.versions[t.locked.version]!];
    const latest = onBranch(t);
    return latest.length === 1 ? latest : [];
  }
}

/** Drops undefined fields, which can't be recorded. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Content hash of a JSON value, with object keys sorted so the same data always hashes the same. */
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Whether `to` can be reached from `from` along edges, not counting loop-backs. */
function reaches(g: Graph, from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of g.edges) {
      if (e.max_loops !== undefined || e.to === END) continue;
      if (!(Array.isArray(e.from) ? e.from : [e.from]).includes(at) || seen.has(e.to)) continue;
      if (e.to === to) return true;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return false;
}

/**
 * A step's latest candidates on the branch it's on (D-71): the newest attempt
 * that made versions there. Switching branches changes what its screen shows.
 * A branch with nothing on it yet shows the version it started from, so the
 * first edit there has something to start from.
 */
export function onBranch(t: NodeState): Version[] {
  const mine = Object.values(t.versions).filter((v) => v.branch === t.branch);
  if (mine.length === 0) {
    const from = t.branches[t.branch]?.from;
    return from && t.versions[from] ? [t.versions[from]] : [];
  }
  const last = Math.max(...mine.map((v) => v.attempt));
  return mine.filter((v) => v.attempt === last);
}

/** The reviews that end a recipe: the screens with an arrow to END. Where a pass back over an item stops to ask. */
function lastReviews(g: Graph): string[] {
  const ends = g.edges.filter((e) => e.to === END).flatMap((e) => (Array.isArray(e.from) ? e.from : [e.from]));
  return g.nodes.filter((n) => n.kind === "screen" && ends.includes(n.id)).map((n) => n.id);
}

/** An item's key in a for-each step: its `key` field, or the item itself in a list of plain names (`["AAPL", "MSFT"]`, D-74). */
function itemKey(item: unknown, key: string): unknown {
  if (typeof item === "string" || typeof item === "number") return item;
  return item != null && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined;
}

/** Whether an input key is the step a refining step remakes (`after:speak` for too_long): never an input. */
function ownTarget(node: Node, key: string): boolean {
  return "refines" in node && !!node.refines && key === `after:${node.refines}`;
}

/** A plain reason for staleness from the inputs that changed. */
/**
 * What a version's checks say now: the latest verdict from each kind of checker
 * (code, llm, human), so judging again after a rubric changes replaces the old
 * answer instead of piling on. Undefined if nothing checked it.
 */
function summary(v: { verdicts: Verdict[] }): { pass: boolean; issues: Verdict["issues"] } | undefined {
  if (v.verdicts.length === 0) return undefined;
  const latest = [...new Map(v.verdicts.map((x) => [x.by, x])).values()];
  return { pass: latest.every((x) => x.pass), issues: latest.flatMap((x) => x.issues) };
}

function describe(changed: string[], node: Node, facets: string[] = []): string {
  // "its item changed" already covers item.action, item.place, …; a named facet change covers the refs that read facets;
  // "'per_shot' changed" (the step it comes after) covers per_shot.panel and per_shot.clip.
  const covered = (k: string) =>
    (changed.includes("item") && k.startsWith("uses:item.")) ||
    (k.startsWith("uses:") && changed.includes(`after:${k.slice(5).split(/[.@[]/)[0]}`)) ||
    (changed.includes("inputs") && k.startsWith("uses:inputs.")) ||
    (facets.length > 0 && k.startsWith("uses:") && k.includes("@"));
  const parts = changed.filter((k) => !covered(k)).map((k) => {
    if (k === "spec") return "its settings changed";
    if (k === "item") return "its item changed";
    if (k === "inputs") return "the run's inputs changed";
    if (k === "over") return `'${(node as { over?: string }).over}' changed`;
    const [kind, name] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    if (kind === "item") return `item ${name} changed`;
    return `'${name}' changed`;
  });
  const named = facets.map((f) => {
    const dot = f.lastIndexOf(".");
    return `${f.slice(0, dot)}'s ${f.slice(dot + 1)} changed`;
  });
  return [...new Set([...named, ...parts])].join("; ");
}

