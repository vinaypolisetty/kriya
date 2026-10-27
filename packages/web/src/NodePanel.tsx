/** One step of a run, beside the graph: its state, why, what it made, and a way in if it's waiting on you. */
import { useState } from "react";
import { branchOff, retry, switchBranch, type GNode, type GVersion } from "./api";
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
      {n.status === "failed" && <RetryButton run={run} n={n} />}
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

      {n.versions.length > 0 && <VersionTree n={n} run={run} latest={latest} />}
    </aside>
  );
}

/** Try a failed step again; a for-each step tries again every item that failed. */
function RetryButton({ run, n }: { run: string; n: GNode }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
  const failedItems = n.items?.filter((i) => i.status === "failed").length;
  return (
    <>
      <button
        type="button"
        className="primary"
        disabled={state === "sending" || state === "sent"}
        onClick={async () => {
          setState("sending");
          try {
            await retry(run, n.key);
            setState("sent");
          } catch (e) {
            setState(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        {state === "sent" ? "Trying again…" : failedItems ? `Try again: ${failedItems} failed item${failedItems === 1 ? "" : "s"}` : "Try again"}
      </button>
      {state !== "idle" && state !== "sending" && state !== "sent" && <p className="note fail">{state}</p>}
    </>
  );
}

/**
 * A step's versions as a tree (Day 26, D-71): one group per branch, each
 * version saying what it came from. Branch off from any version to try another
 * direction; switch to choose which branch the review shows and new versions
 * go on. Nothing is made until you press a button on the review.
 */
function VersionTree({ n, run, latest }: { n: GNode; run: string; latest: number }) {
  const [from, setFrom] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  // The branch you're on first; the rest in the order they were made.
  const branches = [...(n.branches ?? [{ name: "main" }])].sort((a, b) => Number(b.name === n.branch) - Number(a.name === n.branch));
  const send = async (f: () => Promise<unknown>) => {
    setSending(true);
    setError(undefined);
    try {
      await f();
      setFrom(undefined);
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  // "Darker Sky" → "darker-sky": branch names are lowercase words joined by dashes.
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

  return (
    <section>
      <h3>Versions</h3>
      {branches.length > 1 && <p className="muted small">The review shows the branch you're on; new versions go there too.</p>}
      {from && (
        <form
          className="branch-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (slug) void send(() => branchOff(run, n.key, slug, from));
          }}
        >
          <label>
            <span>New branch from {from}</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. darker sky" />
          </label>
          <div className="branch-buttons">
            <button type="submit" className="primary" disabled={!slug || sending}>{sending ? "…" : slug ? `Branch off as ${slug}` : "Branch off"}</button>
            <button type="button" onClick={() => (setFrom(undefined), setName(""))}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="note fail">{error}</p>}
      {branches.map((b) => {
        const here = n.versions.filter((v) => v.branch === b.name);
        const on = b.name === (n.branch ?? "main");
        return (
          <div key={b.name} className={on ? "branch on" : "branch"}>
            {branches.length > 1 && (
              <div className="branch-head">
                <b>{b.name}</b>
                {b.from && <span className="muted">from {b.from}</span>}
                {on ? <span className="pill tone-done">you're here</span> : <button type="button" className="link" disabled={sending} onClick={() => void send(() => switchBranch(run, n.key, b.name))}>Switch here</button>}
              </div>
            )}
            {here.length === 0 ? (
              <p className="muted small">Nothing made on {b.name} yet: the review starts from {b.from}. Edit it or try again there.</p>
            ) : (
              <div className="versions">
                {[...here].reverse().map((v) => (
                  <VersionCard key={v.id} v={v} n={n} older={Number(v.id.split(".")[0]) < latest} onBranch={() => (setFrom(v.id), setError(undefined))} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function VersionCard({ v, n, older, onBranch }: { v: GVersion; n: GNode; older: boolean; onBranch: () => void }) {
  return (
    <figure className={["version", v.verdict ? (v.verdict.pass ? "pass" : "fail") : "", v.id === n.locked?.version ? "locked" : "", older ? "older" : ""].join(" ")}>
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
      {(v.madeBy || v.instruction || v.parents.length > 0) && (
        <p className="why">
          {v.parents.length > 0 && <span className="muted">from {v.parents.join(" + ")} · </span>}
          {v.madeBy ? `by ${v.madeBy}` : v.parents.length ? "" : "again"}
          {v.instruction ? `: "${v.instruction}"` : ""}
        </p>
      )}
      <button type="button" className="link branch-off" onClick={onBranch}>Branch off</button>
    </figure>
  );
}
