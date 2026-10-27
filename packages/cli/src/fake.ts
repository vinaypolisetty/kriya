/**
 * Fake models, so a whole episode runs from the terminal
 * with no keys and no cost. Outputs are made up from each step's declared
 * `out` types, so the recipe's own conditions and maps still work.
 */
import type { Executors, Graph, Node, StepContext, Tools } from "@kriya/engine";

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
