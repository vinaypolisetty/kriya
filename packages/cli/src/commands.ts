/**
 * The kriya commands. Each one is a separate process: it opens the run from
 * `.kriya/kriya.db`, calls `recover()` (so a closed terminal or a crash loses
 * nothing), does one thing, and exits. Written as functions so tests can call
 * them directly.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { formatProblems, Recorder, Scheduler, suggest, type Blobs, type Judged, type Executors, type InboxItem, type NodeState, type RunState } from "@kriya/engine";
import { anthropicExecutors, describeError, EXT, Jobs, mediaTools, MIME, sniff, suggestFix, MissingKey, MissingToken, replicateExecutors, settle, type Ledger, type Media, type ReplicateCapability } from "@kriya/adapters";
import { createHash } from "node:crypto";
import { openStore, type Store } from "@kriya/store";
import { fakeExecutors, fakeTools } from "./fake.js";
import { libraryAssets } from "./library.js";
import { loadProject, releaseOf, UserError, type Project } from "./project.js";

export type IO = { out: (line: string) => void; err: (line: string) => void; cwd: string };

const HELP = `kriya: run recipes with people in the loop

  kriya init <folder> [--example <name>]          start a project (examples: kriya init --examples)
  kriya run <recipe> [--input name=value]… [--id name]
                                                  start a run (models from kriya.yaml: fake, anthropic, replicate)
  kriya status [run]                              your runs, or one run's steps
  kriya show <run> [step] [version]               what a run made: every step, or one step's full output
  kriya inbox                                     what's waiting on you
  kriya decide <item> <button> [--pick v] [--note text] [--region x,y,w,h]
                                                  answer an inbox item (its number, or run:step)
  kriya lock <run> <step> <version> [--why text]  lock a version yourself
  kriya rebuild <run>                             redo the run's stale work
  kriya retry <run> <step>                        try a failed step again (a new attempt)
  kriya web [--port 4317] [--lan]                 kriya in your browser, live; --lan pairs your phone over wifi
  kriya check <run> <step>                        judge a step's latest candidates against its rubric again
  kriya library [entity]                          the Library: who's in it, what each is missing, every version
  kriya adopt <run> <step> <base> <from> --note text
                                                  merge two versions: base, taking what the note says from <from>

Values starting with @ are read from a file: --input story_pages=@pages.txt`;

export async function main(argv: string[], io: IO): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "init": return await init(rest, io);
      case "run": return await run(rest, io);
      case "status": return await status(rest, io);
      case "show": return await show(rest, io);
      case "inbox": return await inbox(io);
      case "decide": return await decide(rest, io);
      case "lock": return await lock(rest, io);
      case "rebuild": return await rebuild(rest, io);
      case "retry": return await retry(rest, io);
      case "adopt": return await adopt(rest, io);
      case "library": return await library(rest, io);
      case "check": return await check(rest, io);
      case "web": return await webCommand(rest, io);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;
      default:
        throw new UserError(`there's no command '${command}'. Try: kriya help`);
    }
  } catch (e) {
    if (e instanceof UserError) {
      io.err(`✗ ${e.message}`);
      return 1;
    }
    if (e instanceof Error && !(e instanceof TypeError) && !(e instanceof ReferenceError)) {
      io.err(`✗ ${e.message}`); // engine errors are written for people too
      return 1;
    }
    throw e;
  }
}

// ── init ────────────────────────────────────────────────────────────────────

const EXAMPLES = fileURLToPath(new URL("../../../examples", import.meta.url));

const EXAMPLE_CONTEXT: Record<string, ProjectContext> = {
  "mohalla-mitra": {
    series: {
      style: "2D Indian cartoon, flat colors, warm afternoon light",
      rules: "Original Bollywood-style music only; Hinglish voices, English captions",
      cast: ["Mitra", "Bheem", "Pinki", "Tinku", "Pinku", "Kamla", "Biscuit"],
      music: { main: "music/main-theme.mp3", clue: "music/emotional-clue.mp3", villain: "music/villain.mp3", chase: "music/comedy-chase.mp3" },
    },
  },
};
type ProjectContext = Record<string, Record<string, unknown>>;

/** The example projects that ship with kriya: one folder each under examples/. */
function examples(): string[] {
  return readdirSync(EXAMPLES).filter((d) => statSync(join(EXAMPLES, d)).isDirectory()).sort();
}

