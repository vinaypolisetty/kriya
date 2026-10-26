/**
 * `kriya web` (Day 22, D-65): the review inbox in a browser. A small HTTP
 * server over the same project and store the commands use, so the browser and
 * the terminal can't disagree:
 *
 *   GET  /api/runs         every run: its recipe, status, what's waiting on you, cost, stale work
 *   GET  /api/runs/<id>/graph[?at=per_shot[P3-04]]
 *                          a run as its recipe's graph with each step's live state (Day 24, D-67);
 *                          `at` opens one item of a for-each step
 *   GET  /api/inbox        what's waiting on you, with each candidate's checks and the suggested fix
 *   GET  /api/media/<sha>  an image, clip or voice line from the blob store
 *   POST /api/decide       press a button: { run, key, action, selection?, note?, region? }
 *   GET  /api/events       server-sent events: `changed` whenever any run's log grows,
 *                          from this server or a `kriya` command in another terminal
 *   GET  /*                the web app (packages/web, built)
 *
 * Reading never calls a model or writes. A decision is recorded at once; the
 * run then carries on in the background (models, tools), one at a time.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, sniff, suggestFix } from "@kriya/adapters";
import { openStore, type Store } from "@kriya/store";
import { allInbox, drive, openRun, type Entry, type IO } from "./commands.js";
import { loadProject, type Project } from "./project.js";

/** The built web app. */
const APP = fileURLToPath(new URL("../../web/dist", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

/** One inbox item as the browser gets it: media as URLs, and the fix the checks suggest. */
export type WebItem = {
  id: string;
  run: string;
  key: string;
  title: string;
  review: string;
  buttons: Entry["buttons"];
  shows: { version: string; value: unknown; media?: { url: string; type: string }; verdict?: Entry["shows"][number]["verdict"] }[];
  suggested?: { action: string; selection?: string[]; note?: string; region?: unknown; why: string };
  /** Its run is still working after a decision (models, tools); the item may change. */
  working: boolean;
};

export type Web = { url: string; close(): Promise<void> };

export async function startWeb(first: Project, opts: { port?: number; host?: string; io: IO }): Promise<Web> {
  const store = openStore(join(first.root, ".kriya"));
  /** The project as it is now: recipes and the Library are files the creator edits while the server runs. */
  const current = (): Project => {
    const p = loadProject(first.root);
    const errors = p.problems.filter((x) => x.severity === "error");
    if (errors.length || p.library.problems.length) throw new Error(`the project has problems; run kriya status in a terminal to see them`);
    return p;
  };
  const quiet: IO = { out: () => {}, err: () => {}, cwd: opts.io.cwd };
  /** Decisions and the work after them, one at a time: two schedulers on one run would disagree. */
  let queue: Promise<unknown> = Promise.resolve();
  const busy = new Set<string>();
  const clients = new Set<ServerResponse>();

  /** Blobs never change, so each one's type is read once. */
  const types = new Map<string, string>();
  const typeOf = (hash: string) => {
    let t = types.get(hash);
    if (!t) {
      const b = store.blobs.get(hash);
      if (b) types.set(hash, (t = sniff(b)));
    }
    return t;
  };
  const inbox = async (): Promise<WebItem[]> => (await allInbox(current(), store, quiet, { readOnly: true })).map((e) => web(e, busy.has(e.run), typeOf));

  const runs = async () => {
    const project = current();
    const out = [];
    for (const id of store.events.runs()) {
      const { rec, s } = await openRun(project, store, id, quiet, { readOnly: true });
      const events = store.events.read(id);
      const nodes = Object.values(rec.state.nodes);
      out.push({
        id,
        recipe: rec.state.graph,
        status: rec.state.status,
        waiting: rec.state.status === "running" ? s.inbox().length : 0,
        working: busy.has(id),
        stale: nodes.filter((n) => n.status === "stale").length,
        failed: nodes.filter((n) => n.status === "failed").length,
        costUsd: rec.state.costUsd,
        started: events[0]?.at,
        updated: events.at(-1)?.at,
      });
    }
    return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  };

  const runGraph = async (id: string, at: string) => {
    const project = current();
    const { rec, s } = await openRun(project, store, id, quiet, { readOnly: true });
    // `at` names one item of a for-each step (`per_shot[P3-04]`, nested ones chained): walk down to its recipe.
    let g = project.graphs.find((x) => x.graph === rec.state.graph);
    let prefix = "";
    const trail: { label: string; at: string }[] = [{ label: rec.state.graph, at: "" }];
    for (const [, mapId, item] of at.matchAll(/(\w+)\[([^\]]+)\]/g)) {
      const map = g?.nodes.find((n) => n.id === mapId);
      if (!map || map.kind !== "map") throw new BadRequest(`'${mapId}' isn't a for-each step in this run`);
      prefix += `${mapId}[${item}].`;
      g = project.graphs.find((x) => x.graph === map.graph);
      trail.push({ label: item!, at: prefix.slice(0, -1) });
    }
    if (!g) throw new BadRequest(`this run's recipe '${rec.state.graph}' isn't in your recipes any more`);
    const waiting = new Set(s.inbox().map((i) => i.key));
    const thumb = (output: Record<string, unknown>) => {
      for (const v of Object.values(output)) {
        const hash = typeof v === "string" ? /^blob:([0-9a-f]{64})$/.exec(v)?.[1] : undefined;
        const type = hash ? typeOf(hash) : undefined;
        if (hash && type) return { url: `/api/media/${hash}`, type };
      }
      return undefined;
    };
    const nodes = g.nodes.map((n) => {
      const key = prefix + n.id;
      const st = rec.state.nodes[key];
      const items =
        n.kind === "map" && st?.items
          ? st.items.keys.map((k) => ({ key: `${key}[${k}]`, label: k, status: itemStatus(rec.state.nodes, `${key}[${k}].`) }))
          : undefined;
      const versions = st
        ? Object.values(st.versions).map((v) => {
            const t = thumb(v.output);
            const sum = verdictOf(v.verdicts);
            return { id: v.id, costUsd: v.costUsd, ...(t ? { thumb: t } : {}), ...(sum ? { verdict: sum } : {}), ...(v.madeBy ? { madeBy: v.madeBy } : {}), ...(v.instruction ? { instruction: v.instruction } : {}), ...(v.model ? { model: v.model } : {}) };
          })
        : [];
      return {
        id: n.id,
        key,
        kind: n.kind,
        name: n.name ?? n.id,
        detail: describeNode(n),
        status: st?.status ?? "not_started",
        waitingOnYou: waiting.has(key),
        costUsd: st?.costUsd ?? 0,
        versions,
        ...(st?.locked ? { locked: st.locked } : {}),
        ...(st?.failure ? { failure: st.failure } : {}),
        ...(st?.staleReason ? { staleReason: st.staleReason } : {}),
        ...(st?.blockedReason ? { blockedReason: st.blockedReason } : {}),
        ...(items ? { items } : {}),
      };
    });
    const edges = g.edges.flatMap((e) =>
      (Array.isArray(e.from) ? e.from : [e.from]).map((from) => ({
        from,
        to: e.to,
        ...(e.when ? { label: edgeLabel(e.when) } : Array.isArray(e.from) && e.from.length > 1 ? { label: "wait for all" } : {}),
        ...(e.max_loops !== undefined ? { back: true, limit: e.max_loops } : {}),
      })),
    );
    return { run: id, recipe: g.graph, at, trail, status: rec.state.status, costUsd: rec.state.costUsd, inputs: g.inputs, nodes, edges };
  };

  const decide = async (body: { run?: unknown; key?: unknown; action?: unknown; selection?: unknown; note?: unknown; region?: unknown }) => {
    const { run, key, action } = body;
    if (typeof run !== "string" || typeof key !== "string" || typeof action !== "string") throw new BadRequest("say which run, step and button: { run, key, action }");
    const answered = queue.then(async () => {
      // Read-only first: the person's answer is recorded before anything else runs, so nothing
      // (an automatic screen, a recovered job) can answer in their place.
      const { s, jobs } = await openRun(current(), store, run, quiet, { readOnly: true });
      s.answer(key, {
        action,
        ...(Array.isArray(body.selection) && body.selection.length ? { selection: body.selection.map(String) } : {}),
        ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}),
        ...(body.region !== undefined && body.region !== "" ? { region: body.region } : {}),
        by: "human",
      });
      return { s, jobs };
    });
    queue = answered.then(
      ({ s, jobs }) => {
        // The decision is on the record; what follows (models, tools) carries on without the browser waiting.
        busy.add(run);
        s.recover();
        return drive(s, jobs, quiet)
          .catch((e) => opts.io.err(`! ${run}: ${describeError(e)}`))
          .finally(() => busy.delete(run));
      },
      () => undefined,
    );
    await answered;
  };

  // Any growth in the log, from anyone, is news. Polling SQLite is cheap and sees other processes too.
  const seq = () => (store.db.prepare("SELECT coalesce(max(seq), 0) AS n FROM events").get() as { n: number }).n;
  let last = seq();
  const ticker = setInterval(() => {
    const now = seq();
    if (now === last) return;
    last = now;
    for (const c of clients) c.write(`event: changed\ndata: ${now}\n\n`);
  }, 500);

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof BadRequest ? 400 : e instanceof Error && !(e instanceof TypeError) ? 409 : 500;
      json(res, status, { error: e instanceof Error ? e.message : String(e) });
      if (status === 500) opts.io.err(`! ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://kriya");
    if (req.method === "GET" && url.pathname === "/api/inbox") return json(res, 200, { project: first.settings.name, items: await inbox() });
    if (req.method === "GET" && url.pathname === "/api/runs") return json(res, 200, { project: first.settings.name, runs: await runs() });
    const graph = /^\/api\/runs\/([^/]+)\/graph$/.exec(url.pathname);
    if (req.method === "GET" && graph) return json(res, 200, await runGraph(decodeURIComponent(graph[1]!), url.searchParams.get("at") ?? ""));
    if (req.method === "POST" && url.pathname === "/api/decide") {
      await decide(JSON.parse((await readBody(req)) || "{}"));
      return json(res, 200, { items: await inbox() });
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: changed\ndata: ${last}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const media = /^\/api\/media\/([0-9a-f]{64})$/.exec(url.pathname);
    if (req.method === "GET" && media) {
      const bytes = store.blobs.get(media[1]!);
      if (!bytes) return json(res, 404, { error: "no such file" });
      res.writeHead(200, { "content-type": sniff(bytes), "cache-control": "public, max-age=31536000, immutable" });
      return res.end(bytes);
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveApp(url.pathname, res);
    json(res, 404, { error: `no ${req.method} ${url.pathname}` });
  }

  await new Promise<void>((ok) => server.listen(opts.port ?? 4317, opts.host ?? "127.0.0.1", ok));
  const addr = server.address() as { port: number };
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${addr.port}`,
    async close() {
      clearInterval(ticker);
      for (const c of clients) c.end();
      await new Promise<void>((ok) => server.close(() => ok()));
      await queue;
      store.close();
    },
  };
}

