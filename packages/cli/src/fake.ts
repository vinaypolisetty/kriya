/**
 * Fake models and a fake Library, so a whole episode runs from the terminal
 * with no keys and no cost. Outputs are made up from each step's declared
 * `out` types, so the recipe's own conditions and maps still work.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Assets, Executors, Graph, Node, StepContext, Tools } from "@kriya/engine";

export function fakeExecutors(graphs: Graph[]): Executors {
  const graphOf = (node: Node) => graphs.find((g) => g.nodes.includes(node));
  const exec: Executors = {
    produce(node, ctx) {
      const out = "out" in node ? node.out : {};
      const n = node.kind === "model" ? node.options : 1;
      if (Object.keys(out).length === 0) return Array.from({ length: n }, () => ({ done: true }));
      const types = graphOf(node)?.types ?? {};
      return Array.from({ length: n }, (_, i) =>
        Object.fromEntries(Object.entries(out).map(([field, type]) => [field, fakeValue(type, field, types, ctx, i + 1)])),
      );
    },
    // People answer through `kriya decide`: every screen waits.
    decide: () => undefined,
    // A fake agent calls its first tool once, then answers with made-up outputs.
    turn(node, ctx, history) {
      const usage = { tokens: { input: 0, output: 0 }, model: "fake", cost_usd: 0 };
      const tool = node.tools[0]!;
      const args = tool === "ask_human" ? { question: `Anything I should know before I start? (${node.goal})` } : { goal: node.goal };
      if (history.length === 0) return { reply: { calls: [{ tool, args }] }, ...usage };
      const [final] = exec.produce(node, ctx) as Record<string, unknown>[];
      return { reply: { final: final! }, ...usage };
    },
  };
  return exec;
}

/** Tools that do nothing but say what they were asked (fake mode; real tools arrive on Day 19). */
export function fakeTools(): Tools {
  return {
    call: (tool, args) => ({ fake: true, tool, args: args ?? null }),
    describe: (tool) => ({ description: `${tool} (a stand-in: it echoes what it was asked until real tools arrive on Day 19)`, input_schema: { type: "object" } }),
  };
}

function fakeValue(type: string, field: string, types: Graph["types"], ctx: StepContext, candidate: number, index = 1): unknown {
  const list = /^list<(.+)>$/.exec(type);
  if (list) {
    const inner = list[1]!;
    if (!types[inner]) return [];
    const prefix = inner[0]!.toUpperCase();
    return [1, 2, 3].map((i) => fakeRecord(types, inner, ctx, candidate, i, `${prefix}${i}`));
  }
  if (types[type]) return fakeRecord(types, type, ctx, candidate, index, `${type[0]!.toUpperCase()}${index}`);
  switch (type) {
    case "text": return `${field} (fake) for ${ctx.key}`;
    case "number": return field === "seconds" ? 4 : index;
    case "boolean": return index % 2 === 1;
    case "json": return {};
    default: return `fake://${type}/${ctx.key}/v${ctx.visit}.${candidate}`; // image, audio, video, file
  }
}

function fakeRecord(types: Graph["types"], type: string, ctx: StepContext, candidate: number, index: number, id: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(types[type]!.fields).map(([f, t]) => [f, f === "id" ? id : t.startsWith("list<") && !types[t.slice(5, -1)] ? [] : fakeValue(t, f, types, ctx, candidate, index)]),
  );
}

/**
 * The project's Library (kriya.yaml `library:`), and a fake facet for anything
 * missing in fake mode. A facet is a path (`sheets/mitra.png`), words, or both:
 * `{ image: sheets/mitra.png, words: "a thin 60-year-old bald man…" }`.
 * Its version is a hash of the image's bytes and the words, so redrawing a
 * sheet in place makes the shots that used it stale. A sheet that isn't there
 * counts as missing: the step waits for it instead of drawing a stranger.
 */
export function projectAssets(library: Record<string, unknown>, fake: boolean, root: string): Assets {
  const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
  /** Sheet hashes by path, size and modified time: a run with many shots doesn't rehash the same files. */
  const hashes = new Map<string, string>();
  const sheetHash = (file: string) => {
    const st = statSync(file);
    const k = `${file}|${st.size}|${st.mtimeMs}`;
    let h = hashes.get(k);
    if (!h) hashes.set(k, (h = createHash("sha256").update(readFileSync(file)).digest("hex")));
    return h;
  };
  return {
    facet(entity, facet) {
      const key = `${entity}.${facet}`;
      if (!(key in library)) return fake ? { version: "fake", value: `fake:${key}` } : undefined;
      const value = library[key];
      const look = (value && typeof value === "object" ? value : IMAGE.test(String(value)) ? { image: value } : { words: value }) as { image?: unknown; words?: unknown };
      const h = createHash("sha256");
      if (typeof look.image === "string") {
        const file = resolve(root, look.image);
        if (!file.startsWith(root + "/") || !existsSync(file)) return fake ? { version: "fake", value } : undefined;
        h.update(sheetHash(file));
      }
      h.update(JSON.stringify(look.words ?? null));
      return { version: h.digest("hex").slice(0, 12), value };
    },
  };
}