function init(args: string[], io: IO): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { example: { type: "string" }, examples: { type: "boolean" } } });
  if (values.examples) {
    io.out(`Examples: ${examples().join(", ")}`);
    return 0;
  }
  const folder = positionals[0];
  if (!folder) throw new UserError("say which folder to create: kriya init <folder>");
  const root = resolve(io.cwd, folder);
  if (existsSync(join(root, "kriya.yaml"))) throw new UserError(`'${folder}' already has a kriya.yaml`);
  const example = values.example;
  if (example && !examples().includes(example)) throw new UserError(`there's no example called '${example}'. Examples: ${examples().join(", ")}`);

  mkdirSync(join(root, "recipes"), { recursive: true });
  mkdirSync(join(root, "library"), { recursive: true });
  if (example) cpSync(join(EXAMPLES, example), join(root, "recipes"), { recursive: true });
  const settings = {
    name: basename(root),
    models: "fake",
    recipes: "recipes",
    context: example ? (EXAMPLE_CONTEXT[example] ?? {}) : {},
    kinds: { character: ["look", "voice", "speech", "rules"], place: ["look"], music: ["track"] },
  };
  writeFileSync(join(root, "kriya.yaml"), `# kriya project settings\n${stringify(settings)}`);
  writeFileSync(join(root, ".gitignore"), ".kriya/\n.env\n");
  io.out(`✓ Created ${folder}${example ? ` with the ${example} recipes` : ""}`);
  io.out(example ? `  Next: cd ${folder} && kriya run part_recipe --input part_no=3 --input story_pages="…"` : `  Next: add a recipe to ${folder}/recipes/`);
  return 0;
}

// ── run ─────────────────────────────────────────────────────────────────────

async function run(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { input: { type: "string", multiple: true, default: [] }, id: { type: "string" } },
  });
  const project = checkedProject(io);
  const recipe = positionals[0];
  if (!recipe) throw new UserError(`say which recipe to run: kriya run <recipe> (you have: ${project.graphs.map((g) => g.graph).join(", ")})`);
  const graph = project.graphs.find((g) => g.graph === recipe);
  if (!graph) throw new UserError(`there's no recipe '${recipe}' (you have: ${project.graphs.map((g) => g.graph).join(", ")})`);

  const inputs = parseInputs(values.input ?? [], graph.inputs, io.cwd, recipe);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const runs = store.events.runs();
    const id = values.id ?? `${recipe}-${runs.filter((r) => r.startsWith(`${recipe}-`)).length + 1}`;
    if (runs.includes(id)) throw new UserError(`there's already a run called '${id}'`);
    const rec = Recorder.start(store.events, id);
    const { s, jobs } = scheduler(project, graph.graph, rec, store);
    s.start(releaseOf(project.graphs, graph.graph), inputs, project.settings.context);
    io.out(`✓ Started ${id} (${recipe})`);
    await drive(s, jobs, io);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

function parseInputs(pairs: string[], declared: Record<string, string>, cwd: string, recipe: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new UserError(`--input needs name=value, got '${pair}'`);
    const name = pair.slice(0, eq);
    let raw = pair.slice(eq + 1);
    const type = declared[name];
    if (!type) throw new UserError(`'${recipe}' has no input '${name}' (it takes: ${Object.keys(declared).join(", ") || "none"})`);
    if (raw.startsWith("@")) raw = readFileSync(resolve(cwd, raw.slice(1)), "utf8");
    if (type === "number") {
      if (Number.isNaN(Number(raw))) throw new UserError(`input '${name}' is a number, got '${raw}'`);
      inputs[name] = Number(raw);
    } else if (type === "boolean") inputs[name] = raw === "true" || raw === "yes";
    else if (type === "json" || type.startsWith("list<")) {
      try { inputs[name] = JSON.parse(raw); } catch { throw new UserError(`input '${name}' should be JSON, got '${raw}'`); }
    } else inputs[name] = raw;
  }
  const missing = Object.keys(declared).filter((k) => !(k in inputs));
  if (missing.length) throw new UserError(`'${recipe}' needs ${missing.map((m) => `--input ${m}=…`).join(" ")}`);
  return inputs;
}

// ── status ──────────────────────────────────────────────────────────────────

