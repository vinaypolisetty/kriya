/**
 * A run as its recipe's graph (Day 24): steps left to right in the order they
 * run, loops drawn as dashed arrows back with their limit, each box showing
 * the step's live state. White: an AI step · amber: you decide · grey: a tool.
 * On a phone the same steps are a list, top to bottom in the same order, each
 * saying where it goes next (Day 27).
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useLive, type GEdge, type GNode, type RunGraph, type TraceView } from "./api";

const W = 216;
const H = 84;
const COL = 290;
const ROW = 150;
const PAD = 40;

type Placed = { id: string; x: number; y: number; h: number; node?: GNode; kind: "start" | "end" | GNode["kind"] };

/** Columns by longest path from the start, over forward arrows only; loops go back and don't count. */
function layout(g: RunGraph): { boxes: Map<string, Placed>; width: number; height: number } {
  const forward = g.edges.filter((e) => !e.back);
  const incoming = new Map<string, number>();
  for (const e of forward) if (e.to !== "END") incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const rank = new Map<string, number>([["START", 0]]);
  for (const n of g.nodes) if (!incoming.get(n.id)) rank.set(n.id, 1);
  // Longest path: relax until nothing moves (graphs here are small and the forward arrows are acyclic).
  for (let changed = true, guard = 0; changed && guard < 100; guard++) {
    changed = false;
    for (const e of forward) {
      const r = (rank.get(e.from) ?? 1) + 1;
      if (e.to !== "END" && (rank.get(e.to) ?? 0) < r) (rank.set(e.to, r), (changed = true));
    }
  }
  const last = Math.max(1, ...g.nodes.map((n) => rank.get(n.id) ?? 1));
  rank.set("END", last + 1);

  const columns = new Map<number, string[]>();
  const add = (id: string) => columns.set(rank.get(id)!, [...(columns.get(rank.get(id)!) ?? []), id]);
  add("START");
  for (const n of g.nodes) add(n.id);
  if (g.edges.some((e) => e.to === "END")) add("END");

  const boxes = new Map<string, Placed>();
  let height = 0;
  for (const [c, ids] of columns) {
    ids.forEach((id, row) => {
      const node = g.nodes.find((n) => n.id === id);
      const h = node?.kind === "map" ? H + 26 : H;
      const y = PAD + row * ROW;
      boxes.set(id, { id, x: PAD + c * COL, y, h, ...(node ? { node } : {}), kind: id === "START" ? "start" : id === "END" ? "end" : node!.kind });
      height = Math.max(height, y + h);
    });
  }
  const width = PAD * 2 + (last + 1) * COL + W;
  return { boxes, width, height: height + PAD + 60 };
}

const STATUS: Record<string, { label: string; tone: string }> = {
  completed: { label: "done", tone: "done" },
  done: { label: "done", tone: "done" },
  locked: { label: "locked", tone: "done" },
  awaiting_human: { label: "waiting for you", tone: "you" },
  running: { label: "working…", tone: "work" },
  waiting_external: { label: "working…", tone: "work" },
  ready: { label: "up next", tone: "work" },
  fixing: { label: "fixing…", tone: "work" },
  failed: { label: "failed", tone: "fail" },
  stale: { label: "stale", tone: "stale" },
  blocked: { label: "blocked", tone: "fail" },
  not_started: { label: "not started", tone: "idle" },
};
export const statusOf = (s: string) => STATUS[s] ?? { label: s.replace(/_/g, " "), tone: "idle" };

