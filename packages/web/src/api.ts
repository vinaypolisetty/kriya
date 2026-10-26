/** The API that `kriya web` serves (packages/cli/src/web.ts), and live views of it. */
import { useCallback, useEffect, useState } from "react";

export type Issue = { type: string; what?: string; where?: string; fix?: string; keep?: string };
export type Verdict = { pass: boolean; issues: Issue[] };
export type Media = { url: string; type: string };
export type Shown = { version: string; value: unknown; media?: Media; verdict?: Verdict };
export type Button = { id: string; label?: string; needs: ("selection" | "note" | "region")[]; locks: boolean; estimateUsd?: number };
export type Suggestion = { action: string; selection?: string[]; note?: string; region?: unknown; why: string };
export type Item = { id: string; run: string; key: string; title: string; review: string; buttons: Button[]; shows: Shown[]; beside: { ref: string; value: unknown }[]; suggested?: Suggestion; working: boolean; batch: string; item?: string };
export type Decision = { run: string; key: string; action: string; selection?: string[]; note?: string; region?: string };

export type Run = { id: string; recipe: string; status: string; waiting: number; working: boolean; stale: number; failed: number; costUsd: number; started?: string; updated?: string };
export type GVersion = { id: string; costUsd: number; thumb?: Media; verdict?: Verdict; madeBy?: string; instruction?: string; model?: string };
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
  locked?: { version: string; by: string; why?: string };
  failure?: string;
  staleReason?: string;
  blockedReason?: string;
  items?: { key: string; label: string; status: string }[];
};
export type GEdge = { from: string; to: string; label?: string; back?: boolean; limit?: number };
export type RunGraph = { run: string; recipe: string; at: string; trail: { label: string; at: string }[]; status: string; costUsd: number; inputs: Record<string, string>; nodes: GNode[]; edges: GEdge[] };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `the server said ${r.status}`);
  return body;
}

export const retry = (run: string, key: string) => call<{ ok: true }>("/api/retry", { method: "POST", body: JSON.stringify({ run, key }) });

export const decide = (d: Decision) => call<{ items: Item[] }>("/api/decide", { method: "POST", body: JSON.stringify(d) }).then((r) => r.items);

/** Whether the server's event stream is connected; every live view refetches when it says something changed. */
const listeners = new Set<() => void>();
let source: EventSource | undefined;
const liveState = { on: false, subs: new Set<(on: boolean) => void>() };
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource("/api/events");
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
