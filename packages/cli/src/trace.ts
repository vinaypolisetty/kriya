/**
 * What happened in a run, in plain words (Day 36): the event log read back as
 * one line per thing that mattered: a draft made, a check's verdict, a button
 * pressed and by whom, a lock, an arrow followed, work going stale. The same
 * lines feed `kriya log` and each step's panel in `kriya web`, so the terminal
 * and the browser tell one story.
 *
 * Pure: events in, lines out. Bookkeeping events (a step ready, a job resumed)
 * are left out; everything a person would ask "why?" about stays in.
 */
import type { StoredEvent } from "@kriya/store";
import { findGraph, type Graph } from "@kriya/engine";

/** One thing that happened. `tone` says who or what did it, for colouring. */
export type TraceLine = { seq: number; at: string; key: string; text: string; tone: "you" | "auto" | "model" | "check" | "fail" | "info" };

type P = Record<string, unknown> & { node?: string };
const money = (usd: unknown) => (typeof usd === "number" && usd > 0 ? ` · $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}` : "");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const quote = (s: unknown) => (typeof s === "string" && s ? ` "${flat(s).length > 140 ? `${flat(s).slice(0, 137)}…` : flat(s)}"` : "");

/**
 * Every line of a run, oldest first. With `key`, only that step's (and the
 * steps that refine it); with `under`, only steps inside that for-each item.
 */
export function trace(events: StoredEvent[], graphs: Graph[] = [], opts: { key?: string; under?: string } = {}): TraceLine[] {
  const lines: TraceLine[] = [];
  const nodes = new Map(graphs.flatMap((g) => g.nodes.map((n) => [n.id, n] as const)));
  const nameOf = (key: string) => {
    const id = key.slice(key.lastIndexOf(".") + 1);
    return nodes.get(id)?.name ?? id;
  };
  const refinedBy = new Map<string, string>(); // edit → draw, from versions it made
  for (const e of events) {
    const p = e.payload as P;
    if (e.type === "CandidateProduced" && typeof p.made_by === "string" && p.node) refinedBy.set(p.made_by, p.node);
  }
  const wanted = (key: string) =>
    (!opts.key || key === opts.key || refinedBy.get(key) === opts.key) && (!opts.under || key.startsWith(opts.under));
  const add = (e: StoredEvent, key: string, text: string, tone: TraceLine["tone"]) => {
    if (wanted(key) || (e.type === "Locked" && pressed && e.seq - pressed.seq <= 3 && wanted(pressed.key))) lines.push({ seq: e.seq, at: e.at, key, text, tone });
  };
  // A lock right after a button press is that button's doing (approve locks the shot list): it shows on both.
  let pressed: { seq: number; key: string } | undefined;

  for (const e of events) {
    const p = e.payload as P;
    const key = p.node ?? "";
    switch (e.type) {
      case "RunStarted": {
        if (opts.key || opts.under) break;
        const inputs = Object.entries((p.inputs as Record<string, unknown>) ?? {}).map(([k, v]) => `${k}=${flat(String(typeof v === "string" ? v : JSON.stringify(v))).slice(0, 40)}`);
        lines.push({ seq: e.seq, at: e.at, key: "", text: `Run started: ${String(p.graph)}${inputs.length ? ` with ${inputs.join(", ")}` : ""}`, tone: "info" });
        break;
      }
      case "AttemptStarted":
        add(e, key, Number(p.attempt) > 1 ? `Attempt ${String(p.attempt)} started` : "Started", "info");
        break;
      case "CandidateProduced": {
        const v = `${String(p.attempt)}.${String(p.candidate)}`;
        const from = (p.parents as string[] | undefined)?.length ? ` from ${(p.parents as string[]).join(" + ")}` : "";
        const how = p.made_by ? ` by ${nameOf(String(p.made_by))}` : "";
        add(e, key, `Made ${v}${how}${from}${p.model ? ` · ${String(p.model)}` : ""}${money(p.cost_usd)}${p.instruction ? ` · asked:${quote(p.instruction)}` : ""}`, "model");
        break;
      }
      case "VerdictRecorded": {
        const issues = (p.issues as { type: string; what?: string }[] | undefined) ?? [];
        const who = p.by === "human" ? "You checked" : p.by === "code" ? "Checked" : "The judge checked";
        add(e, key, p.pass ? `${who} ${String(p.version)}: passed` : `${who} ${String(p.version)}: failed · ${issues.map((i) => i.what ?? i.type.replace(/_/g, " ")).join("; ") || "no reason given"}`, p.pass ? "check" : "fail");
        break;
      }
      case "Suspended":
        if (p.kind === "human") add(e, key, "Waiting for you", "you");
        else if (p.kind === "model_job") add(e, key, "Waiting on the model", "info");
        else if (p.kind === "check_job") add(e, key, "Waiting on the judge", "info");
        else if (p.kind === "tool_job") add(e, key, "Waiting on the tool", "info");
        break;
      case "HumanDecision": {
        pressed = { seq: e.seq, key };
        const pick = (p.selection as string[] | undefined)?.length ? ` on ${(p.selection as string[]).join(", ")}` : "";
        add(e, key, `${p.by === "auto" ? "Pressed automatically" : "You pressed"} ${String(p.action)}${pick}${p.note ? ` · note:${quote(p.note)}` : ""}`, p.by === "auto" ? "auto" : "you");
        break;
      }
      case "Locked":
        add(e, key, `Locked ${opts.key && key !== opts.key ? `${nameOf(key)} ` : ""}${String(p.version)} ${p.by === "auto" ? "automatically" : "by you"}${p.why ? ` ·${quote(p.why)}` : ""}`, p.by === "auto" ? "auto" : "you");
        break;
      case "Unlocked":
        add(e, key, "Unlocked", "you");
        break;
      case "EdgeFollowed": {
        const from = String(p.from);
        const to = String(p.to);
        add(e, from, `→ ${to === "END" ? "finished this part" : `on to ${nameOf(to)}`}`, "info");
        break;
      }
      case "MapExpanded":
        add(e, key, `For each: ${(p.keys as string[]).length} items (${(p.keys as string[]).slice(0, 6).join(", ")}${(p.keys as string[]).length > 6 ? "…" : ""})`, "info");
        break;
      case "NodeBlocked":
        add(e, key, `Blocked: ${String(p.reason)}`, "fail");
        break;
      case "NodeFailed":
        add(e, key, `Failed: ${String(p.reason)}`, "fail");
        break;
      case "NodeCompleted":
        add(e, key, "Done", "info");
        break;
      case "MarkedStale":
        add(e, key, `Went stale: ${String(p.reason)}`, "fail");
        break;
      case "MarkedFresh":
        add(e, key, "Fresh again: its inputs match what it was made from", "info");
        break;
      case "StaleKept":
        add(e, key, `You kept ${String(p.version)} as it is${p.why ? ` ·${quote(p.why)}` : ""}`, "you");
        break;
      case "BranchCreated":
        add(e, key, `New branch '${String(p.branch)}' from ${String(p.from)}`, "you");
        break;
      case "BranchSwitched":
        add(e, key, `Switched to branch '${String(p.branch)}'`, "you");
        break;
      case "MentionAdded":
        add(e, key, `You added ${String(p.ref)}${p.note ? ` ·${quote(p.note)}` : ""}`, "you");
        break;
      case "AgentTurn":
        add(e, key, `Agent turn ${String(p.turn)} · ${String(p.model)}${money(p.cost_usd)}`, "model");
        break;
      case "ToolCalled":
        add(e, key, `Called ${String(p.tool)}`, "model");
        break;
      case "RunCompleted":
        if (!opts.key && !opts.under) lines.push({ seq: e.seq, at: e.at, key: "", text: `Run ${String(p.status)}`, tone: p.status === "completed" ? "info" : "fail" });
        break;
      case "RunReopened":
        if (!opts.key && !opts.under) lines.push({ seq: e.seq, at: e.at, key: "", text: `Run opened again: ${String(p.reason)}`, tone: "info" });
        break;
    }
  }
  return lines;
}

