/**
 * A run as its recipe's graph (Day 24): steps left to right in the order they
 * run, loops drawn as dashed arrows back with their limit, each box showing
 * the step's live state. White: an AI step · amber: you decide · grey: a tool.
 * On a phone the same steps are a list, top to bottom in the same order, each
 * saying where it goes next (Day 27).
 *
 * On a wide screen the boxes can be dragged anywhere, like cards on a board;
 * the arrows follow. Where you put them is kept per recipe in this browser
 * only: a layout is a viewer's convenience, not part of the recipe.
 *
 * It's a canvas: pinch or ⌘-scroll zooms around the pointer, scrolling or
 * dragging the empty canvas moves around, and the buttons in the corner zoom
 * and fit the whole graph.
 *
 * Everything opens in place: the graph is the whole page, with no popups and
 * no side panel. Click a step and its box grows to hold its details, or its
 * review if it's waiting on you. Every moment's steps are on this same graph,
 * each on its own row, with each drawing or page a box of its own. A box measures what it holds
 * and the layout makes room, so the boxes after it move along and the arrows
 * follow. A big run is a big graph, and that's fine. (With "Show all steps",
 * an item opens in its row.)
 * The next thing waiting on you opens by itself, and closes when it's decided.
 *
 * The Inputs box and any step that made a video play it right in the box.
 *
 * By default it's the simple view (simple.ts): only the steps a person acts on,
 * with a run's moments as boxes of their own. "Show all steps" shows the recipe.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { graphUrl, fileUrl } from "./App";
import { useLive, useLiveAll, type GEdge, type GItem, type GNode, type Item, type RunGraph, type TraceView } from "./api";
import { NodePanel, RunPanel } from "./NodePanel";
import { Screen } from "./Screen";
import { simplify, unfold, waitsOnYou } from "./simple";

const W = 216;
const H = 84;
const COL = 290;
const ROW = 150;
const PAD = 40;
/** An item's box: wide enough for its line of decisions. */
const ITEM_W = 380;
/** Between one moment's row and the next, with room for a redo loop under it. */
const ROW_GAP = 76;
/** Between pieces of work stacked in one column of a moment's row. */
const WORK_GAP = 16;
/** Between steps inside an item, where there's no room to waste. */
const BARE_COL = 250;

type Placed = { id: string; x: number; y: number; w: number; h: number; node?: GNode; kind: "start" | "end" | GNode["kind"] };
/** What an open box measured its contents at. */
type Size = { w: number; h: number };

