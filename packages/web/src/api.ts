/** The API that `kriya web` serves (packages/cli/src/web.ts), and live views of it. */
import { useCallback, useEffect, useState } from "react";

export type Issue = { type: string; what?: string; where?: string; fix?: string; keep?: string };
export type Verdict = { pass: boolean; issues: Issue[] };
export type Media = { url: string; type: string };
export type Shown = { version: string; value: unknown; media?: Media; verdict?: Verdict };
export type Button = { id: string; label?: string; needs: ("selection" | "note" | "region")[]; locks: boolean; estimateUsd?: number };
export type Suggestion = { action: string; selection?: string[]; note?: string; region?: unknown; why: string };
export type Item = { id: string; run: string; key: string; title: string; review: string; buttons: Button[]; shows: Shown[]; beside: { ref: string; value: unknown; media?: Media[] }[]; suggested?: Suggestion; working: boolean; batch: string; item?: string; branch?: string };
export type Decision = { run: string; key: string; action: string; selection?: string[]; note?: string; region?: string };

export type Run = { id: string; recipe: string; status: string; waiting: number; working: boolean; stale: number; failed: number; costUsd: number; started?: string; updated?: string };
export type GVersion = { id: string; costUsd: number; branch: string; parents: string[]; thumb?: Media; verdict?: Verdict; madeBy?: string; instruction?: string; model?: string };
export type GNode = {
  id: string;
  key: string;
  kind: "model" | "agent" | "tool" | "screen" | "map" | "subgraph";
  name: string;
  detail: string;
  status: string;
  waitingOnYou: boolean;
  costUsd: number;
  versions: GVersion[];
  /** The branch new versions go on, and every branch with the version it started from (D-71). */
  branch?: string;
  branches?: { name: string; from?: string }[];
  locked?: { version: string; by: string; why?: string };
  failure?: string;
  /** A failed step's inputs it can try again without (Q-24): an emotion, a facet, a style. */
  leavable?: string[];
  staleReason?: string;
  blockedReason?: string;
  /** A for-each step's items, each with its own steps (keys like `per_shot[P3-04].pick`) and a picture of what it made. */
  items?: { key: string; label: string; status: string; steps?: { key: string; name: string; status: string; waitingOnYou: boolean }[]; thumb?: Media }[];
};
export type GEdge = { from: string; to: string; label?: string; back?: boolean; limit?: number };
/** `inputs` are the types the recipe asks for; `given` is what this run (or item) was started with, absent before any run. */
export type RunGraph = { run: string; recipe: string; at: string; trail: { label: string; at: string }[]; status: string; costUsd: number; inputs: Record<string, string>; given?: Record<string, unknown>; nodes: GNode[]; edges: GEdge[] };

/**
 * Where this page's project is served: `/` when kriya web runs in a project, `/p/<folder>/` when it runs
 * in a folder of projects. Every `/api/…` path goes there; media URLs stay as they are (any project serves its own).
 */
export const BASE = /^\/p\/[^/]+\//.exec(location.pathname)?.[0] ?? "/";
const at = (path: string) => (path.startsWith("/api/") ? `${BASE}${path.slice(1)}` : path);

/** A project in the folder kriya web was started in: what its card on home shows. */
export type ProjectCard = { folder: string; name: string; recipes: { graph: string; description: string }[]; runs: number; waiting: number; problems: number };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(at(path), init);
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `the server said ${r.status}`);
  return body;
}

/** A facet value as the server sends it: words, or a file (as media, or missing), or an object of those. */
export type FacetFile = { file: string; url?: string; type?: string; missing?: true };
export type Facet = { facet: string; value: unknown; n?: number; missing?: string[]; history: { n: number; at: string; value: unknown; current: boolean }[] };
export type Entity = { name: string; kind?: string; file: string; needs: string[]; facets: Facet[] };
export type LibraryView = { project: string; kinds: Record<string, string[]>; entities: Entity[] };

/** A recipe file as written, when it was made, the graph it defines (when it parses) and its problems. */
export type Recipe = { file: string; text: string; created: string; graph?: string; level?: string; description?: string; top?: boolean; steps?: number; problems: { line: number; message: string; severity: string }[] };

export const branchOff = (run: string, key: string, name: string, from: string) => call<{ ok: true }>("/api/branch", { method: "POST", body: JSON.stringify({ run, key, name, from }) });
export const switchBranch = (run: string, key: string, branch: string) => call<{ ok: true }>("/api/switch", { method: "POST", body: JSON.stringify({ run, key, branch }) });

export const retry = (run: string, key: string, change: { note?: string; leaveOut?: string[] } = {}) => call<{ ok: true }>("/api/retry", { method: "POST", body: JSON.stringify({ run, key, ...change }) });

/** A suggestion from the knowledge base: this keeps failing at a step; these words in its prompt would prevent it (D-76). */
export type Tip = { id: string; rule: string; step: string; hits: number; symptom: string; prevent: string };
export type Tips = { tips: Tip[]; applied: { rule: string; step: string }[] };
export const answerTip = (id: string, answer: "apply" | "dismiss") => call<Tips>("/api/tips", { method: "POST", body: JSON.stringify({ id, answer }) });

/** What happened in a run, from its event log (Day 36): one step's lines, how often each arrow was taken, each review's last answer. */
export type TraceLine = { seq: number; at: string; key: string; text: string; tone: "you" | "auto" | "model" | "check" | "fail" | "info" };
/** One button press with what it was made on: the versions on the table and their checks, and what it led to. */
export type DecisionTrace = {
  seq: number;
  at: string;
  key: string;
  step: string;
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
export type TraceView = { lines: TraceLine[]; taken: number[]; answers: Record<string, { action: string; by: "human" | "auto" }>; decisions?: DecisionTrace[] };

export const decide = (d: Decision) => call<{ items: Item[] }>("/api/decide", { method: "POST", body: JSON.stringify(d) }).then((r) => r.items);

/** Whether the server's event stream is connected; every live view refetches when it says something changed. */
const listeners = new Set<() => void>();
let source: EventSource | undefined;
const liveState = { on: false, subs: new Set<(on: boolean) => void>() };
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource(at("/api/events"));
    source.addEventListener("changed", () => listeners.forEach((l) => l()));
    source.onopen = () => (liveState.on = true, liveState.subs.forEach((s) => s(true)));
    source.onerror = () => (liveState.on = false, liveState.subs.forEach((s) => s(false)));
  }
  return () => listeners.delete(fn);
}

export function useLiveFlag(): boolean {
  const [on, setOn] = useState(liveState.on);
  useEffect(() => {
    liveState.subs.add(setOn);
    return () => void liveState.subs.delete(setOn);
  }, []);
  return on;
}

/** A GET that stays current: fetched now, and again whenever any run changes. */
export function useLive<T>(path: string | undefined): { data?: T; error?: string } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await call<T>(path));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path]);
  useEffect(() => {
    setData(undefined);
    void load();
    return subscribe(() => void load());
  }, [load]);
  return { ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) };
}