async function status(args: string[], io: IO): Promise<number> {
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const runs = store.events.runs();
    const id = args[0];
    if (!id) {
      if (runs.length === 0) io.out("No runs yet. Start one with: kriya run <recipe>");
      for (const r of runs) {
        const { rec, s, changed } = await openRun(project, store, r, io, { quiet: true });
        io.out(`${r.padEnd(24)} ${rec.state.graph.padEnd(16)} ${summary(rec.state, s.inbox().length)}${changed ? " · recipes changed" : ""}`);
      }
      return 0;
    }
    const { rec, s } = await openRun(project, store, id, io);
    io.out(`${id} · ${rec.state.graph} · ${summary(rec.state, s.inbox().length)}`);
    for (const key of s.steps()) io.out(`  ${line(key, rec.state.nodes[key]!)}`);
    const failed = s.steps().filter((k) => rec.state.nodes[k]!.status === "failed" && !s.steps().some((o) => o.startsWith(`${k}[`) && rec.state.nodes[o]!.status === "failed"));
    if (failed.length) io.out(`  Try again: ${failed.map((k) => `kriya retry ${id} '${k}'`).join("  ·  ")}`);
    return 0;
  } finally {
    store.close();
  }
}

function line(key: string, n: NodeState): string {
  const locked = n.locked ? ` · locked ${n.locked.version}${n.locked.why ? ` ("${n.locked.why}")` : ""}` : "";
  switch (n.status) {
    case "completed":
    case "locked": return `✓ ${key}${locked}`;
    case "awaiting_human": return `⏸ ${key} · waiting on you`;
    case "waiting_external": return `⏳ ${key} · waiting on a model job`;
    case "blocked": return `⛔ ${key} · ${n.blockedReason}`;
    case "stale": return `↻ ${key} · stale: ${n.staleReason}${locked}`;
    case "failed": return `✗ ${key} · ${n.failure}`;
    default: return `· ${key} · ${n.status}`;
  }
}

function summary(state: RunState, waiting: number): string {
  const stale = Object.values(state.nodes).filter((n) => n.status === "stale").length;
  if (state.status !== "running") return [state.status, stale ? `${stale} stale` : ""].filter(Boolean).join(" · ");
  const blocked = Object.values(state.nodes).filter((n) => n.status === "blocked").length;
  return ["running", waiting ? `${waiting} waiting on you` : "", blocked ? `${blocked} blocked` : "", stale ? `${stale} stale` : ""].filter(Boolean).join(" · ");
}

// ── show ────────────────────────────────────────────────────────────────────

/** What a run made: every step with its versions, or one version's full output (and an agent's turns). */
async function show(args: string[], io: IO): Promise<number> {
  const [id, step, version] = args;
  if (!id) throw new UserError("say which run: kriya show <run> [step] [version]");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec, s } = await openRun(project, store, id, io);
    const state = rec.state;
    if (!step) {
      io.out(`${id} · ${state.graph} · ${summary(state, s.inbox().length)} · spent ${usd(state.costUsd)}`);
      for (const key of s.steps()) {
        const n = state.nodes[key]!;
        const versions = Object.values(n.versions).map((v) => `${v.id}${n.locked?.version === v.id ? " 🔒" : ""}${v.model ? ` ${v.model}` : ""}${v.costUsd ? ` ${usd(v.costUsd)}` : ""}`);
        const turns = n.turns ? ` · ${n.turns} turn${n.turns === 1 ? "" : "s"}` : "";
        io.out(`  ${line(key, n)}${turns}${versions.length ? `\n      versions: ${versions.join(" · ")}` : ""}`);
      }
      io.out(`  See one step in full: kriya show ${id} <step>`);
      return 0;
    }
    const n = state.nodes[step];
    if (!n) throw new UserError(`run '${id}' has no step '${step}' (it has: ${s.steps().join(", ")})`);
    const ids = Object.keys(n.versions);
    const v = n.versions[version ?? n.locked?.version ?? ids.at(-1) ?? ""];
    if (version && !v) throw new UserError(`'${step}' has no version ${version} (it has: ${ids.join(", ") || "none yet"})`);

    io.out(`${id} › ${step} · ${line(step, n).replace(/^\S+ \S+ ?·? ?/, "") || n.status}`);
    if (n.history.length) {
      const blobs = jsonBlobs(store);
      const cost = n.history.reduce((t, h) => t + h.cost, 0);
      io.out(`\nTurns (${n.history.length}, ${usd(cost)}):`);
      for (const h of n.history) {
        const r = h.response as { final?: unknown };
        if (r.final !== undefined) io.out(`  ${String(h.turn).padStart(2)}  finish`);
        for (const c of h.calls) {
          const result = c.result ? preview(blobs.get(c.result)) : "…waiting";
          io.out(`  ${String(h.turn).padStart(2)}  ${c.tool} ${preview(c.args)}\n        ${c.ok === false ? "✗" : "→"} ${result}`);
        }
      }
    }
    if (!v) {
      io.out("\nNo versions yet.");
      return 0;
    }
    const about = [
      n.locked?.version === v.id ? "🔒 locked" : "not locked",
      v.model,
      v.costUsd ? usd(v.costUsd) : undefined,
      v.madeBy ? `made by ${v.madeBy}` : undefined,
      v.parents.length ? `from ${v.parents.join(" + ")}` : undefined,
      v.instruction ? `"${v.instruction}"` : undefined,
      v.branch !== "main" ? `branch ${v.branch}` : undefined,
    ].filter(Boolean);
    io.out(`\nVersion ${v.id} · ${about.join(" · ")}${ids.length > 1 ? `  (others: ${ids.filter((x) => x !== v.id).join(", ")})` : ""}\n`);
    io.out(stringify(v.output, { lineWidth: 0 }).trimEnd());
    if (v.prompt !== undefined) io.out(`\nPrompt:\n${v.prompt.replace(/^/gm, "  ")}`);
    if (v.references?.length) io.out(`\nReferences:\n${v.references.map((r, i) => `  ${i + 1}. ${r.label} · ${r.ref.startsWith("sha256:") ? r.ref.slice(0, 19) : r.ref}`).join("\n")}`);
    const files = viewable(project, store, v.output);
    if (files.length) io.out(`\nOpen the files:\n${files.map((p) => `  ${p}`).join("\n")}`);
    return 0;
  } finally {
    store.close();
  }
}