/** An inbox entry for the browser: blobs as media URLs, the suggested fix, and whether its run is still working. */
function web(e: Entry, working: boolean, typeOf: (hash: string) => string | undefined): WebItem {
  const s = suggestFix({ actions: e.buttons }, e.shows);
  return {
    id: `${e.run}:${e.key}`,
    run: e.run,
    key: e.key,
    title: e.title,
    review: e.review,
    buttons: e.buttons,
    working,
    shows: e.shows.map((x) => {
      const hash = typeof x.value === "string" ? /^blob:([0-9a-f]{64})$/.exec(x.value)?.[1] : undefined;
      const type = hash ? typeOf(hash) : undefined;
      return { version: x.version, value: x.value, ...(hash && type ? { media: { url: `/api/media/${hash}`, type } } : {}), ...(x.verdict ? { verdict: x.verdict } : {}) };
    }),
    ...(s ? { suggested: s } : {}),
  };
}

const VERBS: Record<string, string> = {
  "image.generate": "draws",
  "image.edit": "edits",
  "video.from_image": "animates",
  "audio.speech": "voices",
  "audio.music": "scores",
  "llm.write": "writes",
  "llm.vision": "looks",
};

/** What one step is, in a few words, for its box on the graph. */
function describeNode(n: Project["graphs"][number]["nodes"][number]): string {
  switch (n.kind) {
    case "model":
      return [`AI · ${VERBS[n.capability] ?? n.capability}`, n.options > 1 ? `${n.options} options` : "", n.check ? "checked" : "", n.refines ? `remakes ${n.refines}` : ""].filter(Boolean).join(" · ");
    case "agent":
      return `Agent · ${n.tools.length} tool${n.tools.length === 1 ? "" : "s"}`;
    case "tool":
      return [`Tool · ${n.tool}`, n.refines ? `remakes ${n.refines}` : ""].filter(Boolean).join(" · ");
    case "screen":
      return [`You decide · ${n.actions.length} button${n.actions.length === 1 ? "" : "s"}`, n.trust === "when_confident" ? "auto when confident" : ""].filter(Boolean).join(" · ");
    case "map":
      return `For each in ${n.over}`;
    case "subgraph":
      return `Runs ${n.graph}`;
  }
}

