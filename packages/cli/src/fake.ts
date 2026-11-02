/**
 * Fake models, so a whole episode runs from the terminal
 * with no keys and no cost. Outputs are made up from each step's declared
 * `out` types, so the recipe's own conditions and maps still work.
 */
import type { Chat } from "@kriya/adapters";
import { libraryKind, type Executors, type Graph, type Node, type StepContext, type Tools } from "@kriya/engine";

/** The Library's names by kind; fake outputs use real names where a field is typed `library.<kind>`. */
type Names = (kind: string) => string[];

export function fakeExecutors(graphs: Graph[], names: Names = () => []): Executors {
  const graphOf = (node: Node) => graphs.find((g) => g.nodes.includes(node));
  const exec: Executors = {
    produce(node, ctx) {
      const out = "out" in node ? node.out : {};
      const n = node.kind === "model" ? node.options : 1;
      if (Object.keys(out).length === 0) return Array.from({ length: n }, () => ({ done: true }));
      const types = graphOf(node)?.types ?? {};
      return Array.from({ length: n }, (_, i) =>
        Object.fromEntries(Object.entries(out).map(([field, type]) => [field, fakeValue(type, field, types, ctx, i + 1, 1, names)])),
      );
    },
    // People answer through `kriya decide`: every screen waits.
    decide: () => undefined,
    // A fake judge passes everything (code checks still run for real).
    check: (_node, _ctx, candidates) => candidates.map((c) => ({ version: c.version, pass: true, issues: [], model: "fake" })),
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

/**
 * A fake step chat (D-87), no key, no cost: "lock v2, the smile reads" locks v2 with that why;
 * "make v1 at night" (or change, edit, redo, try) makes a new version; anything else gets an echo.
 */
export const fakeChat: Chat = async (brief) => {
  const said = brief.message;
  const usage = { model: "fake", cost_usd: 0 };
  const lock = /\block v(\d+)\b[\s,.:;—-]*(.*)$/i.exec(said);
  if (lock) return { text: `Locking v${lock[1]}.`, actions: [{ do: "lock", version: Number(lock[1]), why: lock[2]!.trim() }], ...usage };
  if (/^(make|change|edit|redo|try)\b/i.test(said)) {
    const from = Number(/\bv(\d+)\b/i.exec(said)?.[1] ?? 0);
    const how = /\b(redo|again)\b/i.test(said) || !brief.canEdit ? "redo" : "edit";
    return { text: "Making a new version.", actions: [{ do: "make", from, instruction: said, how }], ...usage };
  }
  return { text: `(fake chat) ${brief.step.name} has ${brief.versions.length} version${brief.versions.length === 1 ? "" : "s"}. You said: ${said}`, actions: [], ...usage };
};

/** Tools that do nothing but say what they were asked (fake mode; real tools arrive on Day 19). */
export function fakeTools(): Tools {
  return {
    call: (tool, args) => ({ fake: true, tool, args: args ?? null }),
    describe: (tool) => ({ description: `${tool} (a stand-in: it echoes what it was asked until real tools arrive on Day 19)`, input_schema: { type: "object" } }),
  };
}

function fakeValue(type: string, field: string, types: Graph["types"], ctx: StepContext, candidate: number, index = 1, names: Names = () => []): unknown {
  const kind = libraryKind(type);
  if (kind) {
    const known = names(kind);
    const pick = (i: number) => (known.length ? known[(i - 1) % known.length]! : `${kind} ${i}`);
    return type.startsWith("list<") ? (known.length ? [pick(index), pick(index + 1)].filter((x, i, a) => a.indexOf(x) === i) : []) : pick(index);
  }
  const list = /^list<(.+)>$/.exec(type);
  if (list) {
    const inner = list[1]!;
    if (!types[inner]) return [];
    const prefix = inner[0]!.toUpperCase();
    return [1, 2, 3].map((i) => fakeRecord(types, inner, ctx, candidate, i, `${prefix}${i}`, names));
  }
  if (types[type]) return fakeRecord(types, type, ctx, candidate, index, `${type[0]!.toUpperCase()}${index}`, names);
  switch (type) {
    case "text": return `${field} (fake) for ${ctx.key}`;
    case "number": return field === "seconds" ? 4 : index;
    case "boolean": return index % 2 === 1;
    case "json": return {};
    default: return `fake://${type}/${ctx.key}/v${ctx.visit}.${candidate}`; // image, audio, video, file
  }
}

function fakeRecord(types: Graph["types"], type: string, ctx: StepContext, candidate: number, index: number, id: string, names: Names): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(types[type]!.fields).map(([f, t]) => [f, f === "id" ? id : t.startsWith("list<") && !types[t.slice(5, -1)] && !libraryKind(t) ? [] : fakeValue(t, f, types, ctx, candidate, index, names)]),
  );
}