/** The recipe and key prefix for one for-each item of a run (`per_shot[P3-04]`), or the run's own recipe for "". */
export function scopeOf(graphs: Graph[], top: string, at: string): { graph: Graph | undefined; prefix: string } {
  let graph = findGraph(graphs, top);
  let prefix = "";
  for (const [, mapId, item] of at.matchAll(/(\w+)\[([^\]]+)\]/g)) {
    const map = graph?.nodes.find((n) => n.id === mapId);
    if (!map || map.kind !== "map") return { graph: undefined, prefix };
    prefix += `${mapId}[${item}].`;
    graph = findGraph(graphs, map.graph);
  }
  return { graph, prefix };
}

/** How many times each arrow of a recipe was followed in this scope, one count per arrow as `kriya web` draws them (an arrow from several steps is one per step). */
export function taken(followed: Record<string, number>, graph: Graph, prefix: string): number[] {
  return graph.edges.flatMap((e, i) => (Array.isArray(e.from) ? e.from : [e.from]).map(() => followed[`${prefix}${i}`] ?? 0));
}

/** The answer last given on each review screen: which button, and whether a person or the screen itself pressed it. */
export type Answer = { action: string; by: "human" | "auto" };

/**
 * One button press with what it was made on: the versions on the table with
 * their checks, what was picked and written, who pressed it, and what it led to
 * (the lock it made, the step the run went on to).
 */
export type DecisionTrace = {
  seq: number;
  at: string;
  key: string;
  step: string;
  /** The step whose versions it was made on: the one a screen shows, or the step itself. */
  reviews: string;
  action: string;
  by: "human" | "auto";
  selection: string[];
  note?: string;
  region?: string;
  on: { version: string; model?: string; costUsd?: number; check?: { by: string; pass: boolean; issues: string[] } }[];
  locked?: string;
  next?: string;
};

