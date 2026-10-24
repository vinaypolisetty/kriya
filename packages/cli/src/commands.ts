/**
 * The kriya commands. Each one is a separate process: it opens the run from
 * `.kriya/kriya.db`, calls `recover()` (so a closed terminal or a crash loses
 * nothing), does one thing, and exits. Written as functions so tests can call
 * them directly.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { formatProblems, Recorder, Scheduler, type Blobs, type Executors, type InboxItem, type NodeState, type RunState } from "@kriya/engine";
import { anthropicExecutors, describeError, Jobs, MissingKey, MissingToken, replicateExecutors, settle, type Ledger, type Media } from "@kriya/adapters";
import { createHash } from "node:crypto";
import { openStore, type Store } from "@kriya/store";
import { fakeExecutors, fakeTools, projectAssets } from "./fake.js";
import { loadProject, releaseOf, UserError, type Project } from "./project.js";

export type IO = { out: (line: string) => void; err: (line: string) => void; cwd: string };

const HELP = `kriya: run recipes with people in the loop

  kriya init <folder> [--example <name>]          start a project (examples: kriya init --examples)
  kriya run <recipe> [--input name=value]… [--id name]
                                                  start a run (models from kriya.yaml: fake, or anthropic)
  kriya status [run]                              your runs, or one run's steps
  kriya show <run> [step] [version]               what a run made: every step, or one step's full output
  kriya inbox                                     what's waiting on you
  kriya decide <item> <button> [--pick v] [--note text] [--region x,y,w,h]
                                                  answer an inbox item (its number, or run:step)
  kriya lock <run> <step> <version> [--why text]  lock a version yourself
  kriya rebuild <run>                             redo the run's stale work
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
      case "adopt": return await adopt(rest, io);
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
  if (example) cpSync(join(EXAMPLES, example), join(root, "recipes"), { recursive: true });
  const settings = {
    name: basename(root),
    models: "fake",
    recipes: "recipes",
    context: example ? (EXAMPLE_CONTEXT[example] ?? {}) : {},
    library: {},
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
  if (state.status !== "running") return state.status;
  const stale = Object.values(state.nodes).filter((n) => n.status === "stale").length;
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
    const images = viewable(project, store, v.output);
    if (images.length) io.out(`\nOpen the images:\n${images.map((p) => `  ${p}`).join("\n")}`);
    return 0;
  } finally {
    store.close();
  }
}

/** Every `blob:` image in an output, copied to `.kriya/view/<hash>.<ext>` so it opens in an image viewer. */
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
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[sniff(bytes)] ?? "bin";
    const file = join(dir, `${hash.slice(0, 12)}.${ext}`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, bytes);
    }
    return [relative(project.root, file)];
  });
}

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

// ── inbox and decide ────────────────────────────────────────────────────────

type Entry = InboxItem & { run: string };

async function inbox(io: IO): Promise<number> {
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const entries = await allInbox(project, store, io);
    if (entries.length === 0) io.out("Nothing is waiting on you.");
    entries.forEach((e, i) => {
      io.out(`${String(i + 1).padStart(2)}  ${e.run} · ${e.key}: ${e.title}`);
      for (const s of e.shows) io.out(`      ${s.version}  ${preview(s.value)}`);
      io.out(`      buttons: ${e.buttons.map(button).join(" · ")}`);
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
    const { rec, s, jobs } = await openRun(project, store, entry.run, io);
    // A button that needs a pick, with exactly one option on show: that's the pick.
    const needsPick = entry.buttons.find((b) => b.id === action)?.needs.includes("selection");
    const pick = values.pick ?? (needsPick && entry.shows.length === 1 ? entry.shows[0]!.version : undefined);
    s.answer(entry.key, {
      action,
      ...(pick ? { selection: [pick] } : {}),
      ...(values.note ? { note: values.note } : {}),
      ...(values.region ? { region: values.region } : {}),
    });
    io.out(`✓ ${action} on ${entry.key}`);
    await drive(s, jobs, io);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

async function allInbox(project: Project, store: Store, io: IO): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const r of store.events.runs()) {
    const { s, rec } = await openRun(project, store, r, io, { quiet: true });
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

function checkedProject(io: IO): Project {
  const project = loadProject(io.cwd);
  const errors = project.problems.filter((p) => p.severity === "error");
  if (errors.length) throw new UserError(`your recipes have problems:\n${formatProblems(errors)}`);
  return project;
}

function scheduler(project: Project, graphId: string, rec: Recorder, store: Store): { s: Scheduler; jobs: Jobs } {
  const graph = project.graphs.find((g) => g.graph === graphId);
  if (!graph) throw new UserError(`this run uses recipe '${graphId}', which isn't in your recipes any more`);
  const jobs = new Jobs();
  const tools = fakeTools();
  const s = new Scheduler(graph, rec, executors(project, store, jobs, tools), project.graphs, {
    assets: projectAssets(project.settings.library, !project.settings.models.image),
    tools,
    blobs: jsonBlobs(store),
  });
  return { s, jobs };
}

/**
 * Which models run the steps. `fake` (the default) makes up outputs, no keys, no
 * cost. `anthropic` sends text, vision and agent steps to Claude (key from
 * `.env`); image, video and audio stay fake until their providers arrive (Day 16).
 */
function executors(project: Project, store: Store, jobs: Jobs, tools: ReturnType<typeof fakeTools>): Executors {
  const fake = fakeExecutors(project.graphs);
  const models = project.settings.models;
  if (!models.llm && !models.image) return fake;
  const env = join(project.root, ".env");
  if (existsSync(env)) process.loadEnvFile(env); // keys already in the environment win
  const real = [
    ...(models.llm === "anthropic" ? [anthropicExecutors({ graphs: project.graphs, jobs, tools, ...(project.settings.claude ?? {}) })] : []),
    ...(models.image === "replicate" ? [replicateExecutors({ graphs: project.graphs, jobs, media: projectMedia(project, store), ledger: fileLedger(project) })] : []),
  ];
  const claude = models.llm === "anthropic" ? (real[0] as ReturnType<typeof anthropicExecutors>) : undefined;
  return {
    produce: (node, ctx) => (real.find((p) => p.handles(node)) ?? fake).produce(node, ctx),
    decide: fake.decide,
    turn: claude?.turn ?? fake.turn!,
    ...(claude ? { managesContext: true } : {}),
  };
}

/**
 * Images for providers: `blob:<sha256>` from the store, image files inside the
 * project (character sheets in the Library), https URLs as they are.
 * Downloaded images go into the store.
 */
function projectMedia(project: Project, store: Store): Media {
  const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
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

/** The image type from its first bytes. */
function sniff(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return "application/octet-stream";
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
async function drive(s: Scheduler, jobs: Jobs, io: IO): Promise<void> {
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

/** Opens a run in this process: replays its log and asks again for anything in flight. */
async function openRun(project: Project, store: Store, id: string, io: IO, opts: { quiet?: boolean } = {}): Promise<{ rec: Recorder; s: Scheduler; jobs: Jobs; changed: boolean }> {
  if (store.events.read(id).length === 0) throw new UserError(`there's no run '${id}'. See your runs with: kriya status`);
  const rec = Recorder.resume(store.events, id);
  const changed = rec.state.release !== releaseOf(project.graphs, rec.state.graph);
  if (changed && !opts.quiet) {
    io.err(`! ${id}: its recipes changed since it started; it carries on with the current ones (run upgrades come later)`);
  }
  const { s, jobs } = scheduler(project, rec.state.graph, rec, store);
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
