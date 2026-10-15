/**
 * Loads graphs from YAML and reports problems with file and line numbers.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LineCounter, parseDocument, isNode } from "yaml";
import { Graph } from "./spec.js";
import { validateBundle, type Issue } from "./validate.js";

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
    const parsed = Graph.safeParse(doc.toJS());
    if (!parsed.success) {
      for (const iss of parsed.error.issues) {
        problems.push({ file, ...locate({ file, doc, lc }, iss.path), where: describe(iss.path), message: iss.message, severity: "error" });
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