/** Every decision in a run, oldest first; with `under`, only those inside that for-each item. */
export function decisions(events: StoredEvent[], graphs: Graph[] = [], under = ""): DecisionTrace[] {
  const names = new Map(graphs.flatMap((g) => g.nodes.map((n) => [n.id, n.name ?? n.id] as const)));
  // What each screen reviews, from its recipe: `show: draw.image` reviews draw.
  const shows = new Map(graphs.flatMap((g) => g.nodes.flatMap((n) => (n.kind === "screen" && n.show ? [[n.id, n.show.split(/[.[@]/)[0]!] as const] : []))));
  const nameOf = (key: string) => (key === "END" ? "the end" : (names.get(key.slice(key.lastIndexOf(".") + 1)) ?? key));
  // What each review screen showed: the versions of the step it reviews, made since its last answer.
  const made = new Map<string, DecisionTrace["on"]>(); // by the reviewed step's key
  const out: DecisionTrace[] = [];
  let open: DecisionTrace | undefined;
  for (const e of events) {
    const p = e.payload as P & Record<string, unknown>;
    const key = p.node ?? "";
    if (e.type === "CandidateProduced") {
      const list = made.get(key) ?? [];
      list.push({ version: `${String(p.attempt)}.${String(p.candidate)}`, ...(p.model ? { model: String(p.model) } : {}), ...(typeof p.cost_usd === "number" ? { costUsd: p.cost_usd } : {}) });
      made.set(key, list);
    } else if (e.type === "VerdictRecorded") {
      const v = made.get(key)?.find((x) => x.version === p.version);
      const issues = ((p.issues as { type: string; what?: string }[] | undefined) ?? []).map((i) => i.what ?? i.type.replace(/_/g, " "));
      if (v) v.check = { by: String(p.by ?? "llm"), pass: Boolean(p.pass), issues };
    } else if (e.type === "HumanDecision") {
      const prefix = key.slice(0, key.lastIndexOf(".") + 1);
      // A screen reviews the step it shows; a step that asks you itself (a clip to approve) reviews its own versions.
      const reviewed = shows.get(key.slice(prefix.length));
      const target = reviewed ? `${prefix}${reviewed}` : key;
      open = {
        seq: e.seq,
        at: e.at,
        key,
        step: nameOf(key),
        reviews: target,
        action: String(p.action),
        by: p.by === "auto" ? "auto" : "human",
        selection: (p.selection as string[] | undefined) ?? [],
        ...(typeof p.note === "string" && p.note ? { note: p.note } : {}),
        ...(typeof p.region === "string" ? { region: p.region } : {}),
        on: target ? [...(made.get(target) ?? [])] : [],
      };
      if (key.startsWith(under)) out.push(open);
      if (target) made.delete(target); // the next review of it starts from what's made after this one
    } else if (open && e.type === "Locked" && e.seq - open.seq <= 3) {
      open.locked = `${nameOf(key)} ${String(p.version)}`;
    } else if (open && e.type === "EdgeFollowed" && p.from === open.key) {
      open.next = nameOf(String(p.to));
      open = undefined;
    }
  }
  return out;
}

/**
 * For `kriya web`: one step's lines (with `key`), how many times each arrow in the
 * scope `at` was taken, and each screen's last answer, all read from the events.
 */
export function traceView(events: StoredEvent[], graphs: Graph[], opts: { at?: string; key?: string; all?: boolean } = {}): { lines: TraceLine[]; taken: number[]; answers: Record<string, Answer>; decisions?: DecisionTrace[] } {
  const top = (events.find((e) => e.type === "RunStarted")?.payload as { graph?: string } | undefined)?.graph ?? "";
  const { graph, prefix } = scopeOf(graphs, top, opts.at ?? "");
  const followed: Record<string, number> = {};
  const answers: Record<string, Answer> = {};
  for (const e of events) {
    const p = e.payload as { edge?: string; node?: string; action?: string; by?: string };
    if (e.type === "EdgeFollowed" && p.edge) followed[p.edge] = (followed[p.edge] ?? 0) + 1;
    if (e.type === "HumanDecision" && p.node?.startsWith(prefix)) answers[p.node] = { action: p.action ?? "", by: p.by === "auto" ? "auto" : "human" };
  }
  // With `all`, the whole scope: every line and every decision in it (the run's overview in kriya web).
  const lines = opts.key ? trace(events, graphs, { key: opts.key }) : opts.all ? trace(events, graphs, prefix ? { under: prefix } : {}) : [];
  // A step's own decisions are the ones made on it or on its versions (a pick on a screen counts for the step it shows).
  const made = opts.all ? decisions(events, graphs, prefix) : opts.key ? decisions(events, graphs).filter((d) => d.key === opts.key || d.reviews === opts.key) : undefined;
  return { lines, taken: graph ? taken(followed, graph, prefix) : [], answers, ...(made ? { decisions: made } : {}) };
}