/** Whether the screen is phone-sized: the graph turns into a list there. */
export function useNarrow(): boolean {
  const query = "(max-width: 760px)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

type GraphProps = { graph: RunGraph; selected?: string; onSelect: (id: string) => void; onOpenItem: (at: string) => void };
/** What the event log says happened here: how often each arrow was taken (by index in `graph.edges`), each review's last answer. */
type Happened = { taken?: number[]; answers: TraceView["answers"] };

export function Graph(props: GraphProps) {
  const { graph } = props;
  const t = useLive<TraceView>(graph.run ? `/api/runs/${encodeURIComponent(graph.run)}/trace?at=${encodeURIComponent(graph.at)}` : undefined).data;
  const happened: Happened = { ...(t ? { taken: t.taken } : {}), answers: t?.answers ?? {} };
  return useNarrow() ? <StepList {...props} happened={happened} /> : <Canvas {...props} happened={happened} />;
}

/** A loop's words: its limit before it's used ("redo · up to 3×"), how much is used after ("redo · 1 of 3"). */
const loopLabel = (e: GEdge, taken?: number) => `${e.label ?? "again"} · ${taken ? `${taken} of ${e.limit}` : `up to ${e.limit}×`}`;

/** A finished review says what was pressed, and who pressed it, instead of just "done". */
function answered(n: GNode, happened: Happened): string | undefined {
  const a = n.kind === "screen" && n.status === "completed" ? happened.answers[n.key] : undefined;
  return a ? `${a.by === "auto" ? "pressed itself" : "you pressed"}: ${a.action}` : undefined;
}

/** The steps top to bottom in the graph's order (column, then row), each with the arrows leaving it in words. */
function StepList({ graph, selected, onSelect, onOpenItem, happened }: GraphProps & { happened: Happened }) {
  const { boxes } = layout(graph);
  const order = [...boxes.values()].filter((b) => b.node).sort((a, b) => a.x - b.x || a.y - b.y);
  const name = (id: string) => (id === "END" ? "done" : (graph.nodes.find((n) => n.id === id)?.name ?? id));
  return (
    <ol className="step-list">
      {order.map((b) => {
        const out = graph.edges.map((e, i) => ({ ...e, taken: happened.taken?.[i] })).filter((e) => e.from === b.id);
        return (
          <li key={b.id}>
            <Box n={b.node!} selected={selected === b.id} onSelect={onSelect} onOpenItem={onOpenItem} answer={answered(b.node!, happened)} />
            {out.length > 0 && (
              <p className="next">
                {out.map((e, i) => (
                  <span key={i} className={e.back ? "back" : ""}>
                    {e.back ? "↺" : "→"} {e.back ? `${loopLabel(e, e.taken)}: ` : e.label ? `${e.label}: ` : ""}
                    {name(e.to)}
                  </span>
                ))}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Canvas({ graph, selected, onSelect, onOpenItem, happened }: GraphProps & { happened: Happened }) {
  const { boxes, width, height } = layout(graph);
  const startInputs = Object.keys(graph.inputs);
  return (
    <div className="graph-scroll">
      <div className="graph" style={{ width, height }}>
        <svg width={width} height={height} className="edges" aria-hidden="true">
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 Z" className="arrowhead" />
            </marker>
          </defs>
          {startEdges(graph).map((e, i) => (
            <Edge key={`s${i}`} e={e} boxes={boxes} graph={graph} />
          ))}
          {graph.edges.map((e, i) => (
            <Edge key={i} e={e} boxes={boxes} graph={graph} {...(happened.taken ? { taken: happened.taken[i] ?? 0 } : {})} />
          ))}
        </svg>
        {[...boxes.values()].map((b) =>
          b.kind === "start" ? (
            <div key="START" className="box start" style={{ left: b.x, top: b.y, width: W, height: b.h }}>
              <b>{graph.at ? "This item" : "Inputs"}</b>
              <span className="detail">{startInputs.join(", ") || "none"}</span>
            </div>
          ) : b.kind === "end" ? (
            <div key="END" className="box end" style={{ left: b.x, top: b.y, width: W, height: b.h }}>
              <b>Done</b>
              <span className="detail">{graph.status === "completed" ? "finished" : graph.status}</span>
            </div>
          ) : (
            <Box key={b.id} n={b.node!} style={{ left: b.x, top: b.y, width: W, height: b.h }} selected={selected === b.id} onSelect={onSelect} onOpenItem={onOpenItem} answer={answered(b.node!, happened)} />
          ),
        )}
      </div>
    </div>
  );
}

/** The start box points at every step nothing else leads to. */
function startEdges(g: RunGraph): GEdge[] {
  const fed = new Set(g.edges.filter((e) => !e.back).map((e) => e.to));
  return g.nodes.filter((n) => !fed.has(n.id)).map((n) => ({ from: "START", to: n.id }));
}

function Edge({ e, boxes, graph, taken }: { e: GEdge; boxes: Map<string, Placed>; graph: RunGraph; taken?: number }) {
  const a = boxes.get(e.from);
  const b = boxes.get(e.to);
  if (!a || !b) return null;
  // The log says which arrows were taken; before it arrives, a step that started was reached somehow.
  const followed = taken !== undefined ? taken > 0 : e.from !== "START" && graph.nodes.find((n) => n.id === e.from)?.status !== "not_started" && (e.to === "END" ? graph.status === "completed" : graph.nodes.find((n) => n.id === e.to)?.status !== "not_started");
  let d: string;
  let lx: number;
  let ly: number;
  if (e.back) {
    // Back below both boxes: out of the bottom of one, into the bottom of the other.
    const x1 = a.x + W / 2 + 18;
    const y1 = a.y + a.h;
    const x2 = b.x + W / 2 - 18;
    const y2 = b.y + b.h;
    const dip = Math.max(y1, y2) + 46 + Math.abs(x1 - x2) / 12;
    d = `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2 + 2}`;
    lx = (x1 + x2) / 2;
    ly = dip - 8;
  } else {
    const x1 = a.x + W;
    const y1 = a.y + a.h / 2;
    const x2 = b.x - 2;
    const y2 = b.y + b.h / 2;
    const mid = (x1 + x2) / 2;
    d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
    // The label sits near where the arrow arrives: arrows fanning out of one box keep their words apart.
    const t = 0.78;
    const u = 1 - t;
    lx = u * u * u * x1 + 3 * u * u * t * mid + 3 * u * t * t * mid + t * t * t * x2;
    ly = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2 - 7;
  }
  const label = e.back ? loopLabel(e, taken) : e.label;
  return (
    <g className={["edge", e.back ? "back" : "", followed ? "followed" : ""].join(" ")}>
      <path d={d} markerEnd="url(#arrow)" />
      {label && (
        <text x={lx} y={ly} textAnchor="middle">
          {label}
        </text>
      )}
    </g>
  );
}

function Box({ n, style, selected, onSelect, onOpenItem, answer }: { n: GNode; style?: CSSProperties; selected: boolean; onSelect: (id: string) => void; onOpenItem: (at: string) => void; answer?: string | undefined }) {
  const st = statusOf(n.status);
  const shown = n.versions.find((v) => v.id === n.locked?.version) ?? n.versions.at(-1);
  return (
    <div className={["box", `kind-${n.kind}`, `tone-${st.tone}`, n.waitingOnYou ? "you" : "", selected ? "selected" : ""].join(" ")} {...(style ? { style } : {})}>
      <button type="button" className="box-hit" onClick={() => onSelect(n.id)} aria-label={`${n.name}: ${n.waitingOnYou ? "waiting for you" : st.label}`} aria-pressed={selected}>
        <span className="box-main">
          {shown?.thumb?.type.startsWith("image/") && <img src={shown.thumb.url} alt="" className="box-thumb" />}
          <span className="box-text">
            <b>{n.name}</b>
            <span className="detail">{n.detail}</span>
          </span>
        </span>
        <span className={`status tone-${st.tone}`}>{n.waitingOnYou ? "waiting for you" : (answer ?? st.label)}</span>
      </button>
      {n.items && (
        <span className="strip" role="group" aria-label={`${n.items.length} items`}>
          {n.items.map((i) => (
            <button key={i.key} type="button" title={`${i.label}: ${statusOf(i.status).label}`} aria-label={`Open ${i.label}: ${statusOf(i.status).label}`} className={`cell tone-${statusOf(i.status).tone}`} onClick={() => onOpenItem(i.key)} />
          ))}
        </span>
      )}
    </div>
  );
}
