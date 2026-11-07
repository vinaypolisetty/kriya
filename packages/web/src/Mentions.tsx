/**
 * @ in a step's chat (D-96): type @ and pick what to point at (the Library,
 * someone or something in it, another step, a for-each item); the message
 * goes as plain words (`@Mitra`, `@shot_list v2`) and the server shows the chat
 * what each names. What's offered comes from the server, so what can be picked
 * is exactly what the chat understands.
 */
import { Fragment, useId, useRef, useState, type TextareaHTMLAttributes } from "react";
import { useLive } from "./api";

export type Ref = { ref: string; kind: "library" | "entity" | "step" | "item"; label: string };

/** What a message to this step can point at, kept current as the run moves. */
export function useRefs(run: string, key: string): Ref[] {
  return useLive<{ refs: Ref[] }>(run ? `/api/runs/${encodeURIComponent(run)}/refs?key=${encodeURIComponent(key)}` : undefined).data?.refs ?? [];
}

/** How many choices the list shows at once. */
const SHOWN = 8;

/** The @ being typed just before the cursor: where it starts and the words after it (names can have spaces). */
function typing(text: string, cursor: number): { start: number; query: string } | undefined {
  const m = /(^|[\s("'])@([^\n@]{0,40})$/.exec(text.slice(0, cursor));
  return m ? { start: m.index + m[1]!.length, query: m[2]! } : undefined;
}

/** The choices for what's typed: names that start with it first, then names or lines that contain it. */
function choices(refs: Ref[], query: string): Ref[] {
  const q = query.toLowerCase();
  const starts = refs.filter((r) => r.ref.toLowerCase().startsWith(q));
  const has = refs.filter((r) => !starts.includes(r) && (r.ref.toLowerCase().includes(q) || (!q.includes(" ") && r.label.toLowerCase().includes(q))));
  return [...starts, ...has].slice(0, SHOWN);
}

const KIND = { library: "Library", entity: "Library", step: "Step", item: "Item" } as const;

type BoxProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onChange: (text: string) => void; refs: Ref[] };

/** The chat's text box with an @ list: arrows to move, Enter or Tab to put it in, Esc to close. Everything else is the textarea's. */
export function MentionBox({ value, onChange, refs, onKeyDown, ...rest }: BoxProps) {
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useId();
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  // The @ that Esc closed: it stays closed until another @ is typed.
  const [closed, setClosed] = useState<number>();
  const at = typing(value, cursor);
  const shown = at && at.start !== closed && refs.length ? choices(refs, at.query) : [];
  const open = shown.length > 0;
  const pick = (r: Ref) => {
    if (!at) return;
    const before = `${value.slice(0, at.start)}@${r.ref} `;
    onChange(before + value.slice(cursor));
    setCursor(before.length);
    setActive(0);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(before.length, before.length);
    });
  };
  return (
    <div className="mention-box">
      {open && (
        <ul id={list} className="mentions" role="listbox" aria-label="Point at">
          {shown.map((r, i) => (
            <li
              key={`${r.kind}:${r.ref}`}
              id={`${list}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "on" : undefined}
              // Picked on press, before the box loses focus.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
            >
              <span className="mention-ref">@{r.ref}</span>
              <span className="mention-label">
                <span className="mention-kind">{KIND[r.kind]}</span> {r.label}
              </span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        {...rest}
        ref={box}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${list}-${Math.min(active, shown.length - 1)}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (open && !e.nativeEvent.isComposing) {
            const i = Math.min(active, shown.length - 1);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              return setActive((i + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              return pick(shown[i]!);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              return setClosed(at!.start);
            }
          }
          onKeyDown?.(e);
        }}
      />
    </div>
  );
}

/** A message with what it points at marked, `@Mitra` and `@shot_list v2`, so you can see it was understood. */
export function Said({ text, refs }: { text: string; refs: Ref[] }) {
  if (!refs.length || !text.includes("@")) return <>{text}</>;
  const names = [...refs].sort((a, b) => b.ref.length - a.ref.length).map((r) => r.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`((?<=^|[\\s("'])@(?:${names.join("|")})(?: v\\d+)?(?![\\p{L}\\p{N}_\\-[]))`, "giu"));
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <mark key={i} className="ref">{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}
