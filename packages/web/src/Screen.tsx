/**
 * A review, phone first (the mocks' Review inbox, D-68): one big preview, the
 * candidates as a row to pick from, what the checks found, a note, and the
 * screen's buttons in a footer you can reach with a thumb. Reviews of the same
 * step across shots are a batch: after each decision the next one opens.
 */
import { useState } from "react";
import { decide, type Button, type Item, type Media as File } from "./api";
import { Media } from "./App";
import { parseRegion, Region } from "./Region";

const LABELS: Record<string, string> = { lock: "Lock", edit: "Edit", crop: "Crop", retry: "Try again", approve: "Approve", redo: "Redo", fix: "Fix", reply: "Reply" };
const label = (b: Button) => LABELS[b.id] ?? b.label ?? b.id;
const cost = (b: Button) => (b.estimateUsd ? ` · ~$${b.estimateUsd.toFixed(2)}` : "");
/** `item.caption_en` → "caption en": the field, in words. */
const fieldName = (ref: string) => (ref.split(/[.@]/).pop() ?? ref).replace(/_/g, " ");

export function Screen({ item, batch, onDone, onError, onBack }: { item: Item; batch: Item[]; onDone: (message: string, next?: Item) => void; onError: (message: string) => void; onBack: () => void }) {
  const [picked, setPicked] = useState<string | undefined>(item.suggested?.selection?.[0] ?? (item.shows.length === 1 ? item.shows[0]!.version : undefined));
  const [note, setNote] = useState("");
  const [region, setRegion] = useState("");
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState<string>();

  const at = batch.findIndex((b) => b.id === item.id);
  const shown = item.shows.find((s) => s.version === picked) ?? item.shows[0];
  const lock = item.buttons.find((b) => b.locks);
  const others = item.buttons.filter((b) => b !== lock);
  const needsRegion = item.buttons.some((b) => b.needs.includes("region"));
  // An area can narrow an edit too ("only change inside it"), so it's offered wherever there's an image to mark.
  const marks = needsRegion || item.buttons.some((b) => b.id === "edit");
  const missing = (b: Button) => b.needs.filter((n) => (n === "selection" ? !picked : n === "note" ? !note.trim() : !region.trim()));

  const press = async (b: Button) => {
    setSending(b.id);
    setError(undefined);
    try {
      await decide({ run: item.run, key: item.key, action: b.id, ...(picked && b.needs.includes("selection") ? { selection: [picked] } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(region.trim() && (b.needs.includes("region") || b.id === "edit") ? { region: region.trim() } : {}) });
      const next = batch.slice(at + 1).find((x) => x.id !== item.id) ?? batch.slice(0, at).find((x) => x.id !== item.id);
      onDone(`${label(b)}${picked && b.needs.includes("selection") ? ` ${picked}` : ""} · ${item.item ?? item.key}`, next);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m);
      onError(m);
      setSending(undefined);
    }
  };

  const useSuggestion = () => {
    const s = item.suggested!;
    if (s.selection?.[0]) setPicked(s.selection[0]);
    setNote(s.note ?? "");
    setRegion(s.region === undefined ? "" : String(s.region));
  };

  return (
    <div className="review">
      <header className="review-head">
        <div className="review-nav">
          <button type="button" className="link" onClick={onBack}>‹ Back</button>
          {batch.length > 1 && <span className="muted">{`${item.item ? "Shot" : "Item"} ${at + 1} of ${batch.length} waiting`}</span>}
        </div>
        <h1>
          {item.item && <span className="mono muted">{item.item} · </span>}
          {item.title}
        </h1>
        {batch.length > 1 && (
          <div className="dots" aria-hidden="true">
            {batch.map((b, i) => (
              <span key={b.id} className={i === at ? "dot-on" : i < at ? "dot-done" : ""} />
            ))}
          </div>
        )}
        {item.working && <span className="tone-work">working…</span>}
        {item.branch && <span className="muted">On branch <b>{item.branch}</b>: only its versions are here. Switch in the run's step panel.</span>}
      </header>

      <main className="review-main">
        {shown && (
          <div className={["big", shown.verdict ? (shown.verdict.pass ? "pass" : "fail") : ""].join(" ")}>
            {marks && shown.media?.type.startsWith("image/") ? <Region src={shown.media.url} alt={`version ${shown.version}`} value={region} onChange={setRegion} /> : <Media shown={shown} />}
          </div>
        )}
        {marks && shown?.media?.type.startsWith("image/") && (
          <p className="hint">
            Drag on the picture to mark an area: what a crop keeps, or the only part an edit changes.
            {parseRegion(region) && (
              <>
                {" "}
                <button type="button" className="link" onClick={() => setRegion("")}>Clear</button>
              </>
            )}
          </p>
        )}

        {item.beside.length > 0 && (
          <dl className="beside">
            {besideGroups(item.beside).map((g) =>
              g.length > 1 ? (
                <Rows key={g[0]!.ref} lists={g} />
              ) : (
                <div key={g[0]!.ref}>
                  <dt>{fieldName(g[0]!.ref)}</dt>
                  <dd>{g[0]!.media ? <BesideMedia media={g[0]!.media} /> : show(g[0]!.value)}</dd>
                </div>
              ),
            )}
          </dl>
        )}

        {item.shows.length > 1 && (
          <div role="radiogroup" aria-label="Choose a version" className="options">
            {item.shows.map((s) => (
              <button key={s.version} type="button" role="radio" aria-checked={picked === s.version} className={["option", picked === s.version ? "on" : "", s.verdict ? (s.verdict.pass ? "pass" : "fail") : ""].join(" ")} onClick={() => setPicked(s.version)}>
                {s.media?.type.startsWith("image/") && <img src={s.media.url} alt="" />}
                <span>
                  {s.version} {s.verdict ? (s.verdict.pass ? "✓" : `✗${s.verdict.issues.length}`) : ""}
                </span>
              </button>
            ))}
          </div>
        )}

        {shown?.verdict && (
          <div className={shown.verdict.pass ? "checked ok" : "checked bad"}>
            {shown.verdict.pass ? (
              "✓ Pre-checked: passed every check"
            ) : (
              <ul>
                {shown.verdict.issues.map((i, n) => (
                  <li key={n}>
                    {i.what ?? i.type}
                    {i.where && <span className="muted"> · {i.where}</span>}
                    {i.fix && <span className="fix"> → {i.fix}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {item.suggested && (
          <div className="suggestion">
            <span>
              Suggested: <b>{LABELS[item.suggested.action] ?? item.suggested.action}</b>
              {item.suggested.selection ? ` ${item.suggested.selection[0]}` : ""}
            </span>
            <button type="button" className="link" onClick={useSuggestion}>Use it</button>
          </div>
        )}

        {item.buttons.some((b) => b.needs.includes("note")) && (
          <label className="field">
            <span>Note: what to change (for Edit or Try again), or why you chose it (kept with a lock)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. make the tanker bigger in the frame" />
          </label>
        )}
        {marks && (
          <label className="field">
            <span>Marked area, as x,y,w,h fractions of the picture (or drag on it above)</span>
            <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="0,0,0.8,1" inputMode="decimal" />
          </label>
        )}
        {error && <p className="error">{error}</p>}
      </main>

      <footer className="review-foot">
        {lock && (
          <button type="button" className="primary wide" disabled={!!sending || item.working || missing(lock).length > 0} onClick={() => void press(lock)}>
            {sending === lock.id ? "…" : `${label(lock)}${picked && lock.needs.includes("selection") ? ` ${picked}` : ""}${cost(lock)}`}
          </button>
        )}
        {others.length > 0 && (
          <div className="others">
            {others.map((b) => {
              const need = missing(b);
              return (
                <button key={b.id} type="button" disabled={!!sending || item.working || need.length > 0} title={need.length ? `needs ${need.map((n) => (n === "selection" ? "a pick" : `a ${n}`)).join(" and ")}` : ""} onClick={() => void press(b)}>
                  {sending === b.id ? "…" : `${label(b)}${cost(b)}`}
                </button>
              );
            })}
          </div>
        )}
      </footer>
    </div>
  );
}

/** Files beside a screen's candidates: a clip or sound plays, pictures sit in a strip in order, numbered from 0. */
function BesideMedia({ media }: { media: File[] }) {
  if (media.length === 1 && media[0]!.type.startsWith("video/")) return <video className="beside-video" src={media[0]!.url} controls playsInline />;
  if (media.length === 1 && media[0]!.type.startsWith("audio/")) return <audio src={media[0]!.url} controls />;
  return (
    <div className="beside-strip">
      {media.map((m, i) => (
        <figure key={i}>
          {m.type.startsWith("image/") ? <img src={m.url} alt={`${i}`} loading="lazy" /> : <a href={m.url}>{i}</a>}
          <figcaption>{i}</figcaption>
        </figure>
      ))}
    </div>
  );
}

type Beside = Item["beside"][number];
const show = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : JSON.stringify(v));

/** Lists of the same length next to each other belong together (frames, their times, what's in each): one group, shown as rows. */
function besideGroups(beside: Beside[]): Beside[][] {
  const groups: Beside[][] = [];
  for (const b of beside) {
    const last = groups.at(-1);
    const n = Array.isArray(b.value) ? b.value.length : -1;
    if (last && n > 1 && Array.isArray(last[0]!.value) && last[0]!.value.length === n) last.push(b);
    else groups.push([b]);
  }
  return groups;
}

/** Lists side by side as a table: row N holds item N of each (a picture where the list is pictures). */
function Rows({ lists }: { lists: Beside[] }) {
  const n = (lists[0]!.value as unknown[]).length;
  return (
    <div className="beside-rows">
      <table>
        <thead>
          <tr>{lists.map((l) => <th key={l.ref}>{fieldName(l.ref)}</th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: n }, (_, i) => (
            <tr key={i}>
              {lists.map((l) => {
                const m = l.media?.[i];
                return <td key={l.ref}>{m?.type.startsWith("image/") ? <img src={m.url} alt={`${i}`} loading="lazy" /> : show((l.value as unknown[])[i])}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