/** An edge's condition, as the words on its arrow: the button it follows, or the check it reads. */
function edgeLabel(when: string): string {
  return when
    .replace(/action == '(\w+)'/g, "$1")
    .replace(/not verdict\.pass/g, "failed checks")
    .replace(/verdict\.pass/g, "passed checks")
    .replace(/ and /g, " · ")
    .replace(/ == true/g, "")
    .replace(/ == false/g, " is no");
}

/** One item of a for-each step, in one word: the most pressing state of any of its steps. */
function itemStatus(nodes: Record<string, { status: string }>, prefix: string): string {
  const all = Object.entries(nodes).filter(([k]) => k.startsWith(prefix)).map(([, n]) => n.status);
  if (all.length === 0) return "not_started";
  for (const s of ["failed", "awaiting_human", "blocked", "stale"]) if (all.includes(s)) return s;
  if (all.some((s) => s === "running" || s === "waiting_external" || s === "ready")) return "running";
  return "done";
}

/** A version's checks: the latest verdict of each kind of checker. */
function verdictOf(vs: { by: string; pass: boolean; issues: unknown[] }[]): { pass: boolean; issues: unknown[] } | undefined {
  if (vs.length === 0) return undefined;
  const latest = [...new Map(vs.map((v) => [v.by, v])).values()];
  return { pass: latest.every((v) => v.pass), issues: latest.flatMap((v) => v.issues) };
}

function serveApp(path: string, res: ServerResponse) {
  if (!existsSync(join(APP, "index.html"))) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("The web app isn't built yet. Run: pnpm --filter @kriya/web build\nThe API is up: /api/inbox");
  }
  const file = normalize(join(APP, path));
  const target = file.startsWith(APP) && existsSync(file) && statSync(file).isFile() ? file : join(APP, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream" });
  res.end(readFileSync(target));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => ok(s));
    req.on("error", fail);
  });
}

class BadRequest extends Error {}
