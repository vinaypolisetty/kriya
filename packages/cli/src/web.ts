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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, sniff, suggestFix } from "@kriya/adapters";
import { openStore, type Store } from "@kriya/store";
import type { RunState } from "@kriya/engine";
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
  buttons: (Entry["buttons"][number] & { estimateUsd?: number })[];
  /** What the recipe puts beside the candidates: the line to be said, its caption, the shot's action. */
  beside: Entry["beside"];
  shows: { version: string; value: unknown; media?: { url: string; type: string }; verdict?: Entry["shows"][number]["verdict"] }[];
  suggested?: { action: string; selection?: string[]; note?: string; region?: unknown; why: string };
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

export async function startWeb(first: Project, opts: WebOptions): Promise<Web> {
  const store = openStore(join(first.root, ".kriya"));
  const token = opts.lan ? pairingToken(first.root) : undefined;
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const local = (req: IncomingMessage) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  const paired = (req: IncomingMessage) => {
    if (!token) return true; // only this machine can reach it
    if (local(req) && opts.trustLoopback !== false) return true;
    const cookie = /(?:^|;\s*)kriya_pair=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return cookie !== undefined && same(decodeURIComponent(cookie), token);
  };
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
  const inbox = async (): Promise<WebItem[]> => {
    const project = current();
    const entries = await allInbox(project, store, quiet, { readOnly: true });
    const states = new Map<string, RunState>();
    for (const e of entries) if (!states.has(e.run)) states.set(e.run, (await openRun(project, store, e.run, quiet, { readOnly: true })).rec.state);
    return entries.map((e) => web(e, busy.has(e.run), typeOf, estimates(project, states.get(e.run)!, e.key)));
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
    if (token && url.pathname === "/pair") {
      if (!same(url.searchParams.get("token") ?? "", token)) return page(res, 403, "That pairing link isn't right. Open the one `kriya web --lan` printed (or scan its QR code) on this phone.");
      res.writeHead(302, { "set-cookie": `kriya_pair=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}`, location: "/" });
      return res.end();
    }
    if (!paired(req)) {
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "this device isn't paired: open the link `kriya web --lan` printed, or scan its QR code" });
      return page(res, 401, "This phone isn't paired with kriya yet. On the computer running `kriya web --lan`, scan the QR code (or open the link it printed) with this phone.");
    }
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
      clearInterval(ticker);
      for (const c of clients) c.end();
      await new Promise<void>((ok) => server.close(() => ok()));
      await queue;
      store.close();
    },
  };
}

/** An inbox entry for the browser: blobs as media URLs, the suggested fix, and whether its run is still working. */
/**
 * What each of a screen's buttons will cost, before you press it: the step its
 * arrow leads to, times what that step's candidates have cost in this run so
 * far. A step that hasn't run yet has no estimate (rather than a guess).
 */
export function estimates(project: Project, state: RunState, key: string): Record<string, number> {
  // Walk down for-each items to the recipe the screen is in: `per_shot[P3-04].pick` → shot_recipe, `per_shot[P3-04].`.
  let g = project.graphs.find((x) => x.graph === state.graph);
  let prefix = "";
  for (const [, mapId, item] of key.matchAll(/(\w+)\[([^\]]+)\]\./g)) {
    const map = g?.nodes.find((n) => n.id === mapId);
    if (!map || map.kind !== "map") return {};
    prefix += `${mapId}[${item}].`;
    g = project.graphs.find((x) => x.graph === map.graph);
  }
  if (!g) return {};
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

function web(e: Entry, working: boolean, typeOf: (hash: string) => string | undefined, cost: Record<string, number> = {}): WebItem {
  const s = suggestFix({ actions: e.buttons }, e.shows);
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
      const hash = typeof x.value === "string" ? /^blob:([0-9a-f]{64})$/.exec(x.value)?.[1] : undefined;
      const type = hash ? typeOf(hash) : undefined;
      return { version: x.version, value: x.value, ...(hash && type ? { media: { url: `/api/media/${hash}`, type } } : {}), ...(x.verdict ? { verdict: x.verdict } : {}) };
    }),
    ...(s ? { suggested: s } : {}),
    batch: `${e.run}:${e.key.replace(/\[[^\]]*\]/g, "[]")}`,
    ...(/\[([^\]]+)\][^[]*$/.test(e.key) ? { item: /\[([^\]]+)\][^[]*$/.exec(e.key)![1]! } : {}),
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