/** Every `blob:` file in an output (images, clips, audio), copied to `.kriya/view/<hash>.<ext>` so it opens in a viewer or player. */
function viewable(project: Project, store: Store, output: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && /^blob:[0-9a-f]{64}$/.test(v)) found.push(v.slice(5));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(output);
  const dir = join(project.root, ".kriya", "view");
  return found.flatMap((hash) => {
    const bytes = store.blobs.get(hash);
    if (!bytes) return [];
    const ext = EXT[sniff(bytes)] ?? "bin";
    const file = join(dir, `${hash.slice(0, 12)}.${ext}`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, bytes);
    }
    return [relative(project.root, file)];
  });
}

/** A candidate's checks in one line: ✓, or ✗ and each issue with where it is and the fix. */
function verdictLine(v: { pass: boolean; issues: { type: string; what?: string; where?: string; fix?: string }[] }): string {
  if (v.pass) return "✓ checks passed";
  return `✗ ${v.issues.map((i) => `${i.what ?? i.type}${i.where ? ` (${i.where})` : ""}${i.fix ? ` → ${i.fix}` : ""}`).join("; ")}`;
}

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

// ── inbox and decide ────────────────────────────────────────────────────────

export type Entry = InboxItem & { run: string };

async function inbox(io: IO): Promise<number> {
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const entries = await allInbox(project, store, io);
    if (entries.length === 0) io.out("Nothing is waiting on you.");
    entries.forEach((e, i) => {
      io.out(`${String(i + 1).padStart(2)}  ${e.run} · ${e.key}: ${e.title}`);
      for (const s of e.shows) io.out(`      ${s.version}  ${preview(s.value)}${s.verdict ? `  ${verdictLine(s.verdict)}` : ""}`);
      io.out(`      buttons: ${e.buttons.map(button).join(" · ")}`);
      const s = suggestFix({ actions: e.buttons }, e.shows);
      if (s) io.out(`      suggested: ${s.why}\n        kriya decide ${i + 1} ${s.action}${s.selection ? ` --pick ${s.selection[0]}` : ""}${s.region ? ` --region ${String(s.region)}` : ""}${s.note ? ` --note ${JSON.stringify(s.note)}` : ""}`);
    });
    return 0;
  } finally {
    store.close();
  }
}

function button(b: InboxItem["buttons"][number]): string {
  const needs = b.needs.map((n) => (n === "selection" ? "--pick" : `--${n}`));
  return `${b.id}${needs.length ? ` (${needs.join(" ")})` : ""}${b.locks ? " 🔒" : ""}`;
}

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 72 ? `${s.slice(0, 69)}…` : s;
}