/** Columns by longest path from the start, over forward arrows only; loops go back and don't count. An open box widens its column and pushes the boxes below it down. */
function layout(g: RunGraph, sizes: Map<string, Size> = new Map(), bare = false): { boxes: Map<string, Placed>; width: number; height: number } {
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
  if (!bare) add("START");
  for (const n of g.nodes) add(n.id);
  if (!bare && g.edges.some((e) => e.to === "END")) add("END");
  const COLUMN = bare ? BARE_COL : COL;
  const widthOf = (id: string) => {
    const node = g.nodes.find((n) => n.id === id);
    return sizes.get(id)?.w ?? (node?.kind === "item" && !node.leaf && !node.unfolded ? ITEM_W : W);
  };

  // Each column moves right by however much the open boxes before it are wider than a box.
  const extra = new Map<number, number>();
  for (const [c, ids] of columns) extra.set(c, Math.max(0, ...ids.map((id) => widthOf(id) - W)));
  const shift = (c: number) => [...extra].filter(([k]) => k < c).reduce((a, [, v]) => a + v, 0);
  const boxes = new Map<string, Placed>();
  let height = 0;
  // Each moment gets a row: its steps are placed within it here, and the rows are stacked once they're all known.
  const inRow = new Map<string, number>();
  for (const [c, ids] of columns) {
    let below = 0;
    ids.forEach((id, row) => {
      const node = g.nodes.find((n) => n.id === id);
      const size = sizes.get(id);
      const h = size?.h ?? (node?.items ? H + 54 : H);
      if (node?.after) {
        const slot = `${c}:${node.after}`;
        const top = inRow.get(slot) ?? 0;
        inRow.set(slot, top + h + WORK_GAP);
        boxes.set(id, { id, x: PAD + (bare ? c - 1 : c) * COLUMN + shift(c), y: top, w: widthOf(id), h, node, kind: node.kind });
        return;
      }
      if (node?.kind === "item" && !node.leaf) {
        boxes.set(id, { id, x: PAD + (bare ? c - 1 : c) * COLUMN + shift(c), y: 0, w: widthOf(id), h, node, kind: node.kind });
        return;
      }
      const y = Math.max((bare ? 16 : PAD) + row * ROW, below);
      boxes.set(id, { id, x: PAD + (bare ? c - 1 : c) * COLUMN + shift(c), y, w: widthOf(id), h, ...(node ? { node } : {}), kind: id === "START" ? "start" : id === "END" ? "end" : node!.kind });
      below = y + h + 60;
      height = Math.max(height, y + h);
    });
  }
  let top = bare ? 16 : PAD;
  for (const m of g.nodes.filter((n) => n.kind === "item" && !n.after)) {
    const me = boxes.get(m.id)!;
    me.y = top;
    let bottom = top + me.h;
    for (const b of boxes.values()) {
      if (b.node?.after !== m.id) continue;
      b.y += top;
      bottom = Math.max(bottom, b.y + b.h);
    }
    top = bottom + ROW_GAP;
  }
  height = Math.max(height, top);
  const width = bare ? 0 : PAD * 2 + (last + 1) * COL + W + shift(last + 2);
  return { boxes, width, height: height + (bare ? 16 : PAD + 60) };
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

/** `focus` is a step's full key (`per_shot[P3-04].pick`) to start open: the step you clicked on an item's row. */
type GraphProps = { graph: RunGraph; focus?: string | undefined };
/** A graph as drawn; `bare` drops the Inputs and Done boxes, inside an item where they'd only be noise. */
type Drawn = { graph: RunGraph; happened: Happened; opened: Opened; bare: boolean; all: boolean };
/** What the event log says happened here: how often each arrow was taken (by index in `graph.edges`), each review's last answer. */
type Happened = { taken?: number[]; answers: TraceView["answers"] };
/** What's open in this graph: steps by id, for-each items by key with the step to start on. */
type Opened = { steps: Set<string>; folded: Set<string>; items: Map<string, string | undefined>; toggle: (id: string) => void; toggleFold: (id: string) => void; toggleItem: (key: string, step?: string) => void; sync: (g: RunGraph) => void };

const wants = (n: GNode) => n.waitingOnYou || !!n.items?.some(waitsOnYou);
/** A moment still has a decision to come: it stays open, so you finish one before the next. */
const unfinished = (n: GNode) => !!n.item?.steps?.some((s) => s.asksYou && statusOf(s.status).tone !== "done");

/**
 * What's open. Every moment is laid out on the graph unless you fold it. The
 * next decision opens by itself and closes once it's made, one moment at a
 * time, so you finish one before the next. One you closed stays closed.
 */
function useOpened(graph: RunGraph, focus?: string): Opened {
  const [steps, setSteps] = useState(() => new Set(graph.nodes.filter((n) => n.key === focus).map((n) => n.id)));
  const [folded, setFolded] = useState(() => new Set<string>());
  const [items, setItems] = useState(() => new Map<string, string | undefined>());
  const shut = useRef(new Set<string>());
  const auto = useRef(new Set<string>());
  const sync = (g: RunGraph) => {
    const moment = (n: GNode) => n.kind === "item" && !n.leaf;
    const work = g.nodes.filter((n) => !moment(n));
    const going = new Set(work.filter(wants).map((n) => n.id));
    const finished = [...auto.current].filter((id) => !going.has(id));
    finished.forEach((id) => auto.current.delete(id));
    const now = g.nodes.find((n) => moment(n) && unfinished(n))?.id;
    const first = work.find((n) => wants(n) && !shut.current.has(n.id) && (!n.after || n.after === now));
    setSteps((open) => {
      const next = new Set([...open].filter((id) => !finished.includes(id)));
      if (first && ![...next].some((id) => going.has(id))) {
        next.add(first.id);
        auto.current.add(first.id);
      }
      return next.size === open.size && [...next].every((id) => open.has(id)) ? open : next;
    });
  };
  const toggle = (id: string) =>
    setSteps((o) => {
      if (!o.has(id)) return new Set([...o, id]);
      shut.current.add(id);
      return new Set([...o].filter((x) => x !== id));
    });
  const toggleFold = (id: string) => setFolded((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])));
  const toggleItem = (key: string, step?: string) =>
    setItems((o) => {
      if (o.has(key) && !step) return new Map([...o].filter(([k]) => k !== key));
      return new Map([...o, [key, step]]);
    });
  return { steps, folded, items, toggle, toggleFold, toggleItem, sync };
}

