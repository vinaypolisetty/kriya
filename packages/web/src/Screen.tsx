/**
 * One screen from the inbox (Day 23): the candidates in a grid with what their
 * checks found, then the screen's own buttons. A pick-one screen is Lock /
 * Edit / Crop / Try again; the note goes into the edit's prompt.
 */
import { useState } from "react";
import { decide, type Button, type Item } from "./api";
import { Media } from "./App";

const LABELS: Record<string, string> = { lock: "Lock", edit: "Edit", crop: "Crop", retry: "Try again", approve: "Approve", redo: "Redo", fix: "Fix" };

export function Screen({ item, onDone, onError, onBack }: { item: Item; onDone: (message: string) => void; onError: (message: string) => void; onBack: () => void }) {
  const [picked, setPicked] = useState<string | undefined>(item.shows.length === 1 ? item.shows[0]!.version : undefined);
  const [note, setNote] = useState("");
  const [region, setRegion] = useState("");
  const [sending, setSending] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const missing = (b: Button) =>
    b.needs.filter((n) => (n === "selection" ? !picked : n === "note" ? !note.trim() : !region.trim()));

  const press = async (b: Button) => {
    setSending(b.id);
    setError(undefined);
    try {
      await decide({ run: item.run, key: item.key, action: b.id, ...(picked && b.needs.includes("selection") ? { selection: [picked] } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(region.trim() && b.needs.includes("region") ? { region: region.trim() } : {}) });
      onDone(`${LABELS[b.id] ?? b.id}${picked && b.needs.includes("selection") ? ` ${picked}` : ""} on ${item.key}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m);
      onError(m); // the screen may be gone by now (the inbox moved on); the app shows it too
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
    <div className="screen">
      <div className="screen-head">
        <button className="link" onClick={onBack}>← Inbox</button>
        <span className="run">{item.run}</span>
        <h2>{item.title}</h2>
        {item.working && <span className="badge">working…</span>}
      </div>

      <div className="grid">
        {item.shows.map((s) => {
          const v = s.verdict;
          return (
            <button key={s.version} className={["candidate", picked === s.version ? "picked" : "", v ? (v.pass ? "pass" : "fail") : ""].join(" ")} onClick={() => setPicked(s.version)} aria-pressed={picked === s.version}>
              <Media shown={s} />
              <div className="candidate-foot">
                <b>{s.version}</b>
                {v && <span className="verdict">{v.pass ? "✓ checks passed" : `✗ ${v.issues.length} issue${v.issues.length === 1 ? "" : "s"}`}</span>}
              </div>
              {v && !v.pass && (
                <ul className="issues">
                  {v.issues.map((i, n) => (
                    <li key={n}>
                      {i.what ?? i.type}
                      {i.where && <span className="muted"> · {i.where}</span>}
                      {i.fix && <span className="fix"> → {i.fix}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </button>
          );
        })}
      </div>

      {item.suggested && (
        <div className="suggestion">
          <span>
            Suggested: <b>{LABELS[item.suggested.action] ?? item.suggested.action}</b>
            {item.suggested.selection ? ` ${item.suggested.selection[0]}` : ""}
          </span>
          <button className="link" onClick={useSuggestion}>Use suggestion</button>
        </div>
      )}

      {item.buttons.some((b) => b.needs.includes("note")) && (
        <label className="field">
          <span>Note: what should change (it goes into the prompt for an edit or another try), or why you chose it (kept with a lock)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. add Bheem's red-and-white checked gamcha" />
        </label>
      )}
      {item.buttons.some((b) => b.needs.includes("region")) && (
        <label className="field">
          <span>Area to keep for a crop: x,y,w,h as fractions (0,0,0.8,1 drops the right fifth) or pixels</span>
          <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="0,0,0.8,1" />
        </label>
      )}

      <div className="buttons">
        {item.buttons.map((b) => {
          const need = missing(b);
          return (
            <button key={b.id} className={b.locks ? "primary" : ""} disabled={!!sending || item.working || need.length > 0} title={need.length ? `needs ${need.map((n) => (n === "selection" ? "a pick" : `a ${n}`)).join(" and ")}` : ""} onClick={() => void press(b)}>
              {sending === b.id ? "…" : `${LABELS[b.id] ?? b.label ?? b.id}${b.locks ? " 🔒" : ""}`}
            </button>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