async function decide(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { pick: { type: "string" }, note: { type: "string" }, region: { type: "string" } } });
  const [item, action] = positionals;
  if (!item || !action) throw new UserError("say which item and which button: kriya decide <item> <button>");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const entries = await allInbox(project, store, io);
    const entry = /^\d+$/.test(item) ? entries[Number(item) - 1] : entries.find((e) => `${e.run}:${e.key}` === item);
    if (!entry) throw new UserError(`there's no inbox item '${item}'. See them with: kriya inbox`);
    // Your answer is recorded before anything else runs, so an automatic screen can't answer in your place.
    const { rec, s, jobs } = await openRun(project, store, entry.run, io, { readOnly: true });
    // A button that needs a pick, with exactly one option on show: that's the pick.
    const needsPick = entry.buttons.find((b) => b.id === action)?.needs.includes("selection");
    const pick = values.pick ?? (needsPick && entry.shows.length === 1 ? entry.shows[0]!.version : undefined);
    s.answer(entry.key, {
      action,
      ...(pick ? { selection: [pick] } : {}),
      ...(values.note ? { note: values.note } : {}),
      ...(values.region ? { region: values.region } : {}),
      by: "human",
    });
    io.out(`✓ ${action} on ${entry.key}`);
    s.recover();
    await drive(s, jobs, io);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

export async function allInbox(project: Project, store: Store, io: IO, opts: { readOnly?: boolean } = {}): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const r of store.events.runs()) {
    const { s, rec } = await openRun(project, store, r, io, { quiet: true, ...opts });
    if (rec.state.status === "running") entries.push(...s.inbox().map((i) => ({ ...i, run: r })));
  }
  return entries;
}

// ── lock ────────────────────────────────────────────────────────────────────

async function lock(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { why: { type: "string" } } });
  const [id, step, version] = positionals;
  if (!id || !step || !version) throw new UserError("say which run, step and version: kriya lock <run> <step> <version>");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec, s, jobs } = await openRun(project, store, id, io);
    s.lock(step, version, values.why);
    io.out(`✓ Locked ${step} to ${version}`);
    const stale = s.stale();
    if (stale.length === 0) await drive(s, jobs, io); // nothing to redo: the run settles again
    if (stale.length) {
      io.out(`  ${stale.length} step${stale.length === 1 ? "" : "s"} went stale:`);
      for (const x of stale) io.out(`    ↻ ${x.key}: ${x.reason}`);
    }
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

async function rebuild(args: string[], io: IO): Promise<number> {
  const [id] = args;
  if (!id) throw new UserError("say which run: kriya rebuild <run>");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec, s, jobs } = await openRun(project, store, id, io);
    const started = s.rebuild();
    if (started.length === 0) io.out("Nothing is stale; there's nothing to rebuild");
    else io.out(`✓ Rebuilding from ${started.join(", ")}`);
    await drive(s, jobs, io);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

async function retry(args: string[], io: IO): Promise<number> {
  const [id, step] = args;
  if (!id || !step) throw new UserError("say which run and step: kriya retry <run> <step> (kriya status <run> lists the failed ones)");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec, s, jobs } = await openRun(project, store, id, io);
    io.out(`✓ Retrying ${s.retry(step).join(", ")}`);
    await drive(s, jobs, io);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

// ── web ─────────────────────────────────────────────────────────────────────

/** Serves the review inbox until you stop it (Ctrl+C). */
async function webCommand(args: string[], io: IO): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string" }, lan: { type: "boolean" } } });
  const project = checkedProject(io);
  const port = values.port ? Number(values.port) : 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError(`--port should be a number like 4317, not '${values.port}'`);
  const { startWeb } = await import("./web.js");
  const w = await startWeb(project, { port, io, ...(values.lan ? { lan: true } : {}) });
  io.out(`✓ kriya is at ${w.url}  (Ctrl+C to stop)`);
  if (w.lan) {
    const { default: QR } = await import("qrcode");
    io.out(`\nOn your phone (same wifi), scan this once to pair it, or open:\n  ${w.lan.pair}\n`);
    io.out(await QR.toString(w.lan.pair, { type: "terminal", small: true }));
    if (w.lan.urls.length > 1) io.out(`Also reachable at: ${w.lan.urls.slice(1).join(", ")}`);
    io.out("Anyone on this network with the link can review and decide; keep it to your own devices.");
  }
  await new Promise<void>((done) => process.once("SIGINT", () => void w.close().then(done)));
  return 0;
}

// ── check ───────────────────────────────────────────────────────────────────

