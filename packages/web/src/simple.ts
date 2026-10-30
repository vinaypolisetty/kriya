/**
 * The simple view of a run: only what a person acts on. Steps that just do
 * work fold into the next step you'd care about, which says "working…" while
 * they run. A model step folds into the review of its work, so writing a joke
 * and picking it are one box. At the top of a run, a for-each's items become
 * boxes of their own, and each unfolds: its steps join the same graph, on a
 * row from the item's box to what follows, with no box inside a box. A
 * for-each inside an item is one box per piece of work: each drawing, each
 * page. A big run is a big graph, and that's fine.
 *
 * Pure, and only about what's drawn: the run itself is untouched. Anything
 * failed, blocked or stale always shows, and "Show all steps" shows the recipe
 * as written.
 */
import type { GEdge, GItem, GNode, RunGraph } from "./api";

export type View = { graph: RunGraph; taken?: number[] | undefined };

const BUSY = new Set(["running", "waiting_external", "ready", "fixing"]);
const TROUBLE = new Set(["failed", "blocked", "stale"]);

export const waitsOnYou = (i: GItem) => !!i.steps?.some((s) => s.waitingOnYou);

export function simplify(g: RunGraph, taken?: number[]): View {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const forward = g.edges.map((e, i) => ({ e, i })).filter(({ e }) => !e.back);
  const leadsToReview = (n: GNode) => forward.some(({ e }) => e.from === n.id && byId.get(e.to)?.kind === "screen");
  const worthShowing = (n: GNode) =>
    n.kind === "screen" ||
    TROUBLE.has(n.status) ||
    ((n.kind === "map" || n.kind === "subgraph") && (n.asksYou !== false || !!n.items?.length)) ||
    (n.versions.some((v) => v.thumb?.type.startsWith("video/")) && !leadsToReview(n));
  const seen = new Set(g.nodes.filter(worthShowing).map((n) => n.id));
  if (seen.size === 0) return { graph: g, taken };

  // Where a folded step leads: the next boxes still drawn.
  const next = (id: string, path: string[] = []): string[] =>
    id === "END" || seen.has(id) ? [id] : path.includes(id) ? [] : forward.filter(({ e }) => e.from === id).flatMap(({ e }) => next(e.to, [...path, id]));

  const edges: GEdge[] = [];
  const counts: number[] = [];
  const add = (e: GEdge, count = 0) => {
    const at = edges.findIndex((x) => x.from === e.from && x.to === e.to && !!x.back === !!e.back);
    if (at >= 0) return void (counts[at] = Math.max(counts[at]!, count));
    edges.push(e);
    counts.push(count);
  };
  g.edges.forEach((e, i) => {
    if (!seen.has(e.from)) return;
    if (e.back) {
      const to = next(e.to)[0];
      // A loop back to its own review's model step is just "try again" on that box.
      if (to && to !== e.from) add({ ...e, to }, taken?.[i]);
    } else {
      // "lock" and "approve" say nothing a person needs: the arrow going forward already does.
      const { label: _label, ...plain } = e;
      for (const to of next(e.to)) add({ ...plain, to }, taken?.[i]);
    }
  });

  const working = new Set(g.nodes.filter((n) => !seen.has(n.id) && BUSY.has(n.status)).flatMap((n) => next(n.id)));
  const nodes = g.nodes.filter((n) => seen.has(n.id)).map((n) => {
    // A review's box shows what's being reviewed: the model step that folded into it.
    const made = n.kind === "screen" ? forward.map(({ e }) => (e.to === n.id ? byId.get(e.from) : undefined)).find((f) => f && !seen.has(f.id) && f.versions.length > 0) : undefined;
    // The recipe's own captions ("You decide · 2 buttons") are for whoever wrote it, so they go too.
    return { ...n, detail: "", ...(working.has(n.id) && n.status === "not_started" ? { status: "running" } : {}), ...(made ? { source: made } : {}) };
  });
  const view: View = { graph: { ...g, nodes, edges }, ...(taken ? { taken: counts } : {}) };
  return fanOut(view);
}

