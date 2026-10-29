/**
 * `kriya web` (Day 22, D-65): the review inbox in a browser. A small HTTP
 * server over the same project and store the commands use, so the browser and
 * the terminal can't disagree:
 *
 *   GET  /api/runs         every run: its recipe, status, what's waiting on you, cost, stale work
 *   GET  /api/runs/<id>/graph[?at=per_shot[P3-04]]
 *                          a run as its recipe's graph with each step's live state (Day 24, D-67);
 *                          `at` opens one item of a for-each step; `given` is what it was started with
 *   GET  /api/runs/<id>/trace[?at=…][&key=…][&all=1]
 *                          what happened, from the event log (Day 36): one step's lines in plain words
 *                          (`key`), how often each arrow was taken, and each review's last answer;
 *                          `all` gives every line in the scope and each decision with what it was made on
 *   GET  /api/inbox        what's waiting on you, with each candidate's checks and the suggested fix
 *   GET  /api/media/<sha>  an image, clip or voice line from the blob store
 *   POST /api/decide       press a button: { run, key, action, selection?, note?, region? }
 *   POST /api/retry        try a failed step again: { run, key, note?, leaveOut? } (a for-each step retries its
 *                          failed items); a note or inputs left out try it with a change (Q-24)
 *   POST /api/branch       branch off from a version: { run, key, name, from } (Day 26, D-71)
 *   POST /api/switch       switch a step to another of its branches: { run, key, branch }
 *   GET  /api/tips         what keeps failing and the words that would prevent it, and the tips applied (D-76)
 *   POST /api/tips         say yes or no to a tip: { id, answer: "apply" | "dismiss" } (saved in kb.yaml)
 *   GET  /api/recipes      every recipe file, oldest first: its YAML as written, when the file was made,
 *                          the graph it defines, whether it's top level (no other recipe runs it), and its problems
 *   GET  /api/recipes/<id>/graph
 *                          a recipe as a graph before any run: every step not started
 *   GET  /api/library      the Library, read-only: who's in it by kind, each facet's current version
 *                          (files as media), its history, and what each is missing
 *   GET  /api/events       server-sent events: `changed` whenever any run's log grows,
 *                          from this server or a `kriya` command in another terminal
 *   GET  /*                the web app (packages/web, built)
 *
 * Started in a folder of projects instead of a project (`kriya web` in
 * `~/projects`, each project a folder with its kriya.yaml), home is a card per
 * project, and each project is served under its folder's name:
 *
 *   GET  /api/projects     every project in the folder: its name, recipes, runs, what's waiting on you
 *   *    /p/<folder>/…     that project's app and every route above (`/p/mohalla-mitra/api/inbox`)
 *   GET  /api/media/<sha>  a file from whichever project's blob store has it
 *
 * With `lan`, it listens on the home network too, so a phone can review over
 * wifi (D-38, D-68): a request from another device needs the pairing cookie,
 * set by opening `/pair?token=<token>` once (the token lives in
 * `.kriya/web-token`). This machine never needs it.
 *
 * Reading never calls a model or writes. A decision is recorded at once; the
 * run then carries on in the background (models, tools), one at a time.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, sniff, suggestFix, type FixRule } from "@kriya/adapters";
import { openStore, type Store } from "@kriya/store";
import { findGraph, type RunState } from "@kriya/engine";
import { allInbox, drive, openRun, recipeId, type Entry, type IO } from "./commands.js";
import { answerTip, projectTips } from "./kb.js";
import { traceView } from "./trace.js";
import { libraryAssets, MEDIA } from "./library.js";
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
  buttons: (Entry["buttons"][number] & { estimateUsd?: number })[];
  /** What the recipe puts beside the candidates: the line to be said, its caption, the shot's action. */
  beside: Entry["beside"];
  shows: { version: string; value: unknown; media?: { url: string; type: string }; verdict?: Entry["shows"][number]["verdict"] }[];
  suggested?: { action: string; selection?: string[]; note?: string; region?: unknown; why: string };
  /** The branch of the step on show, when it's not main: the review shows only that branch's candidates (D-71). */
  branch?: string;
  /** Its run is still working after a decision (models, tools); the item may change. */
  working: boolean;
  /** Reviews of the same step across a for-each step's items share a batch (`part:per_shot[].pick`); `item` names this one (P3-04). */
  batch: string;
  item?: string;
};

