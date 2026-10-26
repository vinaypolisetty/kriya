/** One step of a run, beside the graph: its state, why, what it made, and a way in if it's waiting on you. */
import type { GNode } from "./api";
import { statusOf } from "./Graph";

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

export function NodePanel({ n, run, onClose, onOpenItem }: { n: GNode; run: string; onClose: () => void; onOpenItem: (at: string) => void }) {
  const st = statusOf(n.status);
  const latest = Math.max(0, ...n.versions.map((v) => Number(v.id.split(".")[0])));
  return (
    <aside className="panel" aria-label={`Step ${n.name}`}>
      <div className="panel-head">
        <div>
          <span className="eyebrow">{n.detail}</span>
          <h2>{n.name}</h2>
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">×</button>
      </div>
      <p className={`pill tone-${st.tone}`}>{n.waitingOnYou ? "Waiting for you" : st.label}</p>
      {n.waitingOnYou && (
        <a className="button primary" href={`#/review/${encodeURIComponent(`${run}:${n.key}`)}`}>Review now</a>
      )}
      {n.failure && <p className="note fail">{n.failure}</p>}
      {n.blockedReason && <p className="note fail">{n.blockedReason}</p>}
      {n.staleReason && <p className="note">Stale: {n.staleReason}</p>}
      {n.locked && (
        <p className="note">
          Locked {n.locked.version}
          {n.locked.by === "auto" ? " automatically" : ""}
          {n.locked.why ? `: "${n.locked.why}"` : ""}
        </p>
      )}
      {n.costUsd > 0 && <p className="muted mono">Spent {usd(n.costUsd)}</p>}

      {n.items && (
        <section>
          <h3>Items</h3>
          <ul className="items">
            {n.items.map((i) => (
              <li key={i.key}>
                <button type="button" className="row" onClick={() => onOpenItem(i.key)}>
                  <span className={`dot tone-${statusOf(i.status).tone}`} aria-hidden="true" />
                  <span>{i.label}</span>
                  <span className="muted">{statusOf(i.status).label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {n.versions.length > 0 && (
        <section>
          <h3>Versions</h3>
          <div className="versions">
            {[...n.versions].reverse().map((v) => (
              <figure key={v.id} className={["version", v.verdict ? (v.verdict.pass ? "pass" : "fail") : "", v.id === n.locked?.version ? "locked" : "", Number(v.id.split(".")[0]) < latest ? "older" : ""].join(" ")}>
                {v.thumb?.type.startsWith("image/") ? (
                  <img src={v.thumb.url} alt={`version ${v.id}`} loading="lazy" />
                ) : v.thumb?.type.startsWith("audio/") ? (
                  <audio src={v.thumb.url} controls preload="none" />
                ) : v.thumb?.type.startsWith("video/") ? (
                  <video src={v.thumb.url} controls preload="metadata" />
                ) : null}
                <figcaption>
                  <b>{v.id}</b>
                  {v.id === n.locked?.version && <span className="lock">locked</span>}
                  {v.verdict && <span className={v.verdict.pass ? "ok" : "bad"}>{v.verdict.pass ? "✓" : `✗ ${v.verdict.issues.length}`}</span>}
                  {v.costUsd > 0 && <span className="mono muted">{usd(v.costUsd)}</span>}
                </figcaption>
                {(v.madeBy || v.instruction) && (
                  <p className="why">
                    {v.madeBy ? `by ${v.madeBy}` : "again"}
                    {v.instruction ? `: "${v.instruction}"` : ""}
                  </p>
                )}
              </figure>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