/**
 * A for-each's items as boxes. At the top of a run the for-each stays as a box
 * the items branch from; inside an item the pieces of work just replace it.
 */
function fanOut({ graph: g, taken }: View): View {
  const fans = g.nodes.filter((n) => n.items && n.items.length > 0);
  if (fans.length === 0) return { graph: g, taken };
  const inner = !!g.at;
  const nodes: GNode[] = [];
  for (const n of g.nodes) {
    if (!fans.includes(n)) {
      nodes.push(n);
      continue;
    }
    const waiting = n.items!.filter(waitsOnYou).length;
    const { items: _items, ...hub } = n;
    if (!inner) nodes.push({ ...hub, detail: `${n.items!.length} item${n.items!.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting for you` : ""}` });
    const word = n.name.split(" ").at(-1)!;
    for (const i of n.items!) {
      nodes.push({ id: i.key, key: i.key, kind: "item", name: inner ? `${word[0]!.toUpperCase()}${word.slice(1)} ${i.label}` : i.label, detail: "", status: i.status, waitingOnYou: waitsOnYou(i), costUsd: 0, versions: [], item: i, ...(inner ? { leaf: true } : {}) });
    }
  }
  const edges: GEdge[] = [];
  const counts: number[] = [];
  const push = (e: GEdge, count = 0) => (edges.push(e), counts.push(count));
  const keysOf = (id: string) => fans.find((n) => n.id === id)?.items!.map((i) => i.key);
  g.edges.forEach((e, i) => {
    const out = keysOf(e.from);
    const into = inner ? keysOf(e.to) : undefined;
    if (e.back) return push({ ...e, ...(inner && out ? { from: out[0]! } : {}), ...(into ? { to: into[0]! } : {}) }, taken?.[i]);
    for (const from of out ?? [e.from]) for (const to of into ?? [e.to]) push({ ...e, from, to }, taken?.[i]);
  });
  if (!inner) for (const hub of fans) for (const it of hub.items!) push({ from: hub.id, to: it.key }, 1);
  return { graph: { ...g, nodes, edges }, ...(taken ? { taken: counts } : {}) };
}

/** Puts each item's own steps into the graph: item → its first step, its last step → whatever the item led to. */
export function unfold({ graph: g, taken }: View, inside: (n: GNode) => RunGraph | undefined): View {
  let nodes = g.nodes;
  let edges = g.edges;
  let counts = taken ?? g.edges.map(() => 0);
  for (const item of g.nodes) {
    const got = item.kind === "item" ? inside(item) : undefined;
    if (!got) continue;
    const inner = simplify(got).graph;
    const id = (x: string) => `${item.id}/${x}`;
    const fed = new Set(inner.edges.filter((e) => !e.back).map((e) => e.to));
    const firsts = inner.nodes.filter((n) => !fed.has(n.id));
    const lasts = inner.edges.filter((e) => e.to === "END").map((e) => e.from);
    if (firsts.length === 0 || lasts.length === 0) continue;
    const done = (name: string) => ["completed", "done"].includes(inner.nodes.find((n) => n.id === name)?.status ?? "");
    const next: GEdge[] = [];
    const nextCounts: number[] = [];
    const push = (e: GEdge, count: number) => (next.push(e), nextCounts.push(count));
    edges.forEach((e, i) => {
      if (e.from !== item.id) push(e, counts[i] ?? 0);
      else for (const last of lasts) push({ ...e, from: id(last) }, done(last) ? 1 : 0);
    });
    for (const n of firsts) push({ from: item.id, to: id(n.id) }, 1);
    for (const e of inner.edges) if (e.to !== "END") push({ ...e, from: id(e.from), to: id(e.to) }, done(e.from) ? 1 : 0);
    const at = nodes.findIndex((n) => n.id === item.id) + 1;
    nodes = [...nodes.slice(0, at - 1), { ...item, unfolded: true }, ...inner.nodes.map((n) => ({ ...n, id: id(n.id), after: item.id })), ...nodes.slice(at)];
    edges = next;
    counts = nextCounts;
  }
  return { graph: { ...g, nodes, edges }, ...(taken ? { taken: counts } : {}) };
}
