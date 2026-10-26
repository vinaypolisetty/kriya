/**
 * `kriya web` (Day 22, D-65): the review inbox in a browser. A small HTTP
 * server over the same project and store the commands use, so the browser and
 * the terminal can't disagree:
 *
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
import type { Project } from "./project.js";

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

export async function startWeb(project: Project, opts: { port?: number; host?: string; io: IO }): Promise<Web> {
  const store = openStore(join(project.root, ".kriya"));
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
  const inbox = async (): Promise<WebItem[]> => (await allInbox(project, store, quiet, { readOnly: true })).map((e) => web(e, busy.has(e.run), typeOf));

  const decide = async (body: { run?: unknown; key?: unknown; action?: unknown; selection?: unknown; note?: unknown; region?: unknown }) => {
    const { run, key, action } = body;
    if (typeof run !== "string" || typeof key !== "string" || typeof action !== "string") throw new BadRequest("say which run, step and button: { run, key, action }");
    const answered = queue.then(async () => {
      const { s, jobs } = await openRun(project, store, run, quiet);
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
    if (req.method === "GET" && url.pathname === "/api/inbox") return json(res, 200, { project: project.settings.name, items: await inbox() });
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
