/**
 * Checks that go beyond the schema: references, loops, reachability, and
 * buttons that edges rely on. Run before a recipe is published, so problems
 * show up in the builder, not halfway through a paid run.
 */
import { contextMode, END, stepText, type Edge, type Graph, type Node } from "./spec.js";
import { ConditionError, literalsComparedTo, parseCondition, pathsIn } from "./condition.js";

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
  // A for-each gives the recipe it runs one input, `item`; any other input would be empty, silently
  // (a guide's recipe read {{inputs.topic}} inside a for-each, Oct 27: fake runs never showed it).
  for (const g of graphs) {
    g.nodes.forEach((n, i) => {
      if (n.kind !== "map") return;
      const runs = graphs.find((x) => x.graph === n.graph);
      for (const name of Object.keys(runs?.inputs ?? {}).filter((k) => k !== "item")) {
        issues.push({ graph: g.graph, path: ["nodes", i, "graph"], severity: "error", message: `'${n.graph}' runs once per item, so its one input is item, but it also asks for '${name}', which a for-each can't give it. In ${n.graph}, rename the input to item and read {{item}}` });
      }
    });
  }
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
    if (base.startsWith("library.")) return; // a Library kind; the project checks it exists
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
        if (pathsIn(expr).some((p) => p[0] === "result")) checkResult(e, i);
        if (pathsIn(expr).some((p) => p[0] === "verdict")) {
          checkResult(e, i);
          const n = nodes.get(sources(e)[0]!);
          if (n && !("check" in n && n.check)) err(["edges", i, "when"], `'${n.id}' has no check:, so it has no 'verdict'. Add one, e.g. check: { rubric: [...] }`);
        }
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

  // refines: points at a step in this recipe whose outputs it can stand in for (D-44).
  g.nodes.forEach((n, i) => {
    if (!("refines" in n) || n.refines === undefined) return;
    const t = nodes.get(n.refines);
    if (!t) return err(["nodes", i, "refines"], `refines '${n.refines}', which isn't a step${suggest(n.refines, ids)}`);
    if (t.id === n.id) return err(["nodes", i, "refines"], "a step can't refine itself");
    if (t.kind !== "model" && t.kind !== "agent" && t.kind !== "tool") return err(["nodes", i, "refines"], `'${t.id}' is a ${t.kind} step; only model, agent and tool steps make versions`);
    if ("refines" in t && t.refines) return err(["nodes", i, "refines"], `'${t.id}' refines '${t.refines}' itself; refine '${t.refines}' directly`);
    for (const [field, type] of Object.entries("out" in n ? n.out : {})) {
      const want = t.out[field];
      if (want === undefined) err(["nodes", i, "out", field], `'${t.id}' has no output '${field}', so '${n.id}' can't make a version of it${suggest(field, Object.keys(t.out))}`);
      else if (want !== type) err(["nodes", i, "out", field], `'${field}' is ${type} here but ${want} in '${t.id}'`);
    }
  });

  // A screen that shows a step should have a button that locks it (D-42).
  g.nodes.forEach((n, i) => {
    if (n.kind !== "screen" || !n.show) return;
    if (!n.actions.some((a) => a.locks)) {
      warn(["nodes", i, "actions"], `screen '${n.id}' shows '${n.show}' but none of its buttons locks it; add locks: true to the button that accepts it`);
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

  // Every reference a step reads: uses, show, beside, {{refs}} in prompts (D-47).
  g.nodes.forEach((n, i) => {
    if ("uses" in n) n.uses.forEach((r, j) => checkRootRef(r, ["nodes", i, "uses", j]));
    if (n.kind === "screen") {
      if (n.show) checkRootRef(n.show, ["nodes", i, "show"]);
      n.beside.forEach((r, j) => checkRootRef(r, ["nodes", i, "beside", j]));
    }
    if ("prompt" in n && n.prompt) for (const r of promptRefs(n.prompt)) checkRootRef(r, ["nodes", i, "prompt"]);
    if (n.kind === "agent") for (const r of promptRefs(n.goal)) checkRootRef(r, ["nodes", i, "goal"]);
    if ((n.kind === "model" || n.kind === "tool") && n.check) checkChecks(n, i);
    // In isolated context, declared inputs never reach the step (D-55): say so instead of dropping them quietly.
    if (contextMode(n) === "isolated") {
      if ("uses" in n && n.uses.length) warn(["nodes", i, "uses"], "'uses' won't reach this step: it runs in isolated context, which sees only @mentions. Remove 'uses', or set context: local or full");
      const refs = promptRefs(stepText(n));
      const field = n.kind === "agent" ? "goal" : "prompt";
      if (refs.length) warn(["nodes", i, field], `{{${refs[0]}}} in its ${field} won't be filled: it runs in isolated context, which sees only @mentions. @mention it, or set context: local or full`);
    }
  });

  return issues;

  /** A step's `check:`: limits on numbers it makes, and a rubric for the images it makes (Day 20). */
  function checkChecks(n: Extract<Node, { kind: "model" | "tool" }>, i: number) {
    const { rubric, ...limits } = n.check!;
    const numbers = Object.entries(n.out).filter(([, t]) => t === "number").map(([f]) => f);
    const booleans = Object.entries(n.out).filter(([, t]) => t === "boolean").map(([f]) => f);
    for (const [field, limit] of Object.entries(limits)) {
      const at: Issue["path"] = ["nodes", i, "check", field];
      if (limit.is !== undefined) {
        // A yes/no output the step must answer a certain way (D-74).
        if (!booleans.includes(field)) err(at, `'${field}' isn't a yes/no (boolean) this step makes${suggest(field, booleans)} 'is:' checks one in its out (${booleans.join(", ") || "it has none"})`);
        else if (limit.min !== undefined || limit.max !== undefined) err(at, `'${field}' is a yes/no: use is: true or is: false, not min or max`);
        continue;
      }
      if (!numbers.includes(field)) {
        err(at, `'${field}' isn't a number this step makes${suggest(field, [...numbers, "rubric"])} A check limits a number in its out (${numbers.join(", ") || "it has none"}) or has a rubric`);
      } else if (limit.min === undefined && limit.max === undefined) {
        err(at, `say the limit, e.g. ${field}: { max: 8 }`);
      } else if (limit.min !== undefined && limit.max !== undefined && limit.min > limit.max) {
        err(at, `min (${limit.min}) is above max (${limit.max})`);
      }
    }
    // The judge looks at images, or reads written work (D-73); it can't hear or watch.
    const types = Object.values(n.out).map((t) => t.replace(/^list<(.+)>$/, "$1"));
    if (rubric && !types.includes("image")) {
      const media = types.find((t) => t === "audio" || t === "video");
      if (media) err(["nodes", i, "check", "rubric"], `a rubric is judged by looking at images or reading words, and this step makes ${media}; limit a number instead, e.g. seconds: { max: 8 }`);
      else if (types.length === 0) err(["nodes", i, "check", "rubric"], "a rubric needs something to judge, and this step declares no outputs (out:)");
    }
  }

  /** `result` is the one candidate the edge's source step just made (D-43). */
  function checkResult(e: Edge, i: number) {
    const from = sources(e);
    if (from.length > 1) return err(["edges", i, "when"], "'result' is unclear on an edge that joins several steps; name the step instead");
    const n = nodes.get(from[0]!);
    if (!n) return;
    if (n.kind !== "model" && n.kind !== "agent" && n.kind !== "tool") {
      return err(["edges", i, "when"], `'${n.id}' is a ${n.kind} step, so it has no 'result'${n.kind === "screen" ? "; use 'action' for the button pressed" : ""}`);
    }
    if (n.kind === "model" && n.options > 1) {
      err(["edges", i, "when"], `'${n.id}' makes ${n.options} options, so 'result' is unclear. Add a pick screen or a checker`);
    }
  }

  function checkRootRef(ref: string, path: Issue["path"]) {
    const root = ref.split(/[.@[]/)[0]!;
    if (nodes.has(root) || BUILTIN_SCOPES.includes(root) || g.inherits.includes(root)) return;
    if (KNOWN_LEVELS.includes(root)) {
      return err(path, `'${ref}' reads from '${root}', which this recipe doesn't inherit; add inherits: [${root}] to the recipe`);
    }
    err(path, `'${ref}' refers to '${root}', which isn't a step or an inherited level${suggest(root, [...ids, ...g.inherits, ...BUILTIN_SCOPES])}`);
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
/** Scopes every recipe can read without declaring them. */
const BUILTIN_SCOPES = ["item", "inputs", "run", "assets"];
/** Common level names, to give a better hint when one is used without `inherits`. */
const KNOWN_LEVELS = ["project", "series", "story", "episode", "part", "season", "channel", "watchlist", "quarter"];

/** `{{ref}}` placeholders in a prompt. */
export function promptRefs(prompt: string): string[] {
  return [...prompt.matchAll(/\{\{\s*([A-Za-z_][\w.@]*)\s*\}\}/g)].map((m) => m[1]!);
}

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

export function suggest(word: string, options: string[]): string {
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
