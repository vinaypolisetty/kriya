/** One step of a run, inside its box on the graph: its state, why, and what it made. */
import { useState } from "react";
import { branchOff, retry, switchBranch, useLive, type DecisionTrace, type GNode, type GVersion, type RunGraph, type TraceLine, type TraceView } from "./api";
import { statusOf } from "./Graph";

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

export function NodePanel({ n, run }: { n: GNode; run: string }) {
  const st = statusOf(n.status);
  const latest = Math.max(0, ...n.versions.map((v) => Number(v.id.split(".")[0])));
  return (
    <aside className="panel" aria-label={`Step ${n.name}`}>
      <p className={`pill tone-${st.tone}`}>{n.waitingOnYou ? "Waiting for you" : st.label}</p>
      {n.status === "failed" && n.failure && <p className="note fail">{n.failure}</p>}
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

      {n.versions.length > 0 && <VersionTree n={n} run={run} latest={latest} />}
      {run && <Happened run={run} n={n} />}
    </aside>
  );
}

const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * The run (or one for-each item) as a whole, on its Inputs box: what it was
 * started with, every decision with what it was made on, and everything that
 * happened. Before any run, only the inputs the recipe asks for.
 */
export function RunPanel({ graph }: { graph: RunGraph }) {
  const at = graph.at ? `&at=${encodeURIComponent(graph.at)}` : "";
  const t = useLive<TraceView>(graph.run ? `/api/runs/${encodeURIComponent(graph.run)}/trace?all=1${at}` : undefined).data;
  const names = [...new Set([...Object.keys(graph.inputs), ...Object.keys(graph.given ?? {})])];
  const decisions = [...(t?.decisions ?? [])].reverse();
  const title = graph.at ? graph.trail.at(-1)!.label : graph.run || graph.recipe;
  return (
    <aside className="panel" aria-label={`${title}: inputs, decisions and what happened`}>
      {graph.run && <p className="muted mono small">{graph.status} · spent {usd(graph.costUsd)}{decisions.length ? ` · ${decisions.length} decision${decisions.length === 1 ? "" : "s"}` : ""}</p>}

      <section>
        <h3>{graph.run ? "Started with" : "Asks for"}</h3>
        {names.length === 0 ? (
          <p className="muted small">No inputs.</p>
        ) : (
          <dl className="given">
            {names.map((k) => (
              <div key={k}>
                <dt>
                  {k} {graph.inputs[k] && <span className="muted mono small">{graph.inputs[k]}</span>}
                </dt>
                <dd>{graph.run ? <Value v={graph.given?.[k]} /> : <span className="muted small">Given when a run starts</span>}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {decisions.length > 0 && (
        <section>
          <h3>Decisions</h3>
          <ol className="decisions">
            {decisions.map((d) => (
              <Decision key={d.seq} d={d} />
            ))}
          </ol>
        </section>
      )}

      {t && t.lines.length > 0 && <Timeline lines={t.lines} />}
    </aside>
  );
}

/** An input's value as given: words as words, a record as its fields, a list as its entries. */
function Value({ v }: { v: unknown }) {
  if (v === undefined || v === null || v === "") return <span className="muted small">Not given</span>;
  if (typeof v === "string") return v.length > 160 || v.includes("\n") ? <pre className="text">{v}</pre> : <span>{v}</span>;
  if (typeof v !== "object") return <span className="mono">{String(v)}</span>;
  if (!Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== "object" || (Array.isArray(x) && x.every((y) => typeof y !== "object")))) {
    return (
      <dl className="fields">
        {Object.entries(v).map(([k, x]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{Array.isArray(x) ? (x.length ? x.join(", ") : <span className="muted">none</span>) : String(x)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <pre className="text">{JSON.stringify(v, null, 2)}</pre>;
}

/** One decision: who pressed what, on which versions and what their checks said, and where it went. */
function Decision({ d }: { d: DecisionTrace }) {
  const picked = new Set(d.selection);
  return (
    <li className={`decision tone-${d.by === "auto" ? "auto" : "you"}`}>
      <span className="card-head">
        <b>{d.step}</b>
        <time className="muted small" dateTime={d.at}>{when(d.at)}</time>
      </span>
      <span>
        {d.by === "auto" ? "Pressed automatically, following the checks: " : "You pressed "}
        <b>{d.action}</b>
        {d.selection.length > 0 && <> on {d.selection.join(", ")}</>}
      </span>
      {d.note && <q className="small">{d.note}</q>}
      {d.on.length > 0 && (
        <ul className="on">
          {d.on.map((v) => (
            <li key={v.version} className={picked.has(v.version) ? "picked" : ""}>
              <span className="mono">{v.version}</span>
              {v.check ? (
                <span className={v.check.pass ? "tone-done" : "tone-fail"}>{v.check.pass ? "✓ passed" : `✗ ${v.check.issues.join("; ") || "failed"}`}</span>
              ) : (
                <span className="muted">not checked</span>
              )}
              {v.model && <span className="muted small">{v.model}{v.costUsd ? ` · ${usd(v.costUsd)}` : ""}</span>}
            </li>
          ))}
        </ul>
      )}
      {(d.locked || d.next) && (
        <span className="muted small">
          → {[d.locked && `locked ${d.locked}`, d.next && `on to ${d.next}`].filter(Boolean).join(", ")}
        </span>
      )}
    </li>
  );
}

const KINDS = { all: "Everything", you: "Decisions", check: "Checks", model: "Made" } as const;

/** Every line of the run, newest first, narrowed to one kind if you like. */
function Timeline({ lines }: { lines: TraceLine[] }) {
  const [kind, setKind] = useState<keyof typeof KINDS>("all");
  const [all, setAll] = useState(false);
  const keep = (l: TraceLine) => kind === "all" || (kind === "you" ? l.tone === "you" || l.tone === "auto" : kind === "check" ? l.tone === "check" || l.tone === "fail" : l.tone === kind);
  const list = [...lines].reverse().filter(keep);
  const shown = all ? list : list.slice(0, 30);
  return (
    <section>
      <h3>What happened</h3>
      <span className="tabs small-tabs" role="tablist">
        {(Object.keys(KINDS) as (keyof typeof KINDS)[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
            {KINDS[k]}
          </button>
        ))}
      </span>
      <ol className="happened">
        {shown.map((l) => (
          <li key={l.seq} className={`tone-${l.tone}`}>
            <time dateTime={l.at}>{when(l.at)}</time>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
      {list.length > shown.length && (
        <button type="button" className="link" onClick={() => setAll(true)}>
          Show all {list.length}
        </button>
      )}
    </section>
  );
}

/** What happened at this step, newest first, from the run's event log: its decisions with what they were made on, then drafts, checks, who pressed what, locks (Day 36). */
function Happened({ run, n }: { run: string; n: GNode }) {
  const t = useLive<TraceView>(`/api/runs/${encodeURIComponent(run)}/trace?key=${encodeURIComponent(n.key)}`).data;
  const [all, setAll] = useState(false);
  if (!t || t.lines.length === 0) return null;
  const lines = [...t.lines].reverse();
  const shown = all ? lines : lines.slice(0, 12);
  const decisions = [...(t.decisions ?? [])].reverse();
  return (
    <>
    {decisions.length > 0 && (
      <section>
        <h3>Decisions</h3>
        <ol className="decisions">
          {decisions.map((d) => (
            <Decision key={d.seq} d={d} />
          ))}
        </ol>
      </section>
    )}
    <section>
      <h3>What happened</h3>
      <ol className="happened">
        {shown.map((l) => (
          <li key={l.seq} className={`tone-${l.tone}`}>
            <time dateTime={l.at}>{when(l.at)}</time>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
      {lines.length > shown.length && (
        <button type="button" className="link" onClick={() => setAll(true)}>
          Show all {lines.length}
        </button>
      )}
    </section>
    </>
  );
}

/**
 * Try a failed step again; a for-each step tries again every item that failed.
 * A model or agent step can be told what to change first (Q-24): the note is
 * its next instruction, and it can leave out inputs a provider keeps refusing.
 */
function RetryButton({ run, n }: { run: string; n: GNode }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
  const [note, setNote] = useState("");
  const [leaveOut, setLeaveOut] = useState<string[]>([]);
  const failedItems = n.items?.filter((i) => i.status === "failed").length;
  const canChange = n.leavable !== undefined;
  const changed = note.trim() !== "" || leaveOut.length > 0;
  const send = async () => {
    setState("sending");
    try {
      await retry(run, n.key, changed ? { ...(note.trim() ? { note: note.trim() } : {}), ...(leaveOut.length ? { leaveOut } : {}) } : {});
      setState("sent");
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <form
      className="retry-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {canChange && (
        <>
          <label>
            <span>Tell it what to change</span>
            <span className="muted small">How to do it, not what to say: the words come from the step before and stay the same.</span>
            <textarea
              value={note}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="e.g. say it softly, no shouting"
              disabled={state === "sent"}
            />
          </label>
          {n.leavable!.length > 0 && (
            <fieldset className="leave-out">
              <legend className="muted small">Leave out</legend>
              {n.leavable!.map((ref) => (
                <label key={ref} className="small">
                  <input
                    type="checkbox"
                    checked={leaveOut.includes(ref)}
                    disabled={state === "sent"}
                    onChange={(e) => setLeaveOut(e.target.checked ? [...leaveOut, ref] : leaveOut.filter((r) => r !== ref))}
                  />
                  <span className="mono">{ref}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      <button type="submit" className="primary" disabled={state === "sending" || state === "sent"}>
        {state === "sent" ? "Trying again…" : failedItems ? `Try again: ${failedItems} failed item${failedItems === 1 ? "" : "s"}` : changed ? "Try again with this change" : "Try again"}
      </button>
      {state !== "idle" && state !== "sending" && state !== "sent" && <p className="note fail">{state}</p>}
    </form>
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
