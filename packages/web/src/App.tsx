/**
 * kriya in the browser. Home is the project's recipes, one card each in the
 * order the files were made; recipes that only run inside another sit folded
 * underneath. A recipe opens on its runs, with its graph and YAML one tab
 * over. A run opens as a live graph of its steps (Day 24, D-67): the recipe's
 * other runs on the left, the graph in the middle, a step's details on the
 * right. A for-each step opens in place, its items' steps a click away; an
 * item's own graph opens over the run. "Waiting for you" opens the inbox; a
 * waiting step opens its review screen.
 *
 * Routes live in the hash: #/, #/recipe/<file>, #/run/<id>[/<item>],
 * #/inbox, #/review/<run>:<step>, #/library[/<name>].
 *
 * Started in a folder of projects, home is a card per project; each opens at
 * /p/<folder>/, and everything above happens inside it.
 */
import { useEffect, useState } from "react";
import { answerTip, BASE, useLive, useLiveFlag, type Item, type ProjectCard, type Run, type RunGraph, type Recipe, type Shown, type Tips } from "./api";
import { Graph, START, statusOf } from "./Graph";
import { LibraryPage } from "./Library";
import { NodePanel, RunPanel } from "./NodePanel";
import { Screen } from "./Screen";

type Route = { page: "project" } | { page: "recipe"; file: string } | { page: "run"; run?: string; at: string } | { page: "inbox" } | { page: "review"; id: string } | { page: "library"; name?: string };