export type Web = {
  url: string;
  /** With `lan`: this machine's addresses on the network, and the link that pairs a phone. */
  lan?: { urls: string[]; pair: string };
  close(): Promise<void>;
};

export type WebOptions = {
  port?: number;
  io: IO;
  /** Listen on the home network too; other devices need the pairing token. */
  lan?: boolean;
  /** Treat requests from this machine as paired (default true). Tests turn it off to act as a phone. */
  trustLoopback?: boolean;
};

/** The pairing token, made once and kept in `.kriya/web-token`. */
function pairingToken(root: string): string {
  const file = join(root, ".kriya", "web-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(join(root, ".kriya"), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** One project's API: everything under /api/ for it. `handle` answers false for a request that isn't its. */
type ProjectApi = {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<false | void>;
  /** What the project card says: its runs and how many wait on you. */
  runs(): Promise<{ waiting: number }[]>;
  store: Store;
  close(): Promise<void>;
};

/** A folder of projects: each subfolder with a kriya.yaml, by name. */
export type Projects = { folder: string; projects: Project[] };

export async function startWeb(target: Project | Projects, opts: WebOptions): Promise<Web> {
  const many = "projects" in target;
  const token = opts.lan ? pairingToken(many ? target.folder : target.root) : undefined;
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const local = (req: IncomingMessage) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  const paired = (req: IncomingMessage) => {
    if (!token) return true; // only this machine can reach it
    if (local(req) && opts.trustLoopback !== false) return true;
    const cookie = /(?:^|;\s*)kriya_pair=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return cookie !== undefined && same(decodeURIComponent(cookie), token);
  };
  // A project's store opens the first time it's asked for, so a folder of projects costs nothing until you pick one.
  const apis = new Map<string, ProjectApi>();
  const folderOf = (p: Project) => relative(many ? target.folder : p.root, p.root) || ".";
  const apiOf = (p: Project) => {
    let a = apis.get(p.root);
    if (!a) apis.set(p.root, (a = projectApi(p, opts)));
    return a;
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof BadRequest ? 400 : e instanceof Error && !(e instanceof TypeError) ? 409 : 500;
      json(res, status, { error: e instanceof Error ? e.message : String(e) });
      if (status === 500) opts.io.err(`! ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://kriya");
    if (token && url.pathname === "/pair") {
      if (!same(url.searchParams.get("token") ?? "", token)) return page(res, 403, "That pairing link isn't right. Open the one `kriya web --lan` printed (or scan its QR code) on this phone.");
      res.writeHead(302, { "set-cookie": `kriya_pair=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}`, location: "/" });
      return res.end();
    }
    if (!paired(req)) {
      if (url.pathname.startsWith("/api/") || /^\/p\/[^/]+\/api\//.test(url.pathname)) return json(res, 401, { error: "this device isn't paired: open the link `kriya web --lan` printed, or scan its QR code" });
      return page(res, 401, "This phone isn't paired with kriya yet. On the computer running `kriya web --lan`, scan the QR code (or open the link it printed) with this phone.");
    }
    if (!many) {
      if ((await apiOf(target).handle(req, res, url)) !== false) return;
    } else {
      if (req.method === "GET" && url.pathname === "/api/projects") return json(res, 200, { folder: target.folder, projects: await projectCards() });
      const media = /^\/api\/media\/([0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === "GET" && media) {
        // Blobs are named by their bytes, so whichever project has it, it's the same file.
        for (const p of target.projects) if ((await apiOf(p).handle(req, res, url)) !== false) return;
      }
      const inside = /^\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (inside) {
        const name = decodeURIComponent(inside[1]!);
        const p = target.projects.find((x) => folderOf(x) === name);
        if (!p) throw new BadRequest(`there's no project '${name}' in ${target.folder}`);
        const rest = inside[2] ?? "/";
        if (rest.startsWith("/api/")) {
          const local = new URL(url);
          local.pathname = rest;
          if ((await apiOf(p).handle(req, res, local)) !== false) return;
        } else if (req.method === "GET") return serveApp(rest, res);
      }
    }
    if (req.method === "GET" && /^(\/p\/[^/]+)?\/api\/media\//.test(url.pathname)) return json(res, 404, { error: "no such file" });
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveApp(url.pathname, res);
    json(res, 404, { error: `no ${req.method} ${url.pathname}` });
  }

  /** A card per project, in folder order: what the home page shows when kriya web is started in a folder of projects. */
  async function projectCards() {
    if (!many) return [];
    return Promise.all(
      target.projects.map(async (p) => {
        const top = p.graphs.filter((g) => !p.graphs.some((o) => o.nodes.some((n) => (n.kind === "map" || n.kind === "subgraph") && n.graph === g.graph)));
        const errors = p.problems.filter((x) => x.severity === "error").length;
        let runs: { waiting: number }[] = [];
        try {
          runs = await apiOf(p).runs();
        } catch {
          // a project with problems still gets its card; its own pages say what's wrong
        }
        return {
          folder: folderOf(p),
          name: p.settings.name,
          recipes: top.map((g) => ({ graph: g.graph, description: g.description ?? "" })),
          runs: runs.length,
          waiting: runs.reduce((n, r) => n + r.waiting, 0),
          problems: errors,
        };
      }),
    );
  }

  await new Promise<void>((ok) => server.listen(opts.port ?? 4317, opts.lan ? "0.0.0.0" : "127.0.0.1", ok));
  const addr = server.address() as { port: number };
  const lanUrls = opts.lan
    ? Object.values(networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal)
        .map((i) => `http://${i!.address}:${addr.port}`)
    : [];
  return {
    url: `http://127.0.0.1:${addr.port}`,
    ...(token ? { lan: { urls: lanUrls, pair: `${lanUrls[0] ?? `http://127.0.0.1:${addr.port}`}/pair?token=${token}` } } : {}),
    async close() {
      await new Promise<void>((ok) => server.close(() => ok()));
      await Promise.all([...apis.values()].map((a) => a.close()));
    },
  };
}

function projectApi(first: Project, opts: WebOptions): ProjectApi {
  const store = openStore(join(first.root, ".kriya"));
  /** The project as it is now: recipes and the Library are files the creator edits while the server runs. */
  const current = (): Project => {
    const p = loadProject(first.root);
    const errors = p.problems.filter((x) => x.severity === "error");
    if (errors.length || p.library.problems.length || p.kbProblems.length) throw new Error(`the project has problems; run kriya status in a terminal to see them`);
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
  const inbox = async (): Promise<WebItem[]> => {
    const project = current();
    const entries = await allInbox(project, store, quiet, { readOnly: true });
    const states = new Map<string, RunState>();
    for (const e of entries) if (!states.has(e.run)) states.set(e.run, (await openRun(project, store, e.run, quiet, { readOnly: true })).rec.state);
    return entries.map((e) => {
      const item = web(e, busy.has(e.run), typeOf, estimates(project, states.get(e.run)!, e.key), project.kb.rules);
      const branch = shownBranch(project, states.get(e.run)!, e.key);
      return branch && branch !== "main" ? { ...item, branch } : item;
    });
  };

  const runs = async () => {
    const project = current();
    const out = [];
    for (const id of store.events.runs()) {
      const { rec, s } = await openRun(project, store, id, quiet, { readOnly: true });
      const events = store.events.read(id);
      const nodes = Object.values(rec.state.nodes);
      out.push({
        id,
        recipe: recipeId(project, rec.state.graph),
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
    let g = findGraph(project.graphs, rec.state.graph);
    let prefix = "";
    const trail: { label: string; at: string }[] = [{ label: g?.graph ?? rec.state.graph, at: "" }];
    for (const [, mapId, item] of at.matchAll(/(\w+)\[([^\]]+)\]/g)) {
      const map = g?.nodes.find((n) => n.id === mapId);
      if (!map || map.kind !== "map") throw new BadRequest(`'${mapId}' isn't a for-each step in this run`);
      prefix += `${mapId}[${item}].`;
      g = findGraph(project.graphs, map.graph);
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
      // Each item with its own steps and a picture of what it made, so the box can open them in place.
      const inner = n.kind === "map" ? findGraph(project.graphs, n.graph) : undefined;
      const items =
        n.kind === "map" && st?.items
          ? st.items.keys.map((k) => {
              const at = `${key}[${k}].`;
              const steps = (inner?.nodes ?? []).map((c) => ({ key: at + c.id, name: c.name ?? c.id, status: rec.state.nodes[at + c.id]?.status ?? "not_started", waitingOnYou: waiting.has(at + c.id) }));
              const made = (inner?.nodes ?? []).flatMap((c) => {
                const cs = rec.state.nodes[at + c.id];
                const v = cs && (cs.locked ? cs.versions[cs.locked.version] : Object.values(cs.versions).at(-1));
                const t = v ? thumb(v.output) : undefined;
                return t?.type.startsWith("image/") ? [t] : [];
              });
              return { key: `${key}[${k}]`, label: k, status: itemStatus(rec.state.nodes, at), steps, ...(made.length ? { thumb: made.at(-1)! } : {}) };
            })
          : undefined;
      const versions = st
        ? Object.values(st.versions).map((v) => {
            const t = thumb(v.output);
            const sum = verdictOf(v.verdicts);
            return { id: v.id, costUsd: v.costUsd, branch: v.branch, parents: v.parents, ...(t ? { thumb: t } : {}), ...(sum ? { verdict: sum } : {}), ...(v.madeBy ? { madeBy: v.madeBy } : {}), ...(v.instruction ? { instruction: v.instruction } : {}), ...(v.model ? { model: v.model } : {}) };
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
        ...(st ? { branch: st.branch, branches: Object.entries(st.branches).map(([name, b]) => ({ name, ...(b.from ? { from: b.from } : {}) })) } : {}),
        ...(st?.locked ? { locked: st.locked } : {}),
        ...(st?.failure ? { failure: st.failure } : {}),
        ...(st?.status === "failed" && (n.kind === "model" || n.kind === "agent") ? { leavable: s.leavable(key) } : {}),
        ...(st?.staleReason ? { staleReason: st.staleReason } : {}),
        ...(st?.blockedReason ? { blockedReason: st.blockedReason } : {}),
        ...(items ? { items } : {}),
      };
    });
    const edges = arrows(g);
    return { run: id, recipe: g.graph, at, trail, status: rec.state.status, costUsd: rec.state.costUsd, inputs: g.inputs, given: s.inputsAt(prefix) ?? {}, nodes, edges };
  };

  /** A failed step tried again (`kriya retry`), maybe with a change: recorded at once, then the run carries on in the background. */
  const retry = async (body: { run?: unknown; key?: unknown; note?: unknown; leaveOut?: unknown }) => {
    const { run, key, note, leaveOut } = body;
    if (typeof run !== "string" || typeof key !== "string") throw new BadRequest("say which run and step: { run, key }");
    if (note !== undefined && typeof note !== "string") throw new BadRequest("a note is words: { run, key, note: \"say it gently\" }");
    if (leaveOut !== undefined && !(Array.isArray(leaveOut) && leaveOut.every((r) => typeof r === "string"))) throw new BadRequest("say what to leave out as a list: { run, key, leaveOut: [\"line.emotion\"] }");
    const started = queue.then(async () => {
      const { s, jobs } = await openRun(current(), store, run, quiet, { readOnly: true });
      s.retry(key, { ...(note ? { note } : {}), ...(leaveOut ? { leaveOut: leaveOut as string[] } : {}) });
      return { s, jobs };
    });
    queue = started.then(
      ({ s, jobs }) => {
        busy.add(run);
        s.recover();
        return drive(s, jobs, quiet)
          .catch((e) => opts.io.err(`! ${run}: ${describeError(e)}`))
          .finally(() => busy.delete(run));
      },
      () => undefined,
    );
    await started;
  };

  /** Branching and switching record one event each; nothing runs until a button is pressed on the branch. */
  const branch = async (body: { run?: unknown; key?: unknown; name?: unknown; from?: unknown; branch?: unknown }) => {
    const { run, key } = body;
    if (typeof run !== "string" || typeof key !== "string") throw new BadRequest("say which run and step: { run, key }");
    const done = queue.then(async () => {
      const { s } = await openRun(current(), store, run, quiet, { readOnly: true });
      if (typeof body.branch === "string") return s.switchBranch(key, body.branch);
      if (typeof body.name !== "string" || typeof body.from !== "string") throw new BadRequest("say what to call the branch and which version it starts from: { name, from }");
      s.branch(key, body.name, body.from);
    });
    queue = done.catch(() => undefined);
    await done;
  };

  /** The recipe files as written, problems and all: a broken recipe is the one you most need to see. */
  const recipes = () => {
    const project = loadProject(first.root);
    const dir = join(project.root, project.settings.recipes);
    // A recipe another one runs (for-each, subgraph) is a part of it; the rest are the project's top level.
    const runBy = new Set(project.graphs.flatMap((g) => g.nodes.flatMap((n) => (n.kind === "map" || n.kind === "subgraph" ? [findGraph(project.graphs, n.graph)?.graph ?? n.graph] : []))));
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.ya?ml$/.test(f) && statSync(join(dir, f)).isFile())
      // In the order they were made, so home keeps them where you put them (a fresh clone ties, then A–Z).
      .map((f) => ({ f, created: statSync(join(dir, f)).birthtime.toISOString() }))
      .sort((a, b) => a.created.localeCompare(b.created) || a.f.localeCompare(b.f))
      .map(({ f, created }) => {
        const text = readFileSync(join(dir, f), "utf8");
        const id = /^graph:\s*([\w-]+)/m.exec(text)?.[1];
        const g = project.graphs.find((x) => x.graph === id);
        const problems = project.problems.filter((p) => resolve(p.file) === join(dir, f)).map((p) => ({ line: p.line, message: p.message, severity: p.severity }));
        return { file: f, text, created, ...(g ? { graph: g.graph, level: g.level, steps: g.nodes.length, top: !runBy.has(g.graph), ...(g.description ? { description: g.description } : {}) } : {}), problems };
      });
  };

  /** A recipe as a graph before any run: every step still to come. */
  const recipeGraph = (id: string) => {
    const g = findGraph(current().graphs, id);
    if (!g) throw new BadRequest(`there's no recipe '${id}'`);
    const nodes = g.nodes.map((n) => ({ id: n.id, key: n.id, kind: n.kind, name: n.name ?? n.id, detail: describeNode(n), status: "not_started", waitingOnYou: false, costUsd: 0, versions: [] }));
    return { run: "", recipe: g.graph, at: "", trail: [{ label: g.graph, at: "" }], status: "not_started", costUsd: 0, inputs: g.inputs, nodes, edges: arrows(g) };
  };

  /** The Library as it is on disk now, with every version kriya has seen of each facet. */
  const library = () => {
    const project = current();
    const assets = libraryAssets(project.library, project.root, store, false);
    const kinds = project.settings.kinds;
    /** A facet value for the browser: each file it names as media from the store, or missing. */
    const media = (v: unknown, files: { path: string; hash: string }[]): unknown => {
      if (typeof v === "string" && MEDIA.test(v)) {
        const f = files.find((x) => x.path === relative(project.root, resolve(project.root, v)));
        const type = f ? typeOf(f.hash) : undefined;
        return f && type ? { file: v, url: `/api/media/${f.hash}`, type } : { file: v, missing: true };
      }
      if (Array.isArray(v)) return v.map((x) => media(x, files));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, media(x, files)]));
      return v;
    };
    return [...project.library.entities.values()].map((e) => ({
      name: e.name,
      ...(e.kind ? { kind: e.kind } : {}),
      file: e.file,
      needs: (kinds[e.kind ?? ""] ?? []).filter((f) => !(f in e.facets)),
      facets: Object.keys(e.facets).map((facet) => {
        const r = assets.resolve(e.name, facet)!;
        const history = store.library.history(e.name, facet);
        const files = "files" in r ? r.files : [];
        return {
          facet,
          value: media(e.facets[facet], files),
          ...("missing" in r ? { missing: r.missing } : { n: history.find((h) => h.version === r.version)!.n }),
          history: [...history].reverse().map((h) => ({ n: h.n, at: h.at, value: h.value, current: "version" in r && h.version === r.version })),
        };
      }),
    }));
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

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<false | void> {
    if (req.method === "GET" && url.pathname === "/api/inbox") return json(res, 200, { project: first.settings.name, items: await inbox() });
    if (req.method === "GET" && url.pathname === "/api/runs") return json(res, 200, { project: first.settings.name, runs: await runs() });
    const traced = /^\/api\/runs\/([^/]+)\/trace$/.exec(url.pathname);
    if (req.method === "GET" && traced) {
      const id = decodeURIComponent(traced[1]!);
      if (!store.events.runs().includes(id)) throw new BadRequest(`there's no run '${id}'`);
      const opts = { at: url.searchParams.get("at") ?? "", ...(url.searchParams.get("key") ? { key: url.searchParams.get("key")! } : {}), all: url.searchParams.has("all") };
      return json(res, 200, traceView(store.events.read(id), current().graphs, opts));
    }
    const graph = /^\/api\/runs\/([^/]+)\/graph$/.exec(url.pathname);
    if (req.method === "GET" && graph) return json(res, 200, await runGraph(decodeURIComponent(graph[1]!), url.searchParams.get("at") ?? ""));
    if (req.method === "POST" && url.pathname === "/api/retry") {
      await retry(JSON.parse((await readBody(req)) || "{}"));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && (url.pathname === "/api/branch" || url.pathname === "/api/switch")) {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      if (url.pathname === "/api/switch" && typeof body.branch !== "string") throw new BadRequest("say which branch to switch to: { run, key, branch }");
      await branch(url.pathname === "/api/switch" ? body : { ...body, branch: undefined });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/tips" && (req.method === "GET" || req.method === "POST")) {
      const project = current();
      const found = projectTips(store, project.graphs, project.kb);
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { id?: unknown; answer?: unknown };
        const tip = found.find((t) => t.id === body.id);
        if (!tip) throw new BadRequest(`there's no tip '${String(body.id)}' now; it may have been answered already`);
        if (body.answer !== "apply" && body.answer !== "dismiss") throw new BadRequest(`answer a tip with "apply" or "dismiss"`);
        answerTip(project.root, project.kb, tip, body.answer === "apply");
        const after = current();
        return json(res, 200, { tips: projectTips(store, after.graphs, after.kb), applied: after.kb.applied });
      }
      return json(res, 200, { tips: found, applied: project.kb.applied });
    }
    if (req.method === "GET" && url.pathname === "/api/recipes") return json(res, 200, { project: first.settings.name, recipes: recipes() });
    const recipe = /^\/api\/recipes\/([^/]+)\/graph$/.exec(url.pathname);
    if (req.method === "GET" && recipe) return json(res, 200, recipeGraph(decodeURIComponent(recipe[1]!)));
    if (req.method === "GET" && url.pathname === "/api/library") return json(res, 200, { project: first.settings.name, kinds: first.settings.kinds, entities: library() });
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
      if (!bytes) return false; // another project's, or nobody's
      res.writeHead(200, { "content-type": sniff(bytes), "cache-control": "public, max-age=31536000, immutable" });
      res.end(bytes);
      return;
    }
    return false;
  }

  return {
    handle,
    runs,
    store,
    async close() {
      clearInterval(ticker);
      for (const c of clients) c.end();
      await queue;
      store.close();
    },
  };
}

/** The recipe a step key is in, walking down for-each items: `per_shot[P3-04].pick` → shot_recipe and `per_shot[P3-04].`. */
function recipeOf(project: Project, state: RunState, key: string) {
  let g = findGraph(project.graphs, state.graph);
  let prefix = "";
  for (const [, mapId, item] of key.matchAll(/(\w+)\[([^\]]+)\]\./g)) {
    const map = g?.nodes.find((n) => n.id === mapId);
    if (!map || map.kind !== "map") return undefined;
    prefix += `${mapId}[${item}].`;
    g = findGraph(project.graphs, map.graph);
  }
  return g ? { g, prefix } : undefined;
}

/** Which branch a screen's candidates come from: the branch of the step it shows. */
function shownBranch(project: Project, state: RunState, key: string): string | undefined {
  const r = recipeOf(project, state, key);
  const screen = r?.g.nodes.find((n) => n.id === key.slice(r.prefix.length));
  const shown = screen?.kind === "screen" ? screen.show?.split(".")[0] : undefined;
  return shown ? state.nodes[r!.prefix + shown]?.branch : undefined;
}

/** An inbox entry for the browser: blobs as media URLs, the suggested fix, and whether its run is still working. */
/**
 * What each of a screen's buttons will cost, before you press it: the step its
 * arrow leads to, times what that step's candidates have cost in this run so
 * far. A step that hasn't run yet has no estimate (rather than a guess).
 */
export function estimates(project: Project, state: RunState, key: string): Record<string, number> {
  const r = recipeOf(project, state, key);
  if (!r) return {};
  const { g, prefix } = r;
  const screenId = key.slice(prefix.length);
  const out: Record<string, number> = {};
  for (const e of g.edges) {
    const from = Array.isArray(e.from) ? e.from : [e.from];
    const action = /action == '(\w+)'/.exec(e.when ?? "")?.[1];
    if (!from.includes(screenId) || !action || e.to === "END") continue;
    const step = g.nodes.find((n) => n.id === e.to);
    if (!step || (step.kind !== "model" && step.kind !== "tool" && step.kind !== "agent")) continue;
    // Its past candidates: on its own node, or on the node it refines (marked made by it).
    const home = state.nodes[prefix + ("refines" in step && step.refines ? step.refines : step.id)];
    const made = Object.values(home?.versions ?? {}).filter((v) => ("refines" in step && step.refines ? v.madeBy === prefix + step.id : !v.madeBy));
    if (made.length === 0) continue;
    const each = made.reduce((a, v) => a + v.costUsd, 0) / made.length;
    out[action] = Math.round(each * (step.kind === "model" ? step.options : 1) * 1000) / 1000;
  }
  return out;
}

function web(e: Entry, working: boolean, typeOf: (hash: string) => string | undefined, cost: Record<string, number> = {}, rules?: FixRule[]): WebItem {
  const s = suggestFix({ actions: e.buttons }, e.shows, rules);
  return {
    id: `${e.run}:${e.key}`,
    run: e.run,
    key: e.key,
    title: e.title,
    review: e.review,
    buttons: e.buttons.map((b) => (cost[b.id] !== undefined ? { ...b, estimateUsd: cost[b.id] } : b)),
    beside: e.beside,
    working,
    shows: e.shows.map((x) => {
      const media = mediaIn(x.value, typeOf);
      return { version: x.version, value: x.value, ...(media ? { media } : {}), ...(x.verdict ? { verdict: x.verdict } : {}) };
    }),
    ...(s ? { suggested: s } : {}),
    batch: `${e.run}:${e.key.replace(/\[[^\]]*\]/g, "[]")}`,
    ...(/\[([^\]]+)\][^[]*$/.test(e.key) ? { item: /\[([^\]]+)\][^[]*$/.exec(e.key)![1]! } : {}),
  };
}

/**
 * The picture, clip or sound in what a screen shows: the value itself, or, for
 * a generated approval that shows a step's whole output (`{ clip: "blob:…" }`),
 * its first file. Without this a clip's approval was a line of JSON.
 */
export function mediaIn(value: unknown, typeOf: (hash: string) => string | undefined): { url: string; type: string } | undefined {
  const values = typeof value === "string" ? [value] : value && typeof value === "object" && !Array.isArray(value) ? Object.values(value) : [];
  for (const v of values) {
    const hash = typeof v === "string" ? /^blob:([0-9a-f]{64})$/.exec(v)?.[1] : undefined;
    const type = hash ? typeOf(hash) : undefined;
    if (hash && type) return { url: `/api/media/${hash}`, type };
  }
  return undefined;
}

const VERBS: Record<string, string> = {
  "image.generate": "draws",
  "image.edit": "edits",
  "video.from_image": "animates",
  "audio.speech": "voices",
  "audio.music": "scores",
  "llm.write": "writes",
  "llm.vision": "looks",
  "llm.research": "researches the web",
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

/** A recipe's arrows for the graph: one per source, with the words on it and loops marked. */
function arrows(g: Project["graphs"][number]) {
  return g.edges.flatMap((e) =>
    (Array.isArray(e.from) ? e.from : [e.from]).map((from) => ({
      from,
      to: e.to,
      ...(e.when ? { label: edgeLabel(e.when) } : Array.isArray(e.from) && e.from.length > 1 ? { label: "wait for all" } : {}),
      ...(e.max_loops !== undefined ? { back: true, limit: e.max_loops } : {}),
    })),
  );
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

/** A plain page for a person (pairing), in the app's look. */
function page(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>kriya</title><body style="font-family:system-ui,sans-serif;background:#f5f4f0;color:#1c1b19;padding:32px;max-width:520px;margin:auto;line-height:1.5"><h1 style="font-size:22px">kriya</h1><p>${text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!).replace(/`([^`]+)`/g, "<code>$1</code>")}</p></body>`);
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
