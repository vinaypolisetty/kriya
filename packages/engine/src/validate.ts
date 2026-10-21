/**
 * Checks that go beyond the schema: references, loops, reachability, and
 * buttons that edges rely on. Run before a recipe is published, so problems
 * show up in the builder, not halfway through a paid run.
 */
import { END, type Edge, type Graph, type Node } from "./spec.js";
import { ConditionError, literalsComparedTo, parseCondition } from "./condition.js";

export type Issue = {
  graph: string;
  /** Path inside the graph, e.g. ["edges", 3, "to"]. */
  path: (string | number)[];
  message: string;
  severity: "error" | "warning";
};

const sources = (e: Edge) => (Array.isArray(e.from) ? e.from : [e.from]);

/** Above this many turns an agent without a budget gets a warning. */
export const LONG_AGENT_TURNS = 50;

export function validateBundle(graphs: Graph[]): Issue[] {
  const issues: Issue[] = [];
  const names = new Map<string, number>();
  graphs.forEach((g, i) => {
    if (names.has(g.graph)) {
      issues.push({ graph: g.graph, path: ["graph"], severity: "error", message: `two graphs are named '${g.graph}'` });
    }
    names.set(g.graph, i);
  });
  for (const g of graphs) issues.push(...validateGraph(g, new Set(names.keys())));
  return issues;
}

export function validateGraph(g: Graph, knownGraphs: Set<string>): Issue[] {
  const issues: Issue[] = [];
  const err = (path: Issue["path"], message: string) => issues.push({ graph: g.graph, path, message, severity: "error" });
  const warn = (path: Issue["path"], message: string) => issues.push({ graph: g.graph, path, message, severity: "warning" });

  // Unique node ids.
  const nodes = new Map<string, Node>();
  g.nodes.forEach((n, i) => {
    if (nodes.has(n.id)) err(["nodes", i, "id"], `two nodes are named '${n.id}'`);
    nodes.set(n.id, n);
  });
  const ids = [...nodes.keys()];

  // Graph references.
  g.nodes.forEach((n, i) => {
    if ((n.kind === "map" || n.kind === "subgraph") && !knownGraphs.has(n.graph)) {
      err(["nodes", i, "graph"], `runs graph '${n.graph}', which doesn't exist${suggest(n.graph, [...knownGraphs])}`);
    }
    if (n.kind === "map" && n.graph === g.graph) err(["nodes", i, "graph"], "a graph can't map over itself");
    if (n.kind === "map") checkRootRef(n.over, ["nodes", i, "over"]);
  });

  // Long-running agents need a spend cap; turns alone don't bound cost.
  g.nodes.forEach((n, i) => {
    if (n.kind === "agent" && n.max_turns > LONG_AGENT_TURNS && !n.budget) {
      warn(
        ["nodes", i, "max_turns"],
        `agent '${n.id}' can take up to ${n.max_turns} turns with no budget; add budget: { usd: … } so a long run can't overspend`,
      );
    }
  });

  // Declared types used by fields.
  const typeNames = new Set(Object.keys(g.types));
  const checkType = (t: string, path: Issue["path"]) => {
    const base = t.replace(/^list<|>$/g, "");
    const primitives = ["text", "number", "boolean", "image", "audio", "video", "file", "json"];
    if (!primitives.includes(base) && !typeNames.has(base)) {
      err(path, `type '${base}' isn't declared${suggest(base, [...primitives, ...typeNames])}`);
    }
  };
  Object.entries(g.inputs).forEach(([k, t]) => checkType(t, ["inputs", k]));
  Object.entries(g.types).forEach(([tn, td]) => Object.entries(td.fields).forEach(([k, t]) => checkType(t, ["types", tn, "fields", k])));
  g.nodes.forEach((n, i) => {
    if ("out" in n) Object.entries(n.out).forEach(([k, t]) => checkType(t, ["nodes", i, "out", k]));
  });

  // Edges: endpoints, conditions, screen actions.
  g.edges.forEach((e, i) => {
    sources(e).forEach((s, j) => {
      if (!nodes.has(s)) err(["edges", i, "from", ...(Array.isArray(e.from) ? [j] : [])], `'from' points at '${s}', which isn't a node${suggest(s, ids)}`);
    });
    if (e.to !== END && !nodes.has(e.to)) err(["edges", i, "to"], `'to' points at '${e.to}', which isn't a node${suggest(e.to, ids)}`);
    if (Array.isArray(e.from) && e.from.length > 1 && !e.wait) {
      warn(["edges", i, "wait"], "joins several steps; defaulting to wait: all");
    }
    if (e.when !== undefined) {
      try {
        const expr = parseCondition(e.when);
        for (const s of sources(e)) {
          const n = nodes.get(s);
          if (n?.kind === "screen") {
            const known = n.actions.map((a) => a.id);
            for (const a of literalsComparedTo(expr, "action")) {
              if (!known.includes(a)) {
                err(["edges", i, "when"], `screen '${s}' has no button '${a}'${suggest(a, known)} (it has: ${known.join(", ")})`);
              }
            }
          }
        }
      } catch (ex) {
        if (ex instanceof ConditionError) err(["edges", i, "when"], `condition "${e.when}": ${ex.message}`);
        else throw ex;
      }
    }
  });

  // Every screen button should lead somewhere.
  g.nodes.forEach((n, i) => {
    if (n.kind !== "screen") return;
    const out = g.edges.filter((e) => sources(e).includes(n.id));
    const unconditional = out.some((e) => e.when === undefined);
    if (unconditional) return;
    const handled = new Set(out.flatMap((e) => (e.when ? safeLiterals(e.when) : [])));
    n.actions.forEach((a, j) => {
      if (!handled.has(a.id)) warn(["nodes", i, "actions", j], `button '${a.id}' isn't connected to any next step`);
    });
  });

  // Loops: every cycle must go through an edge with max_loops.
  const cycles = cyclesWithoutLimit(g);
  for (const cycle of cycles) {
    err(["edges"], `loop ${[...cycle, cycle[0]].join(" → ")} has no limit; add max_loops to the edge that goes back`);
  }

  // Reachability from start nodes. Skipped when a loop has no limit,
  // because then the start can't be worked out and the warnings would be noise.
  if (cycles.length === 0) {
    const starts = startNodes(g);
    if (starts.length === 0) err(["nodes"], "no starting step: every step has an incoming arrow");
    const reached = reachable(g, starts);
    g.nodes.forEach((n, i) => {
      if (!reached.has(n.id)) warn(["nodes", i], `step '${n.id}' can never run: nothing leads to it`);
    });
  }

  // Outputs point at real nodes.
  Object.entries(g.outputs).forEach(([k, ref]) => checkRootRef(ref, ["outputs", k]));

  return issues;

  function checkRootRef(ref: string, path: Issue["path"]) {
    const root = ref.split(/[.@]/)[0]!;
    const builtins = ["item", "inputs", "series", "story", "part", "project", "assets", "run"];
    if (!nodes.has(root) && !builtins.includes(root)) {
      err(path, `'${ref}' refers to '${root}', which isn't a step${suggest(root, ids)}`);
    }
  }
}

