import { useEffect, useState } from "react";
import { useInbox, type Item, type Shown } from "./api";
import { Screen } from "./Screen";

/** The open screen lives in the URL (`#run:step`), so back works and a link opens it. */
const openId = () => decodeURIComponent(location.hash.slice(1));

export function App() {
  const { project, items, error, live } = useInbox();
  const [open, setOpen] = useState(openId);
  const [toast, setToast] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  useEffect(() => {
    const on = () => setOpen(openId());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (id: string) => (location.hash = id ? encodeURIComponent(id) : "");
  const item = items?.find((i) => i.id === open);
  return (
    <div className="app">
      <header>
        <h1>
          kriya <span className="project">{project}</span>
        </h1>
        <span className={live ? "live on" : "live"} title={live ? "Live: updates as runs change" : "Not connected to kriya web"}>
          {live ? "live" : "offline"}
        </span>
      </header>
      {(error ?? failed) && <p className="error">{error ?? failed}</p>}
      {toast && <p className="toast" onAnimationEnd={() => setToast(undefined)}>✓ {toast}</p>}
      {item ? (
        <Screen key={item.id + item.shows.map((s) => s.version).join()} item={item} onBack={() => go("")} onError={setFailed} onDone={(m) => (setFailed(undefined), setToast(m), go(""))} />
      ) : items === undefined ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <Empty />
      ) : (
        <Inbox items={items} onOpen={go} />
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <p>Nothing is waiting on you.</p>
      <p className="muted">Start a run with <code>kriya run &lt;recipe&gt;</code>; its screens show up here as they're reached.</p>
    </div>
  );
}

function Inbox({ items, onOpen }: { items: Item[]; onOpen: (id: string) => void }) {
  return (
    <ul className="inbox">
      {items.map((item) => (
        <li key={item.id} className="card" role="button" tabIndex={0} onClick={() => onOpen(item.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(item.id)}>
          <div className="card-head">
            <span className="run">{item.run}</span>
            <span className="title">{item.title}</span>
            {item.working && <span className="badge">working…</span>}
          </div>
          <div className="thumbs">
            {item.shows.map((s) => (
              <Thumb key={s.version} shown={s} />
            ))}
          </div>
          {item.suggested && (
            <p className="suggested" title={item.suggested.why}>
              Suggested: <b>{item.suggested.action}</b> · {item.suggested.why}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
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
