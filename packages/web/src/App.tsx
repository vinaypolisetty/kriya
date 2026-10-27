/**
 * kriya in the browser. Home is a run as a live graph of its steps (Day 24,
 * D-67): runs on the left, the selected run's recipe in the middle, a step's
 * details on the right. "Waiting for you" opens the inbox; a waiting step
 * opens its review screen.
 *
 * Routes live in the hash: #/run/<id>[/<item>], #/inbox, #/review/<run>:<step>.
 */
import { useEffect, useState } from "react";
import { useLive, useLiveFlag, type Item, type Run, type RunGraph, type Shown } from "./api";
import { Graph, statusOf } from "./Graph";
import { NodePanel } from "./NodePanel";
import { Screen } from "./Screen";

type Route = { page: "run"; run?: string; at: string } | { page: "inbox" } | { page: "review"; id: string };

function parse(): Route {
  const [page, a = "", b = ""] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (page === "inbox") return { page: "inbox" };
  if (page === "review" && a) return { page: "review", id: a };
  return { page: "run", ...(page === "run" && a ? { run: a } : {}), at: b };
}
export const go = (path: string) => (location.hash = path);
const usd = (n: number) => `$${n.toFixed(2)}`;

export function App() {
  const [route, setRoute] = useState(parse);
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    const on = () => setRoute(parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const live = useLiveFlag();
  const runs = useLive<{ project: string; runs: Run[] }>("/api/runs");
  const waiting = runs.data?.runs.reduce((a, r) => a + r.waiting, 0) ?? 0;
  const spent = runs.data?.runs.reduce((a, r) => a + r.costUsd, 0) ?? 0;
  // With no run named, open the one that most needs you: waiting first, then the latest.
  const runId = route.page === "run" ? (route.run ?? runs.data?.runs.find((r) => r.waiting)?.id ?? runs.data?.runs[0]?.id) : undefined;

  return (
    <div className="app">
      <header className="top">
        <nav aria-label="Breadcrumb" className="crumbs">
          <a href="#/">kriya</a>
          <span aria-hidden="true">›</span>
          <span>{runs.data?.project ?? "…"}</span>
          {route.page === "run" && runId && (
            <>
              <span aria-hidden="true">›</span>
              <b>{runId}</b>
            </>
          )}
          {route.page === "inbox" && (
            <>
              <span aria-hidden="true">›</span>
              <b>Waiting for you</b>
            </>
          )}
        </nav>
        <div className="top-right">
          <span className="mono muted">Spent {usd(spent)}</span>
          <a className={waiting ? "waiting-chip" : "waiting-chip none"} href="#/inbox">
            {waiting ? `${waiting} waiting for you` : "Nothing waiting"}
          </a>
          <span className={live ? "live on" : "live"} title={live ? "Live: updates as runs change" : "Not connected to kriya web"}>{live ? "live" : "offline"}</span>
        </div>
      </header>
      {runs.error && <p className="error">{runs.error}</p>}
      {toast && <p className="toast" onAnimationEnd={() => setToast(undefined)}>✓ {toast}</p>}

      {route.page === "inbox" ? (
        <InboxPage />
      ) : route.page === "review" ? (
        <ReviewPage id={route.id} onDone={(m) => (setToast(m), history.back())} />
      ) : (
        <div className="home">
          <RunList runs={runs.data?.runs} current={runId} />
          {runId ? <RunView run={runId} at={route.at} /> : <p className="muted pad">No runs yet. Start one with <code>kriya run &lt;recipe&gt;</code>.</p>}
        </div>
      )}
    </div>
  );
}

function RunList({ runs, current }: { runs?: Run[]; current?: string }) {
  return (
    <nav className="runs" aria-label="Runs">
      <h2 className="eyebrow">Runs</h2>
      <ul>
        {runs?.map((r) => (
          <li key={r.id}>
            <a href={`#/run/${encodeURIComponent(r.id)}`} className={r.id === current ? "run current" : "run"} aria-current={r.id === current ? "page" : undefined}>
              <span className="run-name">{r.id}</span>
              <span className="run-meta">
                <span>{r.recipe}</span>
                {r.waiting > 0 ? <span className="tone-you">{r.waiting} waiting</span> : r.failed > 0 ? <span className="tone-fail">failed</span> : r.working ? <span className="tone-work">working…</span> : <span className={r.status === "completed" ? "tone-done" : ""}>{r.status === "completed" ? "done" : r.status}</span>}
                {r.stale > 0 && <span className="tone-stale">{r.stale} stale</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function RunView({ run, at }: { run: string; at: string }) {
  const g = useLive<RunGraph>(`/api/runs/${encodeURIComponent(run)}/graph${at ? `?at=${encodeURIComponent(at)}` : ""}`);
  const [selected, setSelected] = useState<string>();
  useEffect(() => setSelected(undefined), [run, at]);
  const openItem = (key: string) => go(`/run/${encodeURIComponent(run)}/${encodeURIComponent(key)}`);
  if (g.error) return <p className="error pad">{g.error}</p>;
  if (!g.data) return <p className="muted pad">Loading…</p>;
  const node = g.data.nodes.find((n) => n.id === selected);
  return (
    <section className="run-view">
      <div className="run-head">
        <nav className="trail" aria-label="Where in the run">
          {g.data.trail.map((t, i) => (
            <span key={t.at}>
              {i > 0 && <span aria-hidden="true"> › </span>}
              {i < g.data!.trail.length - 1 ? <a href={`#/run/${encodeURIComponent(run)}/${encodeURIComponent(t.at)}`}>{t.label}</a> : <b>{t.label}</b>}
            </span>
          ))}
        </nav>
        <span className="muted mono">{statusOf(g.data.status).label === "done" ? "finished" : g.data.status} · {usd(g.data.costUsd)}</span>
      </div>
      <div className="run-body">
        <Graph graph={g.data} {...(selected ? { selected } : {})} onSelect={setSelected} onOpenItem={openItem} />
        {node && <NodePanel n={node} run={run} onClose={() => setSelected(undefined)} onOpenItem={openItem} />}
      </div>
      <p className="key muted">White: AI step · Amber: you decide · Grey: tool · Dashed arrow: goes back, with a limit</p>
    </section>
  );
}

function InboxPage() {
  const inbox = useLive<{ items: Item[] }>("/api/inbox");
  if (inbox.error) return <p className="error pad">{inbox.error}</p>;
  if (!inbox.data) return <p className="muted pad">Loading…</p>;
  if (inbox.data.items.length === 0) return <p className="muted pad">Nothing is waiting on you.</p>;
  return (
    <ul className="inbox">
      {inbox.data.items.map((item) => (
        <li key={item.id}>
          <a className="card" href={`#/review/${encodeURIComponent(item.id)}`}>
            <span className="card-head">
              <span className="run-name">{item.run}</span>
              <b>{item.title}</b>
              {item.working && <span className="tone-work">working…</span>}
            </span>
            <span className="thumbs">
              {item.shows.map((s) => (
                <Thumb key={s.version} shown={s} />
              ))}
            </span>
            {item.suggested && (
              <span className="suggested" title={item.suggested.why}>
                Suggested: <b>{item.suggested.action}</b> · {item.suggested.why}
              </span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

function ReviewPage({ id, onDone }: { id: string; onDone: (m: string) => void }) {
  const inbox = useLive<{ items: Item[] }>("/api/inbox");
  const [failed, setFailed] = useState<string>();
  const item = inbox.data?.items.find((i) => i.id === id);
  if (failed) return <p className="error pad">{failed}</p>;
  if (!inbox.data) return <p className="muted pad">Loading…</p>;
  if (!item) return <p className="muted pad">This isn't waiting on you any more. <a href="#/inbox">See what is</a>.</p>;
  return <Screen key={item.id + item.shows.map((s) => s.version).join()} item={item} onBack={() => history.back()} onError={setFailed} onDone={onDone} />;
}

/** One candidate, small: its image (or a player, or the text), its version and its checks. */
export function Thumb({ shown }: { shown: Shown }) {
  const v = shown.verdict;
  return (
    <figure className={v ? (v.pass ? "thumb pass" : "thumb fail") : "thumb"}>
      <Media shown={shown} />
      <figcaption>
        <span>{shown.version}</span>
        {v && <span title={v.issues.map((i) => i.what ?? i.type).join("\n")}>{v.pass ? "✓" : `✗ ${v.issues.length}`}</span>}
      </figcaption>
    </figure>
  );
}

export function Media({ shown }: { shown: Shown }) {
  const m = shown.media;
  if (m?.type.startsWith("image/")) return <img src={m.url} alt={`version ${shown.version}`} loading="lazy" />;
  if (m?.type.startsWith("audio/")) return <audio src={m.url} controls preload="none" />;
  if (m?.type.startsWith("video/")) return <video src={m.url} controls preload="metadata" />;
  return <pre className="text">{typeof shown.value === "string" ? shown.value : JSON.stringify(shown.value, null, 2)}</pre>;
}