function parse(): Route {
  const [page, a = "", b = ""] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (!page) return { page: "project" };
  // A recipe file can sit in a subfolder: everything after #/recipe/ is its path.
  if (page === "recipe" && a) return { page: "recipe", file: location.hash.replace(/^#\/?recipe\//, "").split("/").map(decodeURIComponent).join("/") };
  if (page === "inbox") return { page: "inbox" };
  if (page === "library") return { page: "library", ...(a ? { name: a } : {}) };
  if (page === "review" && a) return { page: "review", id: a };
  return { page: "run", ...(page === "run" && a ? { run: a } : {}), at: b };
}
export const go = (path: string) => (location.hash = path);
const usd = (n: number) => `$${n.toFixed(2)}`;
/** When something last happened, the way you'd say it: "5m ago", "2h ago", "Oct 26". */
function ago(iso?: string): string {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function App() {
  const [route, setRoute] = useState(parse);
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    const on = () => setRoute(parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const live = useLiveFlag();
  // At the top of a folder of projects there's no project yet: home is the projects to pick from.
  const projects = useLive<{ folder: string; projects: ProjectCard[] }>(BASE === "/" ? "/api/projects" : undefined);
  const runs = useLive<{ project: string; runs: Run[] }>("/api/runs");
  const waiting = runs.data?.runs.reduce((a, r) => a + r.waiting, 0) ?? 0;
  const spent = runs.data?.runs.reduce((a, r) => a + r.costUsd, 0) ?? 0;
  const recipes = useLive<{ project: string; recipes: Recipe[] }>("/api/recipes");
  const runId = route.page === "run" ? route.run : undefined;
  // The recipe a page is under, for the breadcrumb: the run's, or the one open.
  const graphId = runId ? runs.data?.runs.find((r) => r.id === runId)?.recipe : undefined;
  const recipe = recipes.data?.recipes.find((x) => (route.page === "recipe" ? x.file === route.file : graphId !== undefined && x.graph === graphId));
  if (projects.data) return <ProjectsHome folder={projects.data.folder} projects={projects.data.projects} />;

  return (
    <div className="app">
      <header className="top">
        <nav aria-label="Breadcrumb" className="crumbs">
          <a href={BASE === "/" ? "#/" : "/"}>kriya</a>
          <span aria-hidden="true">›</span>
          {route.page === "project" ? <b>{runs.data?.project ?? "…"}</b> : <a href="#/">{runs.data?.project ?? "…"}</a>}
          {route.page === "run" && runId && (
            <>
              <span aria-hidden="true">›</span>
              {recipe ? <a href={recipeHref(recipe.file)}>{recipe.graph}</a> : <span>{graphId ?? "…"}</span>}
              <span aria-hidden="true">›</span>
              <b>{runId}</b>
            </>
          )}
          {route.page === "recipe" && (
            <>
              <span aria-hidden="true">›</span>
              <b>{recipe?.graph ?? route.file}</b>
            </>
          )}
          {route.page === "library" && (
            <>
              <span aria-hidden="true">›</span>
              {route.name ? <a href="#/library">Library</a> : <b>Library</b>}
              {route.name && (
                <>
                  <span aria-hidden="true">›</span>
                  <b>{route.name}</b>
                </>
              )}
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
          <a className={route.page === "library" ? "nav-link on" : "nav-link"} href="#/library">Library</a>
          <span className="mono muted spent">Spent {usd(spent)}</span>
          <a className={waiting ? "waiting-chip" : "waiting-chip none"} href="#/inbox">
            {waiting ? `${waiting} waiting for you` : "Nothing waiting"}
          </a>
          <span className={live ? "live on" : "live"} title={live ? "Live: updates as runs change" : "Not connected to kriya web"}>{live ? "live" : "offline"}</span>
        </div>
      </header>
      {runs.error && <p className="error">{runs.error}</p>}
      {toast && <p className="toast" onAnimationEnd={() => setToast(undefined)}>✓ {toast}</p>}

      {route.page === "library" ? (
        <LibraryPage {...(route.name ? { name: route.name } : {})} />
      ) : route.page === "inbox" ? (
        <InboxPage />
      ) : route.page === "review" ? (
        <ReviewPage id={route.id} onToast={setToast} />
      ) : recipes.error ? (
        <p className="error pad">{recipes.error}</p>
      ) : route.page === "recipe" ? (
        <RecipeView file={route.file} recipes={recipes.data?.recipes} runs={runs.data?.runs} />
      ) : runId ? (
        <div className="home">
          <SiblingRuns recipe={recipe} graph={graphId} runs={runs.data?.runs} current={runId} />
          <RunView run={runId} at="" />
          {route.page === "run" && route.at && <ItemModal run={runId} at={route.at} />}
        </div>
      ) : (
        <ProjectHome recipes={recipes.data?.recipes} runs={runs.data?.runs} />
      )}
    </div>
  );
}

const recipeHref = (file: string) => `#/recipe/${file.split("/").map(encodeURIComponent).join("/")}`;
const errorsIn = (x: Recipe) => x.problems.filter((p) => p.severity === "error");

/** One run as a line: its name, what it needs from you, when it last moved. */
function RunLine({ r, current }: { r: Run; current?: string }) {
  return (
    <a href={`#/run/${encodeURIComponent(r.id)}`} className={r.id === current ? "run current" : "run"} aria-current={r.id === current ? "page" : undefined}>
      <span className="run-name">{r.id}</span>
      <span className="run-meta">
        {r.waiting > 0 ? <span className="tone-you">{r.waiting} waiting for you</span> : r.failed > 0 ? <span className="tone-fail">failed</span> : r.working ? <span className="tone-work">working…</span> : <span className={r.status === "completed" ? "tone-done" : ""}>{r.status === "completed" ? "done" : r.status}</span>}
        {r.stale > 0 && <span className="tone-stale">{r.stale} stale</span>}
        {r.costUsd > 0 && <span className="mono">{usd(r.costUsd)}</span>}
        {r.updated && <span>{ago(r.updated)}</span>}
      </span>
    </a>
  );
}

/** Home in a folder of projects: a card per project, each opening that project's recipes. */
function ProjectsHome({ folder, projects }: { folder: string; projects: ProjectCard[] }) {
  return (
    <div className="app">
      <header className="top">
        <nav aria-label="Breadcrumb" className="crumbs">
          <b>kriya</b>
          <span aria-hidden="true">›</span>
          <span className="mono muted">{folder}</span>
        </nav>
      </header>
      <main className="project-home">
        <h2>Projects</h2>
        {projects.length === 0 && <p className="muted">No projects here yet. Start one with <code>kriya init &lt;folder&gt; --example &lt;name&gt;</code>.</p>}
        <ul className="recipe-grid">
          {projects.map((p) => (
            <li key={p.folder}>
              <a href={`/p/${encodeURIComponent(p.folder)}/#/`} className={p.problems ? "recipe-card broken" : p.waiting ? "recipe-card wants-you" : "recipe-card"}>
                <span className="eyebrow">project</span>
                <b className="recipe-title">{p.name}</b>
                <span className="muted small">
                  {p.recipes.length ? p.recipes.map((r) => r.graph).join(" · ") : "no recipes yet"}
                </span>
                {p.recipes[0]?.description && <span className="muted small recipe-desc">{p.recipes[0].description}</span>}
                {p.problems > 0 ? (
                  <span className="tone-fail small">{p.problems} problem{p.problems === 1 ? "" : "s"} in its recipes</span>
                ) : (
                  <span className="run-meta">
                    <span>{p.runs ? `${p.runs} run${p.runs === 1 ? "" : "s"}` : "no runs yet"}</span>
                    {p.waiting > 0 && <span className="tone-you">{p.waiting} waiting for you</span>}
                    <span className="mono">{p.folder}/</span>
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

/** Home: a card per recipe you start from, in the order the files were made; the ones that only run inside another, folded. */
function ProjectHome({ recipes, runs }: { recipes?: Recipe[]; runs?: Run[] }) {
  if (!recipes) return <p className="muted pad">Loading…</p>;
  // A file that doesn't parse has no graph to be inside anything, so it's a card: it's the one you most need to see.
  const cards = recipes.filter((x) => x.top || !x.graph);
  const inside = recipes.filter((x) => x.graph && !x.top);
  return (
    <main className="project-home">
      <h2>Recipes</h2>
      {cards.length === 0 && <p className="muted">No recipes yet. Put one in <code>recipes/</code>, or start from an example with <code>kriya init</code>.</p>}
      <ul className="recipe-grid">
        {cards.map((x) => (
          <li key={x.file}>
            <RecipeCard x={x} {...(runs ? { runs: runs.filter((r) => r.recipe === x.graph) } : {})} />
          </li>
        ))}
      </ul>
      {inside.length > 0 && (
        <details className="inside-row">
          <summary>Inside other recipes ({inside.length})</summary>
          <span className="inside-links">
            {inside.map((x) => (
              <a key={x.file} href={recipeHref(x.file)}>{x.graph}</a>
            ))}
          </span>
        </details>
      )}
    </main>
  );
}

/** One recipe you start from. Its runs are left out while they can't be read (a broken file elsewhere stops them), rather than shown as none. */
function RecipeCard({ x, runs }: { x: Recipe; runs?: Run[] }) {
  const errors = errorsIn(x);
  const waiting = runs?.reduce((a, r) => a + r.waiting, 0) ?? 0;
  const cost = runs?.reduce((a, r) => a + r.costUsd, 0) ?? 0;
  return (
    <a href={recipeHref(x.file)} className={errors.length ? "recipe-card broken" : waiting ? "recipe-card wants-you" : "recipe-card"}>
      <span className="eyebrow">{x.level ?? "recipe"}</span>
      <b className="recipe-title">{x.graph ?? x.file}</b>
      {x.description && <span className="muted small recipe-desc">{x.description}</span>}
      {errors.length > 0 ? (
        <span className="tone-fail small">
          {errors.length} problem{errors.length === 1 ? "" : "s"} · Line {errors[0]!.line}: {errors[0]!.message}
        </span>
      ) : (
        <span className="muted small">
          {x.steps} step{x.steps === 1 ? "" : "s"} · <span className="mono">{x.file}</span>
        </span>
      )}
      {x.graph &&
        runs &&
        (runs.length > 0 ? (
          <span className="run-meta">
            <span>{runs.length} run{runs.length === 1 ? "" : "s"}</span>
            {waiting > 0 && <span className="tone-you">{waiting} waiting</span>}
            {runs[0]!.updated && <span>last run {ago(runs[0]!.updated)}</span>}
            {cost > 0 && <span className="mono">{usd(cost)}</span>}
          </span>
        ) : (
          <span className="muted small">No runs yet</span>
        ))}
    </a>
  );
}

/** Beside a run: the other runs of its recipe, to hop between them. */
function SiblingRuns({ recipe, graph, runs, current }: { recipe?: Recipe; graph?: string; runs?: Run[]; current: string }) {
  const mine = (runs ?? []).filter((r) => r.recipe === graph);
  return (
    <nav className="runs" aria-label={`Runs of ${graph ?? "this recipe"}`}>
      <h2>{recipe ? <a href={recipeHref(recipe.file)}>{recipe.graph}</a> : graph}</h2>
      <ul>
        {mine.map((r) => (
          <li key={r.id}>
            <RunLine r={r} current={current} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A recipe: its runs first (or its graph, before any run), its YAML one tab over. A broken one opens on its YAML. */
function RecipeView({ file, recipes, runs }: { file: string; recipes?: Recipe[]; runs?: Run[] }) {
  const [picked, setTab] = useState<"runs" | "graph" | "yaml">();
  const x = recipes?.find((y) => y.file === file);
  const g = useLive<RunGraph>(x?.graph ? `/api/recipes/${encodeURIComponent(x.graph)}/graph` : undefined);
  const [selected, setSelected] = useState<string>();
  useEffect(() => (setSelected(undefined), setTab(undefined)), [file]);
  if (!recipes) return <p className="muted pad">Loading…</p>;
  if (!x) return <p className="muted pad">There's no recipe {file} any more. <a href="#/">See the project</a>.</p>;
  const mine = x.graph ? (runs ?? []).filter((r) => r.recipe === x.graph) : [];
  const tab = !x.graph ? "yaml" : (picked ?? (mine.length ? "runs" : "graph"));
  const node = g.data?.nodes.find((n) => n.id === selected);
  const tabs = [["runs", `Runs${mine.length ? ` (${mine.length})` : ""}`], ["graph", "Graph"], ["yaml", "YAML"]] as const;
  return (
    <section className="run-view">
      <div className="run-head">
        <span className="trail">
          <b>{x.graph ?? x.file}</b>{" "}
          <span className="muted small">
            {x.level && `${x.level} · `}
            <span className="mono">{x.file}</span>
            {x.steps !== undefined && ` · ${x.steps} step${x.steps === 1 ? "" : "s"}`}
          </span>
        </span>
        {x.graph && (
          <span className="tabs" role="tablist">
            {tabs.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </span>
        )}
      </div>
      {x.description && <p className="muted pad-x">{x.description}</p>}
      {tab === "runs" ? (
        <div className="pad-x">
          {mine.length > 0 ? (
            <ul className="run-list">
              {mine.map((r) => (
                <li key={r.id}>
                  <RunLine r={r} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No runs yet.</p>
          )}
          <p className="muted small">
            Start {mine.length ? "another" : "one"}: <code>kriya run {x.graph}</code>
          </p>
        </div>
      ) : tab === "yaml" ? (
        <div className="pad-x">
          {x.problems.length > 0 && (
            <ul className="recipe-problems">
              {x.problems.map((p, i) => (
                <li key={i} className={p.severity === "error" ? "tone-fail" : "tone-stale"}>
                  Line {p.line}: {p.message}
                </li>
              ))}
            </ul>
          )}
          <pre className="yaml mono">
            {x.text.split("\n").map((line, i) => (
              <span key={i} className={x.problems.some((p) => p.line === i + 1) ? "yaml-line bad" : "yaml-line"}>
                <span className="yaml-n">{i + 1}</span>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      ) : g.error ? (
        <p className="error pad">{g.error}</p>
      ) : !g.data ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <>
          <div className="run-body">
            <Graph graph={g.data} {...(selected ? { selected } : {})} onSelect={setSelected} onOpenItem={() => {}} />
            {selected === START && <RunPanel graph={g.data} onClose={() => setSelected(undefined)} />}
            {node && (
              <aside className="panel" aria-label={`Step ${node.name}`}>
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">{node.detail}</span>
                    <h2>{node.name}</h2>
                  </div>
                  <button type="button" className="icon" onClick={() => setSelected(undefined)} aria-label="Close">×</button>
                </div>
                <p className="muted small">Not run yet. Its versions, checks and lock show up here once a run reaches it.</p>
              </aside>
            )}
          </div>
          <Key />
        </>
      )}
    </section>
  );
}

/** What the boxes mean: where the episode is, and what kind of step each is. */
function Key() {
  return (
    <p className="key muted">
      <span className="legend legend-done">Done</span> <span className="legend legend-now">Now</span> <span className="legend legend-next">To come</span> · White: AI step · Amber: you decide · Grey: tool · Dashed arrow: goes back, with a limit
    </p>
  );
}

const graphUrl = (run: string, at: string) => `/api/runs/${encodeURIComponent(run)}/graph${at ? `?at=${encodeURIComponent(at)}` : ""}`;

/** An item's step picked in an open for-each box (`per_shot[P3-04].pick`): its for-each item, and the step. */
const itemOf = (key?: string) => (key?.includes("]") ? key.slice(0, key.lastIndexOf("]") + 1) : undefined);

function RunView({ run, at }: { run: string; at: string }) {
  const g = useLive<RunGraph>(graphUrl(run, at));
  const [selected, setSelected] = useState<string>();
  useEffect(() => setSelected(undefined), [run, at]);
  // A step inside an item comes from that item's graph, fetched only while it's picked.
  const inItem = itemOf(selected);
  const item = useLive<RunGraph>(inItem ? graphUrl(run, inItem) : undefined);
  const openItem = (key: string) => go(`/run/${encodeURIComponent(run)}/${encodeURIComponent(key)}`);
  if (g.error) return <p className="error pad">{g.error}</p>;
  if (!g.data) return <p className="muted pad">Loading…</p>;
  const inner = inItem ? item.data?.nodes.find((n) => n.key === selected) : undefined;
  // Which item it's in heads the panel: "P1-01 · You decide · 4 buttons".
  const node = inner ? { ...inner, detail: `${/\[([^\]]+)\]$/.exec(inItem!)?.[1] ?? inItem} · ${inner.detail}` } : g.data.nodes.find((n) => n.id === selected);
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
        {selected === START ? <RunPanel graph={g.data} onClose={() => setSelected(undefined)} /> : node && <NodePanel key={node.key} n={node} run={run} onClose={() => setSelected(undefined)} onOpenItem={openItem} />}
      </div>
      <Key />
    </section>
  );
}

/** One for-each item's own graph, over the run it's in: Esc, ×, the backdrop or the browser's back closes it. */
function ItemModal({ run, at }: { run: string; at: string }) {
  const close = () => go(`/run/${encodeURIComponent(run)}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${at} in ${run}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon modal-close" onClick={close} aria-label="Close">×</button>
        <RunView run={run} at={at} />
      </div>
    </div>
  );
}

function InboxPage() {
  const inbox = useLive<{ items: Item[] }>("/api/inbox");
  if (inbox.error) return <p className="error pad">{inbox.error}</p>;
  if (!inbox.data) return <p className="muted pad">Loading…</p>;
  if (inbox.data.items.length === 0) return <><TipCards /><p className="muted pad">Nothing is waiting on you.</p></>;
  return (
    <>
    <TipCards />
    <ul className="inbox">
      {inbox.data.items.map((item) => (
        <li key={item.id}>
          <a className="card" href={`#/review/${encodeURIComponent(item.id)}`}>
            <span className="card-head">
              <span className="run-name">{item.run}</span>
              <b>{item.item ? `${item.item} · ` : ""}{item.title}</b>
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
    </>
  );
}

/** What keeps failing, with the words that would prevent it: Apply puts them in that step's prompt from its next generation on (D-76). */
function TipCards() {
  const live = useLive<Tips>("/api/tips");
  const [answered, setAnswered] = useState<Tips>();
  const [error, setError] = useState<string>();
  const tips = (answered ?? live.data)?.tips ?? [];
  if (tips.length === 0) return null;
  const answer = (id: string, a: "apply" | "dismiss") =>
    answerTip(id, a).then(setAnswered, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  return (
    <ul className="inbox tips">
      {tips.map((t) => (
        <li key={t.id} className="card tip">
          <span className="card-head">
            <b>💡 {t.symptom[0]!.toUpperCase() + t.symptom.slice(1)}</b>
            <span className="muted">{t.step} · {t.hits} times</span>
          </span>
          <span>Always add to its prompt: “{t.prevent}”</span>
          <span className="tip-buttons">
            <button className="primary" onClick={() => void answer(t.id, "apply")}>Apply</button>
            <button onClick={() => void answer(t.id, "dismiss")}>Dismiss</button>
          </span>
        </li>
      ))}
      {error && <li className="error">{error}</li>}
    </ul>
  );
}

/** One review, and the rest of its batch: after a decision the next one opens; the last goes back to the inbox. */
function ReviewPage({ id, onToast }: { id: string; onToast: (m: string) => void }) {
  const inbox = useLive<{ items: Item[] }>("/api/inbox");
  const [failed, setFailed] = useState<string>();
  const [batchOf, setBatchOf] = useState<Item[]>();
  const item = inbox.data?.items.find((i) => i.id === id);
  // The batch is fixed when you open it, so "Shot 2 of 5" keeps counting as items leave the inbox.
  useEffect(() => {
    if (item && !batchOf?.some((b) => b.id === item.id)) setBatchOf(inbox.data!.items.filter((i) => i.batch === item.batch));
  }, [item, batchOf, inbox.data]);
  if (failed) return <p className="error pad">{failed} <a href="#/inbox">Back to what's waiting</a></p>;
  if (!inbox.data) return <p className="muted pad">Loading…</p>;
  if (!item) return <p className="muted pad">This isn't waiting on you any more. <a href="#/inbox">See what is</a>.</p>;
  const batch = batchOf?.some((b) => b.id === item.id) ? batchOf : [item];
  return (
    <Screen
      key={item.id + item.shows.map((s) => s.version).join()}
      item={item}
      batch={batch}
      onBack={() => go("/inbox")}
      onError={setFailed}
      onDone={(m, next) => {
        onToast(m);
        go(next ? `/review/${encodeURIComponent(next.id)}` : "/inbox");
      }}
    />
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