/** Judges a step's latest candidates against its rubric again, e.g. after the rubric changed. Locks don't move. */
async function check(args: string[], io: IO): Promise<number> {
  const [id, step] = args;
  if (!id || !step) throw new UserError("say which run and step: kriya check <run> <step>");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec, s } = await openRun(project, store, id, io);
    const { node, ctx, candidates } = s.checkRequest(step);
    const jobs = new Jobs();
    const judge = executors(project, store, jobs, fakeTools()).check!;
    const first = judge(node, ctx, candidates);
    io.out(`  ⏳ judging ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}…`);
    const judged = Array.isArray(first) ? first : await jobs.next().then((r) => {
      if (!r.ok) throw new UserError(`the judge couldn't answer: ${describeError(r.error)}`);
      return r.value as Judged[];
    });
    s.recordVerdicts(step, judged);
    for (const j of judged) io.out(`  ${j.version}  ${verdictLine(j)}`);
    const spent = judged.reduce((a, j) => a + (j.cost_usd ?? 0), 0);
    if (spent) io.out(`  spent ${usd(spent)}`);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

// ── library ─────────────────────────────────────────────────────────────────

/** Who's in the Library, by kind, with each facet's version and what's missing; or one entity's facets and every version. */
async function library(args: string[], io: IO): Promise<number> {
  const project = loadProject(io.cwd);
  const lib = project.library;
  const store = openStore(join(project.root, ".kriya"));
  try {
    const assets = libraryAssets(lib, project.root, store, false);
    const kinds = project.settings.kinds;
    const version = (name: string, facet: string) => {
      const r = assets.resolve(name, facet);
      if (!r) return undefined;
      if ("missing" in r) return `${facet} ✗ (${r.missing.join(", ")} isn't there)`;
      return `${facet} v${store.library.history(name, facet).find((v) => v.version === r.version)!.n}`;
    };
    const [name] = args;
    if (!name) {
      if (lib.entities.size === 0) io.out("The Library is empty. Add one file per character, place or track to library/, e.g. library/mitra.yaml:\n  name: Mitra\n  kind: character\n  look: { image: sheets/mitra.png, words: a thin 60-year-old bald man }\n  voice: Charon");
      const groups = new Map<string, string[]>();
      for (const e of lib.entities.values()) groups.set(e.kind ?? "(no kind)", [...(groups.get(e.kind ?? "(no kind)") ?? []), e.name]);
      const width = Math.max(0, ...[...lib.entities.keys()].map((n) => n.length));
      for (const [kind, names] of groups) {
        io.out(kind);
        for (const n of names) {
          const e = lib.entities.get(n)!;
          const have = Object.keys(e.facets).map((f) => version(n, f)!);
          const missing = (kinds[kind] ?? []).filter((f) => !(f in e.facets));
          io.out(`  ${n.padEnd(width)}  ${[...have, missing.length ? `needs: ${missing.join(", ")}` : ""].filter(Boolean).join(" · ")}`);
        }
      }
    } else {
      const e = lib.entities.get(name);
      if (!e) throw new UserError(`there's no '${name}' in the Library${suggest(name, [...lib.entities.keys()])} See who's there with: kriya library`);
      io.out(`${e.name}${e.kind ? ` · ${e.kind}` : ""} · ${e.file}`);
      for (const f of Object.keys(e.facets)) {
        const current = assets.resolve(name, f);
        io.out(`\n  ${version(name, f)}`);
        for (const v of [...store.library.history(name, f)].reverse()) {
          const now = current && "version" in current && current.version === v.version;
          io.out(`    v${v.n} · ${v.at.slice(0, 10)}${now ? " · current" : ""} · ${brief(v.value)}`);
        }
      }
    }
    for (const p of lib.problems) io.err(`✗ ${p}`);
    return lib.problems.length ? 1 : 0;
  } finally {
    store.close();
  }
}