function safeLiterals(when: string): string[] {
  try {
    return literalsComparedTo(parseCondition(when), "action");
  } catch {
    return [];
  }
}

/** Nodes with no incoming edge, ignoring loop-back edges. */
export function startNodes(g: Graph): string[] {
  const incoming = new Set<string>();
  for (const e of g.edges) if (e.max_loops === undefined && e.to !== END) incoming.add(e.to);
  return g.nodes.map((n) => n.id).filter((id) => !incoming.has(id));
}

function reachable(g: Graph, starts: string[]): Set<string> {
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of g.edges) {
      if (e.to === END || !sources(e).includes(cur) || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

/** Cycles that remain after removing every edge carrying max_loops. */
function cyclesWithoutLimit(g: Graph): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of g.nodes) adj.set(n.id, []);
  for (const e of g.edges) {
    if (e.max_loops !== undefined || e.to === END) continue;
    for (const s of sources(e)) adj.get(s)?.push(e.to);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (u: string) => {
    state.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (state.get(v) === 1) found.push(stack.slice(stack.indexOf(v)));
      else if (!state.get(v)) visit(v);
    }
    stack.pop();
    state.set(u, 2);
  };
  for (const id of adj.keys()) if (!state.get(id)) visit(id);
  return found;
}

function suggest(word: string, options: string[]): string {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(word, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3)) ? `. Did you mean '${best}'?` : "";
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}
