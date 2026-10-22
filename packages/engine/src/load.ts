/**
 * Loads graphs from YAML and reports problems with file and line numbers.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LineCounter, parseDocument, isNode } from "yaml";
import type { ZodIssue } from "zod";
import { Edge, Graph, Node, ScreenAction } from "./spec.js";
import { suggest, validateBundle, type Issue } from "./validate.js";

export type Problem = {
  file: string;
  line?: number;
  col?: number;
  where: string;
  message: string;
  severity: "error" | "warning";
};

export type LoadResult = { graphs: Graph[]; problems: Problem[] };

type Source = { file: string; doc: ReturnType<typeof parseDocument>; lc: LineCounter };

export function loadText(text: string, file = "<inline>"): LoadResult {
  return loadSources([{ file, text }]);
}

export function loadDir(dir: string): LoadResult {
  const files = walk(dir).filter((f) => /\.ya?ml$/.test(f));
  return loadSources(files.map((f) => ({ file: relative(process.cwd(), f), text: readFileSync(f, "utf8") })));
}

function loadSources(inputs: { file: string; text: string }[]): LoadResult {
  const problems: Problem[] = [];
  const graphs: Graph[] = [];
  const byGraph = new Map<string, Source>();

  for (const { file, text } of inputs) {
    const lc = new LineCounter();
    const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
    if (doc.errors.length) {
      for (const e of doc.errors) {
        const pos = lc.linePos(e.pos[0]);
        problems.push({ file, line: pos.line, col: pos.col, where: "yaml", message: e.message.split("\n")[0]!, severity: "error" });
      }
      continue;
    }
    const data = doc.toJS();
    const parsed = Graph.safeParse(data);
    if (!parsed.success) {
      for (const { path, message } of plainIssues(parsed.error.issues, data)) {
        problems.push({ file, ...locate({ file, doc, lc }, path), where: describe(path), message, severity: "error" });
      }
      continue;
    }
    graphs.push(parsed.data);
    byGraph.set(parsed.data.graph, { file, doc, lc });
  }

  for (const iss of validateBundle(graphs)) problems.push(toProblem(iss, byGraph.get(iss.graph)));
  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return { graphs, problems };
}

/**
 * Turns schema errors into plain words (Q-18): an unknown setting gets the
 * nearest valid name, a missing one says what needs it, and a typo that
 * causes both is reported once.
 */
function plainIssues(issues: ZodIssue[], data: unknown): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const suggested = new Set<string>();
  for (const iss of issues) {
    if (iss.code !== "unrecognized_keys") continue;
    const { what, keys } = describeObject(iss.path, data);
    for (const k of iss.keys) {
      const hint = suggest(k, keys);
      if (hint) suggested.add(`${iss.path.join(".")}.${hint.slice(hint.indexOf("'") + 1, hint.lastIndexOf("'"))}`);
      out.push({ path: [...iss.path, k], message: `'${k}' isn't a setting for ${what}${hint}` });
    }
  }
  for (const iss of issues) {
    if (iss.code === "unrecognized_keys") continue;
    const field = iss.path.at(-1);
    const parent = iss.path.slice(0, -1);
    if (iss.code === "invalid_type" && iss.received === "undefined" && typeof field === "string") {
      if (suggested.has(`${parent.join(".")}.${field}`)) continue; // already explained by the typo
      out.push({ path: iss.path, message: `'${field}' is missing: ${describeObject(parent, data).what} needs it` });
    } else if (iss.code === "invalid_union_discriminator") {
      const kinds = iss.options.map(String);
      const given = String(get(data, iss.path) ?? "");
      out.push({ path: iss.path, message: `'${given}' isn't a kind of step. Use one of: ${kinds.join(", ")}${suggest(given, kinds)}` });
    } else {
      out.push({ path: iss.path, message: iss.message });
    }
  }
  return out;
}

/** What object a path points at, in creator words, and its valid settings. */
function describeObject(path: (string | number)[], data: unknown): { what: string; keys: string[] } {
  if (path.length === 0) return { what: "a recipe", keys: Object.keys(Graph.shape) };
  if (path[0] === "nodes" && path.length === 2) {
    const kind = (get(data, path) as { kind?: unknown } | undefined)?.kind;
    const schema = Node.options.find((o) => o.shape.kind.value === kind);
    return { what: schema ? `a ${String(kind)} step` : "a step", keys: schema ? Object.keys(schema.shape) : ["id", "kind"] };
  }
  if (path[0] === "nodes" && path[2] === "actions") return { what: "a button", keys: Object.keys(ScreenAction.shape) };
  if (path[0] === "edges" && path.length === 2) return { what: "an edge", keys: Object.keys(Edge.shape) };
  return { what: "this", keys: [] };
}

function get(data: unknown, path: (string | number)[]): unknown {
  let v = data;
  for (const k of path) v = v != null && typeof v === "object" ? (v as Record<string | number, unknown>)[k] : undefined;
  return v;
}

function toProblem(iss: Issue, src: Source | undefined): Problem {
  return {
    file: src?.file ?? iss.graph,
    ...(src ? locate(src, iss.path) : {}),
    where: `${iss.graph} › ${describe(iss.path)}`,
    message: iss.message,
    severity: iss.severity,
  };
}

/** Finds the line of the deepest YAML node that exists along a path. */
function locate(src: Source, path: (string | number)[]): { line?: number; col?: number } {
  for (let n = path.length; n >= 0; n--) {
    const node = src.doc.getIn(path.slice(0, n), true);
    if (isNode(node) && node.range) {
      const pos = src.lc.linePos(node.range[0]);
      return { line: pos.line, col: pos.col };
    }
  }
  return {};
}

function describe(path: (string | number)[]): string {
  return path.length ? path.map((p) => (typeof p === "number" ? `[${p}]` : p)).join(".").replace(/\.\[/g, "[") : "(top)";
}

export function formatProblems(problems: Problem[]): string {
  return problems
    .map((p) => `${p.severity === "error" ? "✗" : "!"} ${p.file}${p.line ? `:${p.line}:${p.col}` : ""}  ${p.where}\n    ${p.message}`)
    .join("\n");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