/** A facet value in one line: words cut short, files as they are. */
function brief(v: unknown): string {
  const s = typeof v === "string" ? v : Object.entries((v ?? {}) as Record<string, unknown>).map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`).join(" · ");
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

async function adopt(args: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { note: { type: "string" } } });
  const [id, step, base, from] = positionals;
  if (!id || !step || !base || !from) throw new UserError("say which run, step and two versions: kriya adopt <run> <step> <base> <from> --note text");
  if (!values.note) throw new UserError(`say what to take from ${from} with --note, e.g. --note "use its sky"`);
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec, s } = await openRun(project, store, id, io);
    const made = s.adopt(step, base, from, values.note);
    io.out(`✓ Adopted into ${step}: ${made.join(", ")} (from ${base}, taking from ${from}). Nothing is locked yet`);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

// ── shared ──────────────────────────────────────────────────────────────────

export function checkedProject(io: IO): Project {
  const project = loadProject(io.cwd);
  const errors = project.problems.filter((p) => p.severity === "error");
  if (errors.length) throw new UserError(`your recipes have problems:\n${formatProblems(errors)}`);
  if (project.library.problems.length) throw new UserError(`your Library has problems:\n${project.library.problems.map((p) => `  ${p}`).join("\n")}`);
  return project;
}

function scheduler(project: Project, graphId: string, rec: Recorder, store: Store): { s: Scheduler; jobs: Jobs } {
  const graph = project.graphs.find((g) => g.graph === graphId);
  if (!graph) throw new UserError(`this run uses recipe '${graphId}', which isn't in your recipes any more`);
  const jobs = new Jobs();
  const tools = fakeTools();
  const s = new Scheduler(graph, rec, executors(project, store, jobs, tools), project.graphs, {
    assets: assetsOf(project, store),
    tools,
    blobs: jsonBlobs(store),
  });
  return { s, jobs };
}

/** One view of the Library per command, so its files are hashed once however many runs it opens. */
const assetsCache = new WeakMap<Project, ReturnType<typeof libraryAssets>>();
function assetsOf(project: Project, store: Store): ReturnType<typeof libraryAssets> {
  let a = assetsCache.get(project);
  if (!a) assetsCache.set(project, (a = libraryAssets(project.library, project.root, store, realMedia(project).length === 0)));
  return a;
}

/** How many times a `trust: when_confident` screen presses its own buttons before it asks you. */
const AUTO_ROUNDS = 3;

/**
 * Screens wait for `kriya decide`, except a `trust: when_confident` screen,
 * which follows its checks for a few rounds (D-64): locks a candidate that
 * passed, or presses the fix the knowledge base suggests.
 */
const autoDecide: Executors["decide"] = (node, ctx) => {
  if (node.trust !== "when_confident" || ctx.visit > AUTO_ROUNDS) return undefined;
  const s = suggestFix(node, ctx.shows ?? []);
  if (!s) return undefined;
  const { why: _w, ...d } = s;
  return { ...d, by: "auto" };
};

/** Steps of each kind of media that Replicate runs, from `models:` in kriya.yaml. */
const MEDIA: Record<"image" | "video" | "audio", ReplicateCapability[]> = {
  image: ["image.generate", "image.edit"],
  video: ["video.from_image"],
  audio: ["audio.speech", "audio.music"],
};
const realMedia = (project: Project): ReplicateCapability[] =>
  (Object.keys(MEDIA) as (keyof typeof MEDIA)[]).flatMap((k) => (project.settings.models[k] === "replicate" ? MEDIA[k] : []));

/**
 * Which models run the steps. `fake` (the default) makes up outputs, no keys, no
 * cost. `anthropic` sends text, vision and agent steps to Claude; `replicate`
 * runs images, clips and audio, per kind (keys from `.env`).
 */
function executors(project: Project, store: Store, jobs: Jobs, tools: ReturnType<typeof fakeTools>): Executors {
  const fake = fakeExecutors(project.graphs);
  const models = project.settings.models;
  const media = realMedia(project);
  const toolRun = project.settings.tools;
  if (models.llm !== "anthropic" && media.length === 0 && toolRun === "fake") return { ...fake, decide: autoDecide };
  const env = join(project.root, ".env");
  if (existsSync(env)) process.loadEnvFile(env); // keys already in the environment win
  const real = [
    ...(models.llm === "anthropic" ? [anthropicExecutors({ graphs: project.graphs, jobs, tools, media: projectMedia(project, store), ...(project.settings.claude ?? {}) })] : []),
    ...(toolRun !== "fake"
      ? [mediaTools({
          jobs,
          media: projectMedia(project, store),
          build: join(project.root, ".kriya", "build"),
          ...(toolRun.python ? { python: toolRun.python.replace(/^~(?=\/)/, homedir()) } : {}),
          ...(toolRun.font ? { font: resolve(project.root, toolRun.font) } : {}),
        })]
      : []),
    ...(media.length ? [replicateExecutors({ graphs: project.graphs, jobs, media: projectMedia(project, store), ledger: fileLedger(project), capabilities: media, ...(project.settings.replicate ? { models: project.settings.replicate } : {}) })] : []),
  ];
  const claude = models.llm === "anthropic" ? (real.find((r) => "turn" in r) as ReturnType<typeof anthropicExecutors>) : undefined;
  return {
    produce: (node, ctx) => (real.find((p) => p.handles(node)) ?? fake).produce(node, ctx),
    decide: autoDecide,
    turn: claude?.turn ?? fake.turn!,
    check: claude?.check ?? fake.check!,
    ...(claude ? { managesContext: true } : {}),
  };
}

