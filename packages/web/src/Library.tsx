/**
 * The Library, read-only (Day 26): who's in it by kind, with each one's look
 * and which facets they have or still need; open one to see every facet's
 * current version and the versions before it. Editing stays in `library/`.
 */
import { useLive, type Entity, type Facet, type FacetFile, type LibraryView } from "./api";

const isFile = (v: unknown): v is FacetFile => !!v && typeof v === "object" && "file" in v;
const when = (at: string) => at.slice(0, 10);

/** The first picture an entity has: its look's image, if it's there. */
function picture(e: Entity): FacetFile | undefined {
  for (const f of e.facets) {
    const files = isFile(f.value) ? [f.value] : f.value && typeof f.value === "object" ? Object.values(f.value).filter(isFile) : [];
    const img = files.find((x) => x.type?.startsWith("image/"));
    if (img) return img;
  }
  return undefined;
}

export function LibraryPage({ name }: { name?: string }) {
  const lib = useLive<LibraryView>("/api/library");
  if (lib.error) return <p className="error pad">{lib.error}</p>;
  if (!lib.data) return <p className="muted pad">Loading…</p>;
  if (name) {
    const e = lib.data.entities.find((x) => x.name === name);
    return e ? <EntityPage e={e} /> : <p className="muted pad">There's no {name} in the Library. <a href="#/library">See who is</a>.</p>;
  }
  if (lib.data.entities.length === 0) {
    return <p className="muted pad">The Library is empty. Add one file per character, place or track to <code>library/</code>, e.g. <code>library/mitra.yaml</code>.</p>;
  }
  const groups = new Map<string, Entity[]>();
  for (const e of lib.data.entities) groups.set(e.kind ?? "other", [...(groups.get(e.kind ?? "other") ?? []), e]);
  return (
    <div className="library">
      {[...groups].map(([kind, es]) => (
        <section key={kind}>
          <h2>{kind} <span className="muted mono">{es.length}</span></h2>
          <div className="entities">
            {es.map((e) => {
              const pic = picture(e);
              return (
                <a key={e.name} className="entity" href={`#/library/${encodeURIComponent(e.name)}`}>
                  <span className="entity-pic">{pic ? <img src={pic.url} alt="" loading="lazy" /> : e.name.slice(0, 1)}</span>
                  <span className="entity-body">
                    <b>{e.name}</b>
                    <span className="facet-chips">
                      {e.facets.map((f) => (
                        <span key={f.facet} className={f.missing ? "chip missing" : "chip"} title={f.missing ? `${f.missing.join(", ")} isn't there` : `version ${f.n}`}>
                          {f.facet}{f.missing ? " ✗" : f.n && f.n > 1 ? ` v${f.n}` : ""}
                        </span>
                      ))}
                      {e.needs.map((n) => (
                        <span key={n} className="chip needs" title="this kind has it, and this one doesn't yet">needs {n}</span>
                      ))}
                    </span>
                  </span>
                </a>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function EntityPage({ e }: { e: Entity }) {
  return (
    <div className="entity-page">
      <a href="#/library">‹ Library</a>
      <div>
        <h1>{e.name}</h1>
        <p className="muted">{e.kind ?? "no kind"} · <span className="mono">{e.file}</span></p>
      </div>
      {e.needs.length > 0 && <p className="note">Still needs: {e.needs.join(", ")}. Add {e.needs.length === 1 ? "it" : "them"} to {e.file}.</p>}
      {e.facets.map((f) => (
        <FacetCard key={f.facet} f={f} />
      ))}
      <p className="muted small">Read-only: edit {e.file} to change {e.name}. A change is a new version; the old ones stay here.</p>
    </div>
  );
}

function FacetCard({ f }: { f: Facet }) {
  return (
    <section className="facet">
      <h2>
        {f.facet}
        {f.n && <span className="muted mono">v{f.n}</span>}
      </h2>
      {f.missing && <p className="note fail">{f.missing.join(", ")} isn't in the project, so steps that need it wait.</p>}
      <div className="facet-value"><Value v={f.value} /></div>
      {f.history.length > 1 && (
        <details>
          <summary className="muted">Earlier versions ({f.history.length - 1})</summary>
          <ul className="history">
            {f.history.filter((h) => !h.current).map((h) => (
              <li key={h.n}>
                <b>v{h.n}</b>
                <span>{when(h.at)}</span>
                <span className="text">{brief(h.value)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** A facet's value: words as words, files as pictures or players, objects one line per key. */
function Value({ v }: { v: unknown }) {
  if (isFile(v)) {
    if (v.missing || !v.url) return <span className="tone-fail mono">{v.file} (missing)</span>;
    if (v.type?.startsWith("image/")) return <img src={v.url} alt={v.file} loading="lazy" />;
    if (v.type?.startsWith("audio/")) return <audio src={v.url} controls preload="none" />;
    if (v.type?.startsWith("video/")) return <video src={v.url} controls preload="metadata" />;
    return <span className="mono">{v.file}</span>;
  }
  if (Array.isArray(v)) return <>{v.map((x, i) => <Value key={i} v={x} />)}</>;
  if (v && typeof v === "object") {
    return (
      <>
        {Object.entries(v).map(([k, x]) => (
          <div key={k}>
            <span className="eyebrow">{k}</span>
            <div><Value v={x} /></div>
          </div>
        ))}
      </>
    );
  }
  return <span>{String(v)}</span>;
}

/** An old version in one line: its words, or the file it named. */
function brief(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`).join(" · ");
  return JSON.stringify(v);
}
