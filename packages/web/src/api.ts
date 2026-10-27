/** The inbox API that `kriya web` serves (packages/cli/src/web.ts), and a live view of it. */
import { useCallback, useEffect, useState } from "react";

export type Issue = { type: string; what?: string; where?: string; fix?: string; keep?: string };
export type Verdict = { pass: boolean; issues: Issue[] };
export type Shown = { version: string; value: unknown; media?: { url: string; type: string }; verdict?: Verdict };
export type Button = { id: string; label?: string; needs: ("selection" | "note" | "region")[]; locks: boolean };
export type Suggestion = { action: string; selection?: string[]; note?: string; region?: unknown; why: string };
export type Item = { id: string; run: string; key: string; title: string; review: string; buttons: Button[]; shows: Shown[]; suggested?: Suggestion; working: boolean };
export type Decision = { run: string; key: string; action: string; selection?: string[]; note?: string; region?: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `the server said ${r.status}`);
  return body;
}

export const decide = (d: Decision) => call<{ items: Item[] }>("/api/decide", { method: "POST", body: JSON.stringify(d) }).then((r) => r.items);

/** What's waiting on you, kept current: refetched whenever any run's log grows (server-sent events). */
export function useInbox() {
  const [project, setProject] = useState("");
  const [items, setItems] = useState<Item[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await call<{ project: string; items: Item[] }>("/api/inbox");
      setProject(r.project);
      setItems(r.items);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("changed", () => void refresh());
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    void refresh();
    return () => es.close();
  }, [refresh]);

  return { project, items, setItems, error, live, refresh };
}