/**
 * Media for providers and tools: `blob:<sha256>` from the store, image, audio
 * and video files inside the project (sheets, tracks), https URLs as they are.
 * Downloaded and made files go into the store.
 */
function projectMedia(project: Project, store: Store): Media {
  return {
    read(value) {
      if (value.startsWith("blob:")) {
        const bytes = store.blobs.get(value.slice(5));
        return bytes ? { bytes, mime: sniff(bytes) } : undefined;
      }
      if (/^https:\/\/\S+$/.test(value)) return { url: value };
      const ext = /\.(\w+)$/.exec(value)?.[1]?.toLowerCase();
      const path = resolve(project.root, value);
      if (!ext || !MIME[ext] || !path.startsWith(project.root + "/") || !existsSync(path)) return undefined;
      return { bytes: readFileSync(path), mime: MIME[ext]! };
    },
    write: (bytes) => `blob:${store.blobs.put(bytes).hash}`,
  };
}

/** Replicate prediction ids by idempotency key, one small file each in `.kriya/jobs/`. */
function fileLedger(project: Project): Ledger {
  const dir = join(project.root, ".kriya", "jobs");
  const file = (key: string) => join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  return {
    get: (key) => (existsSync(file(key)) ? (JSON.parse(readFileSync(file(key), "utf8")) as string[]) : undefined),
    set(key, ids) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(key), JSON.stringify(ids));
    },
  };
}

/** Runs until nothing is in flight: model calls are awaited and delivered, then the run carries on. */
export async function drive(s: Scheduler, jobs: Jobs, io: IO): Promise<void> {
  s.run();
  if (jobs.size > 0) io.out("  ⏳ waiting on the models…");
  await settle(s, jobs, describeError);
}

/** Tool results as JSON files in `.kriya/blobs/`, named by content hash, so a resumed agent reads them back. */
function jsonBlobs(store: Store): Blobs {
  return {
    put: (value) => store.blobs.put(Buffer.from(JSON.stringify(value ?? null))).hash,
    get(hash) {
      const b = store.blobs.get(hash);
      if (!b) throw new Error(`a stored tool result is missing from .kriya/blobs (${hash.slice(0, 12)}…)`);
      return JSON.parse(b.toString("utf8"));
    },
  };
}

/**
 * Opens a run in this process: replays its log and asks again for anything in
 * flight. `readOnly` only replays (the web inbox reads often; it must never
 * call a model or write).
 */
export async function openRun(project: Project, store: Store, id: string, io: IO, opts: { quiet?: boolean; readOnly?: boolean } = {}): Promise<{ rec: Recorder; s: Scheduler; jobs: Jobs; changed: boolean }> {
  if (store.events.read(id).length === 0) throw new UserError(`there's no run '${id}'. See your runs with: kriya status`);
  const rec = Recorder.resume(store.events, id);
  const changed = rec.state.release !== releaseOf(project.graphs, rec.state.graph);
  if (changed && !opts.quiet) {
    io.err(`! ${id}: its recipes changed since it started; it carries on with the current ones (run upgrades come later)`);
  }
  const { s, jobs } = scheduler(project, rec.state.graph, rec, store);
  if (opts.readOnly) return { rec, s, jobs, changed };
  // A sheet redrawn or a look reworded since the last command: the work that used it goes stale;
  // a look added since then lets the steps waiting for it go on.
  s.assetsChanged();
  s.unblock();
  if (rec.state.status === "running") {
    try {
      s.recover();
      await drive(s, jobs, io);
    } catch (e) {
      // A step waiting on Claude with no key: say so, and still show and answer everything else.
      if (!(e instanceof MissingKey) && !(e instanceof MissingToken)) throw e;
      io.err(`! ${id}: ${e.message}`);
    }
  }
  return { rec, s, jobs, changed };
}

function report(io: IO, state: RunState, waiting: InboxItem[]): void {
  io.out(`  ${summary(state, waiting.length)}`);
  if (state.status === "running" && waiting.length) io.out("  Next: kriya inbox");
}