/** "Show all steps", remembered in this browser; items inside a run follow it. */
const AllSteps = createContext(false);
const ALL_KEY = "kriya.allSteps";
function useAllSteps(): [boolean, (on: boolean) => void] {
  const [all, setAll] = useState(() => {
    try {
      return localStorage.getItem(ALL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (on: boolean) => {
    setAll(on);
    try {
      if (on) localStorage.setItem(ALL_KEY, "1");
      else localStorage.removeItem(ALL_KEY);
    } catch {
      // Storage off (a private window): it lasts until the page closes.
    }
  };
  return [all, set];
}

export function Graph(props: GraphProps) {
  const { graph, focus } = props;
  const t = useLive<TraceView>(graph.run ? `/api/runs/${encodeURIComponent(graph.run)}/trace?at=${encodeURIComponent(graph.at)}` : undefined).data;
  const inRun = useContext(AllSteps);
  const [mine, setMine] = useAllSteps();
  const all = graph.at ? inRun : mine;
  const view = useMemo(() => (all ? { graph, taken: t?.taken } : simplify(graph, t?.taken)), [graph, t?.taken, all]);
  const opened = useOpened(view.graph, focus);
  // Every moment's own steps, to unfold into this graph.
  const moments = all || graph.at || !graph.run ? [] : view.graph.nodes.filter((n) => n.kind === "item" && !n.leaf && !opened.folded.has(n.id)).map((n) => n.key);
  const inside = useLiveAll<RunGraph>(moments.map((key) => graphUrl(graph.run, key)));
  const whole = useMemo(() => unfold(view, (n) => (opened.folded.has(n.id) ? undefined : inside.get(graphUrl(graph.run, n.key)))), [view, opened.folded, inside, graph.run]);
  useEffect(() => opened.sync(whole.graph), [whole.graph]);
  const happened: Happened = { ...(whole.taken ? { taken: whole.taken } : {}), answers: t?.answers ?? {} };
  const shown = { graph: whole.graph, happened, opened, bare: !all && !!graph.at, all };
  return (
    <AllSteps.Provider value={all}>
      {!graph.at && (
        <label className="show-all">
          <input type="checkbox" checked={all} onChange={(e) => setMine(e.target.checked)} /> Show all steps
        </label>
      )}
      {useNarrow() ? <StepList {...shown} /> : <Canvas {...shown} />}
    </AllSteps.Provider>
  );
}

/** Keeps what an open box holds out of the box's own drag, so picking text or a video's slider doesn't move it. */
const stay = (e: PointerEvent) => e.stopPropagation();

/** Reports the size of what's in a box while `on`, for the layout to make room for it. */
function useMeasure(on: boolean, report?: (size?: Size) => void, open?: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!report) return;
    if (!on || !el) return report();
    const send = () => report({ w: el.offsetWidth + 3, h: el.offsetHeight + 3 });
    send();
    // After the layout has made room: what you just opened comes into view, heading first.
    if (open) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" }));
    const seen = new ResizeObserver(send);
    seen.observe(el);
    return () => seen.disconnect();
  }, [on, open]);
  return ref;
}

/** A loop's words: its limit before it's used ("redo · up to 3×"), how much is used after ("redo · 1 of 3"). */
const loopLabel = (e: GEdge, taken?: number) => `${e.label ?? "again"} · ${taken ? `${taken} of ${e.limit}` : `up to ${e.limit}×`}`;

/** A finished review says what was pressed, and who pressed it, instead of just "done". */
function answered(n: GNode, happened: Happened): string | undefined {
  const a = n.kind === "screen" && n.status === "completed" ? happened.answers[n.key] : undefined;
  return a ? `${a.by === "auto" ? "pressed itself" : "you pressed"}: ${a.action}` : undefined;
}

/** The steps top to bottom in the graph's order (column, then row), each with the arrows leaving it in words. */
function StepList({ graph, happened, opened, bare, all }: Drawn) {
  const { boxes } = layout(graph, undefined, bare);
  const order = [...boxes.values()].filter((b) => b.node).sort((a, b) => a.x - b.x || a.y - b.y);
  const name = (id: string) => (id === "END" ? "done" : (graph.nodes.find((n) => n.id === id)?.name ?? id));
  return (
    <ol className="step-list">
      {!bare && (
        <li>
          <StartBox graph={graph} open={opened.steps.has(START)} onToggle={() => opened.toggle(START)} />
        </li>
      )}
      {order.map((b) => {
        const out = graph.edges.map((e, i) => ({ ...e, taken: happened.taken?.[i] })).filter((e) => e.from === b.id);
        return (
          <li key={b.id}>
            <Box n={b.node!} graph={graph} opened={opened} {...(all ? { answer: answered(b.node!, happened) } : {})} />
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

/** Box positions you dragged, per recipe, from this browser's storage (which may be off or empty). */
type Moved = Record<string, { x: number; y: number }>;
const layoutKey = (recipe: string) => `kriya.layout.${recipe}`;
function loadMoved(recipe: string): Moved {
  try {
    return JSON.parse(localStorage.getItem(layoutKey(recipe)) ?? "{}") as Moved;
  } catch {
    return {};
  }
}
function saveMoved(recipe: string, moved: Moved): void {
  try {
    if (Object.keys(moved).length) localStorage.setItem(layoutKey(recipe), JSON.stringify(moved));
    else localStorage.removeItem(layoutKey(recipe));
  } catch {
    // Storage off (a private window): the layout lasts until the page closes.
  }
}

const GRID = 10;
/** How far the pointer moves before a press becomes a drag; less is a click that opens the step. */
const SLOP = 4;

/** Dragging boxes: a press that moves more than SLOP drags; the click that ends a drag doesn't open the step. */
function useDrag(recipe: string, auto: Map<string, Placed>) {
  const [moved, setMoved] = useState<Moved>(() => loadMoved(recipe));
  useEffect(() => setMoved(loadMoved(recipe)), [recipe]);
  const drag = useRef<{ id: string; px: number; py: number; x: number; y: number; scale: number; on: boolean } | null>(null);
  const justDragged = useRef(false);
  const boxes = new Map([...auto].map(([id, b]) => [id, moved[id] ? { ...b, ...moved[id] } : b]));

  const handlers = (id: string): HTMLAttributes<HTMLDivElement> => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const b = boxes.get(id)!;
      // Read off the box, so it follows the pointer at any zoom, even in a graph inside a zoomed one.
      const scale = e.currentTarget.getBoundingClientRect().width / e.currentTarget.offsetWidth;
      drag.current = { id, px: e.clientX, py: e.clientY, x: b.x, y: b.y, scale, on: false };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== id) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.on) {
        if (Math.hypot(dx, dy) < SLOP) return;
        d.on = true;
        // Captured only once it's a drag, so a plain click still reaches the step's button.
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      const snap = (v: number) => Math.max(0, Math.round(v / GRID) * GRID);
      setMoved((m) => ({ ...m, [id]: { x: snap(d.x + dx / d.scale), y: snap(d.y + dy / d.scale) } }));
    },
    onPointerUp: () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.on) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      setMoved((m) => (saveMoved(recipe, m), m));
    },
    onClickCapture: (e) => {
      if (justDragged.current) e.stopPropagation();
    },
  });
  const reset = () => {
    saveMoved(recipe, {});
    setMoved({});
  };
  return { boxes, handlers, reset, dragging: (id: string) => drag.current?.on === true && drag.current.id === id, anyMoved: Object.keys(moved).length > 0 };
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
/** One press of + or −. */
const ZOOM_STEP = 1.25;
/** Empty canvas on every side, so the spot under the pointer can stay put when zooming and you can move past the graph's edges. */
const ROOM = 4000;

/**
 * The window onto the graph. It's a native scroller with the graph scaled
 * inside, not a transform that stands in for scrolling: trackpad momentum,
 * scrollers inside a box and a box scrolling itself into view all keep working.
 * `children` come in from Canvas, so a zoom doesn't redraw 200 boxes.
 */
function Zoomable({ width, height, tools, children }: { width: number; height: number; tools?: ReactNode; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const latest = useRef(1);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);

  /** Zooms to `next`, keeping the spot at (x, y) in the window where it is. */
  const zoomAt = (next: number, x: number, y: number) => {
    const el = scroller.current!;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const spotX = (el.scrollLeft + x - ROOM) / latest.current;
    const spotY = (el.scrollTop + y - ROOM) / latest.current;
    latest.current = z;
    // Drawn now, so the scroll below lands on the new size and nothing jumps.
    flushSync(() => setZoom(z));
    el.scrollLeft = spotX * z + ROOM - x;
    el.scrollTop = spotY * z + ROOM - y;
  };
  const zoomMiddle = (next: number) => zoomAt(next, scroller.current!.clientWidth / 2, scroller.current!.clientHeight / 2);
  /** The whole graph, centred. It never blows a small graph up past 100%. */
  const fit = () => {
    const el = scroller.current!;
    zoomAt(Math.min(1, el.clientWidth / width, el.clientHeight / height), 0, 0);
    el.scrollLeft = ROOM + (width * latest.current - el.clientWidth) / 2;
    el.scrollTop = ROOM + (height * latest.current - el.clientHeight) / 2;
  };

  useLayoutEffect(() => {
    scroller.current!.scrollTo(ROOM, ROOM);
  }, []);
  useEffect(() => {
    const el = scroller.current!;
    // Not React's onWheel, which can't stop the browser zooming the whole page. A pinch arrives as a ctrl-scroll.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Limited, so one notch of a mouse wheel is a step while a pinch's many small ones stay smooth.
      const delta = Math.max(-30, Math.min(30, e.deltaMode ? e.deltaY * 16 : e.deltaY));
      zoomAt(latest.current * Math.exp(-delta / 100), e.clientX - r.left, e.clientY - r.top);
    };
    // Only over the canvas: everywhere else ⌘+ still zooms the page.
    const key = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || !el.matches(":hover")) return;
      const next = e.key === "=" || e.key === "+" ? latest.current * ZOOM_STEP : e.key === "-" ? latest.current / ZOOM_STEP : e.key === "0" ? 1 : undefined;
      if (next === undefined) return;
      e.preventDefault();
      zoomMiddle(next);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    addEventListener("keydown", key);
    return () => {
      el.removeEventListener("wheel", wheel);
      removeEventListener("keydown", key);
    };
  }, []);

  // The left button moves the canvas from empty space, since on a box it moves the box; the middle one works anywhere.
  const press = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 1 && (e.button !== 0 || (e.target as Element).closest(".box"))) return;
    const el = e.currentTarget;
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
    setPanning(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p) return;
    e.currentTarget.scrollLeft = p.left - (e.clientX - p.x);
    e.currentTarget.scrollTop = p.top - (e.clientY - p.y);
  };
  const release = () => {
    pan.current = null;
    setPanning(false);
  };

  const percent = Math.round(zoom * 100);
  return (
    <>
      <div className="graph-tools">
        <div className="zoom" role="group" aria-label="Zoom">
          <button type="button" title="Zoom out (⌘−)" aria-label="Zoom out" onClick={() => zoomMiddle(latest.current / ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>
            −
          </button>
          <button type="button" className="zoom-level" title="Back to 100% (⌘0)" aria-label={`Zoomed to ${percent}%. Back to 100%`} onClick={() => zoomMiddle(1)}>
            {percent}%
          </button>
          <button type="button" title="Zoom in (⌘+)" aria-label="Zoom in" onClick={() => zoomMiddle(latest.current * ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>
            +
          </button>
          <button type="button" title="Show the whole graph" onClick={fit}>
            Fit
          </button>
        </div>
        {tools}
      </div>
      <div ref={scroller} className={`graph-scroll${panning ? " panning" : ""}`} onPointerDown={press} onPointerMove={move} onPointerUp={release} onPointerCancel={release} onMouseDown={(e) => e.button === 1 && e.preventDefault()}>
        <div className="graph-room" style={{ width: width * zoom + ROOM * 2, height: height * zoom + ROOM * 2 }}>
          <div className="graph-zoom" style={{ left: ROOM, top: ROOM, transform: `scale(${zoom})` }}>
            {children}
          </div>
        </div>
      </div>
    </>
  );
}

function Canvas({ graph, happened, opened, bare, all }: Drawn) {
  const [sizes, setSizes] = useState(() => new Map<string, Size>());
  const measure = (id: string) => (size?: Size) =>
    setSizes((m) => {
      const was = m.get(id);
      if (was?.w === size?.w && was?.h === size?.h) return m;
      const next = new Map(m);
      if (size) next.set(id, size);
      else next.delete(id);
      return next;
    });
  const auto = layout(graph, sizes, bare);
  const { boxes, handlers, reset, dragging, anyMoved } = useDrag(graph.recipe, auto.boxes);
  const placed = [...boxes.values()];
  const width = Math.max(auto.width, ...placed.map((b) => b.x + b.w + PAD));
  const height = Math.max(auto.height, ...placed.map((b) => b.y + b.h + (bare ? 16 : PAD + 60)));
  const resetLayout = anyMoved && (
    <button type="button" className="layout-reset" onClick={reset}>
      Reset layout
    </button>
  );
  const drawn = (
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
          <StartBox key="START" graph={graph} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} open={opened.steps.has(START)} onToggle={() => opened.toggle(START)} drag={handlers("START")} dragging={dragging("START")} measure={measure("START")} />
        ) : b.kind === "end" ? (
          <div key="END" className={`box end${dragging("END") ? " dragging" : ""}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} {...handlers("END")}>
            <b>Done</b>
            <span className="detail">{graph.status === "completed" ? "finished" : graph.status}</span>
          </div>
        ) : (
          <Box key={b.id} n={b.node!} graph={graph} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} {...(all ? { answer: answered(b.node!, happened) } : {})} drag={handlers(b.id)} dragging={dragging(b.id)} opened={opened} measure={measure(b.id)} />
        ),
      )}
    </div>
  );
  // An item's graph sits inside a box, so it zooms with the graph around it.
  return graph.at ? (
    <div className="graph-inner">
      {resetLayout}
      {drawn}
    </div>
  ) : (
    <Zoomable width={width} height={height} tools={resetLayout}>
      {drawn}
    </Zoomable>
  );
}

/** The Inputs box's place in what's open: no step is called this (ids are lower_snake_case). */
export const START = "START";

/** A run's video or picture, given as a file of the project; the box plays it. */
function inputFile(graph: RunGraph): { type: string; url: string } | undefined {
  const name = Object.keys(graph.inputs).find((k) => (graph.inputs[k] === "video" || graph.inputs[k] === "image") && typeof graph.given?.[k] === "string");
  return name ? { type: graph.inputs[name]!, url: fileUrl(graph.given![name] as string) } : undefined;
}

/** The Inputs box: the video it was given, and opened, what it started with and everything that happened. */
function StartBox({ graph, style, open, onToggle, drag, dragging, measure }: { graph: RunGraph; style?: CSSProperties; open: boolean; onToggle: () => void; drag?: HTMLAttributes<HTMLDivElement>; dragging?: boolean; measure?: (size?: Size) => void }) {
  const file = inputFile(graph);
  const fits = open || !!file;
  const inner = useMeasure(fits, measure, open);
  return (
    <div className={`box start${open ? " open selected" : ""}${fits ? " fits" : ""}${dragging ? " dragging" : ""}`} {...(style ? { style } : {})} {...drag}>
      <div className="box-inner" ref={inner}>
        <button type="button" className="box-hit" onClick={onToggle} aria-label={`${graph.at ? "This item" : "Inputs"}: see what it was given`} aria-expanded={open}>
          <b>{graph.at ? "This item" : "Inputs"}</b>
          <span className="detail">{Object.keys(graph.inputs).join(", ") || "none"}</span>
        </button>
        {file && (
          <div className="box-video" onPointerDown={stay}>
            {file.type === "video" ? <video src={file.url} controls playsInline preload="metadata" /> : <img src={file.url} alt="" />}
          </div>
        )}
        {open && (
          <div className="box-open" onPointerDown={stay}>
            <RunPanel graph={graph} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A review inside its box, or a for-each's next one: decided right on the graph, then the box closes and the run moves on. */
function BoxReview({ n, run }: { n: GNode; run: string }) {
  const inbox = useLive<{ items: Item[] }>("/api/inbox");
  const item = inbox.data?.items.find((i) => i.id === `${run}:${n.key}` || i.id.startsWith(`${run}:${n.key}[`) || i.id.startsWith(`${run}:${n.key}.`));
  if (!item) return <p className="muted small">{inbox.error ?? "Loading the review…"}</p>;
  return <Screen key={item.id + item.shows.map((s) => s.version).join()} item={item} batch={[item]} embedded onBack={() => {}} onError={() => {}} onDone={() => {}} />;
}

/** One for-each item's own graph, inside its row. */
function ItemGraph({ run, at, focus }: { run: string; at: string; focus?: string | undefined }) {
  const g = useLive<RunGraph>(graphUrl(run, at));
  if (g.error) return <p className="error">{g.error}</p>;
  if (!g.data) return <p className="muted small">Loading…</p>;
  return <Graph graph={g.data} focus={focus} />;
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
    const x1 = a.x + a.w / 2 + 18;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2 - 18;
    const y2 = b.y + b.h;
    const dip = Math.max(y1, y2) + 46 + Math.abs(x1 - x2) / 12;
    d = `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2 + 2}`;
    lx = (x1 + x2) / 2;
    ly = dip - 8;
  } else {
    // Arrows stay on a box's heading, so opening it doesn't swing them down to its middle.
    const x1 = a.x + a.w;
    const y1 = a.y + Math.min(a.h, H) / 2;
    const x2 = b.x - 2;
    const y2 = b.y + Math.min(b.h, H) / 2;
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

/** The mark after an item's step: what state it's in at a glance. */
const MARK: Record<string, string> = { done: "✓", you: "⏳", fail: "✗", work: "…", stale: "~" };

function Box({ n, graph, style, answer, drag, dragging, opened, measure }: { n: GNode; graph: RunGraph; style?: CSSProperties; answer?: string | undefined; drag?: HTMLAttributes<HTMLDivElement>; dragging?: boolean; opened: Opened; measure?: (size?: Size) => void }) {
  const st = statusOf(n.status);
  const made = n.source ?? n;
  const shown = made.versions.find((v) => v.id === made.locked?.version) ?? made.versions.at(-1);
  // A moment doesn't open inside itself: its steps are on the graph after it, and clicking folds them away.
  const moment = !!n.item && !n.leaf;
  const unfolded = !!n.unfolded;
  const open = !moment && opened.steps.has(n.id);
  const waitingItems = n.items?.filter(waitsOnYou).length ?? 0;
  const clip = shown?.thumb?.type.startsWith("video/") ? shown.thumb : undefined;
  const picture = n.item?.thumb ?? (shown?.thumb?.type.startsWith("image/") ? shown.thumb : undefined);
  const fits = open || !!clip;
  const inner = useMeasure(fits, measure, open);
  const toggle = () => (moment ? opened.toggleFold(n.id) : opened.toggle(n.id));
  const asking = n.waitingOnYou || waitingItems > 0;
  return (
    <div className={["box", `kind-${n.kind}`, `tone-${st.tone}`, asking ? "you" : "", dragging ? "dragging" : "", open ? "open" : "", unfolded ? "unfolded" : "", fits ? "fits" : ""].join(" ")} {...(style ? { style } : {})} {...drag}>
      <div className="box-inner" ref={inner}>
        <button type="button" className="box-hit" onClick={toggle} aria-label={`${n.name}: ${asking ? "waiting for you" : st.label}`} aria-expanded={open || unfolded}>
          <span className="box-main">
            {picture && <img src={picture.url} alt="" className="box-thumb" />}
            <span className="box-text">
              <b>{n.name}</b>
              {n.detail && <span className="detail">{n.detail}</span>}
            </span>
          </span>
          {moment ? !unfolded && <Decisions item={n.item!} /> : <span className={`status tone-${st.tone}`}>{asking ? "waiting for you" : (answer ?? st.label)}</span>}
        </button>
        {clip && (
          <div className="box-video" onPointerDown={stay}>
            <video src={clip.url} controls playsInline preload="metadata" />
          </div>
        )}
        {n.items && !(open && waitingItems > 0) && (
          <button type="button" className="items-toggle" onClick={toggle} aria-expanded={open}>
            {open ? "▴ Hide" : "▾ Show"} {n.items.length} item{n.items.length === 1 ? "" : "s"}
            {waitingItems > 0 && <span className="tone-you"> · {waitingItems} waiting for you</span>}
          </button>
        )}
        {n.items && !open && (
          <span className="strip" role="group" aria-label={`${n.items.length} items`}>
            {n.items.map((i) => (
              <button
                key={i.key}
                type="button"
                title={`${i.label}: ${statusOf(i.status).label}`}
                aria-label={`Open ${i.label}: ${statusOf(i.status).label}`}
                className={`cell tone-${statusOf(i.status).tone}`}
                onClick={() => {
                  toggle();
                  opened.toggleItem(i.key);
                }}
              />
            ))}
          </span>
        )}
        {open && (
          <div className="box-open" onPointerDown={stay}>
            {n.items && waitingItems === 0 && (
              <ul className="item-rows">
                {n.items.map((i) => (
                  <ItemRow key={i.key} i={i} run={graph.run} opened={opened} />
                ))}
              </ul>
            )}
            {asking && graph.run && <BoxReview n={n} run={graph.run} />}
            {n.leaf ? (
              !asking && picture && <img className="box-picture" src={picture.url} alt="" />
            ) : !graph.run ? (
              <p className="muted small">Not run yet. Its versions, checks and lock show up here once a run reaches it.</p>
            ) : n.items || asking ? (
              <details className="box-more">
                <summary>Step details</summary>
                <NodePanel n={made} run={graph.run} />
              </details>
            ) : (
              <NodePanel n={made} run={graph.run} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A moment's decisions as one line, in order: what's done, what's waiting on you, what's to come. */
function Decisions({ item }: { item: GItem }) {
  const asked = item.steps?.filter((s) => s.asksYou) ?? [];
  return (
    <span className="decisions-line">
      {asked.map((s) => {
        const tone = s.waitingOnYou ? "you" : statusOf(s.status).tone;
        const word = s.name.split(" ").at(-1)!;
        return (
          <span key={s.key} className={`tone-${tone}`}>
            {word[0]!.toUpperCase() + word.slice(1)} {MARK[tone] ?? ""}
          </span>
        );
      })}
    </span>
  );
}

/** One item of a for-each: click it and its own graph opens right below; a step's button opens the item at that step. */
function ItemRow({ i, run, opened }: { i: GItem; run: string; opened: Opened }) {
  const open = opened.items.has(i.key);
  return (
    <>
      <li className={`item-row${open ? " open" : ""}`} onClick={(e) => (e.target as HTMLElement).closest("button") || opened.toggleItem(i.key)}>
        <span className="item-label mono">{i.label}</span>
        {i.thumb ? <img src={i.thumb.url} alt="" className="item-thumb" loading="lazy" /> : <span className="item-thumb none" />}
        <span className="item-steps">
          {i.steps?.map((s) => {
            const tone = s.waitingOnYou ? "you" : statusOf(s.status).tone;
            return (
              <button key={s.key} type="button" className={`step-tag tone-${tone}`} title={`${s.name}: ${s.waitingOnYou ? "waiting for you" : statusOf(s.status).label}`} onClick={() => opened.toggleItem(i.key, s.key)}>
                {s.name.split(" ")[0]} {MARK[tone] ?? ""}
              </button>
            );
          })}
        </span>
        <button type="button" className="icon item-open" aria-expanded={open} aria-label={`${open ? "Close" : "Open"} ${i.label}`} onClick={() => opened.toggleItem(i.key)}>
          {open ? "▴" : "▾"}
        </button>
      </li>
      {open && (
        <li className="item-graph">
          <ItemGraph key={opened.items.get(i.key) ?? ""} run={run} at={i.key} focus={opened.items.get(i.key)} />
        </li>
      )}
    </>
  );
}
