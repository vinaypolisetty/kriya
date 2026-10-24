/**
 * The kriya commands. Each one is a separate process: it opens the run from
 * `.kriya/kriya.db`, calls `recover()` (so a closed terminal or a crash loses
 * nothing), does one thing, and exits. Written as functions so tests can call
 * them directly.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { formatProblems, Recorder, Scheduler, type Blobs, type Executors, type InboxItem, type NodeState, type RunState } from "@kriya/engine";
import { anthropicExecutors, describeError, Jobs, MissingKey, settle } from "@kriya/adapters";
import { openStore, type Store } from "@kriya/store";
import { fakeExecutors, fakeTools, projectAssets } from "./fake.js";
import { loadProject, UserError, type Project } from "./project.js";

export type IO = { out: (line: string) => void; err: (line: string) => void; cwd: string };

const HELP = `kriya: run recipes with people in the loop

  kriya init <folder> [--example <name>]          start a project (examples: kriya init --examples)
  kriya run <recipe> [--input name=value]… [--id name]
                                                  start a run (models from kriya.yaml: fake, or anthropic)
  kriya status [run]                              your runs, or one run's steps
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
  writeFileSync(join(root, ".gitignore"), ".kriya/\n");
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
    s.start(project.release, inputs, project.settings.context);
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
        const { rec, s } = await openRun(project, store, r, io);
        io.out(`${r.padEnd(24)} ${rec.state.graph.padEnd(16)} ${summary(rec.state, s.inbox().length)}`);
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
    const { s, rec } = await openRun(project, store, r, io);
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
  const s = new Scheduler(graph, rec, executors(project, jobs, tools), project.graphs, {
    assets: projectAssets(project.settings.library, project.settings.models === "fake"),
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
function executors(project: Project, jobs: Jobs, tools: ReturnType<typeof fakeTools>): Executors {
  const fake = fakeExecutors(project.graphs);
  if (project.settings.models === "fake") return fake;
  const env = join(project.root, ".env");
  if (existsSync(env) && !process.env.ANTHROPIC_API_KEY) process.loadEnvFile(env);
  const claude = anthropicExecutors({ graphs: project.graphs, jobs, tools, ...(project.settings.claude ?? {}) });
  return {
    produce: (node, ctx) => (claude.handles(node) ? claude.produce(node, ctx) : fake.produce(node, ctx)),
    decide: fake.decide,
    turn: claude.turn,
    managesContext: true,
  };
}

/** Runs until nothing is in flight: model calls are awaited and delivered, then the run carries on. */
async function drive(s: Scheduler, jobs: Jobs, io: IO): Promise<void> {
  s.run();
  if (jobs.size > 0) io.out("  ⏳ waiting on Claude…");
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
async function openRun(project: Project, store: Store, id: string, io: IO): Promise<{ rec: Recorder; s: Scheduler; jobs: Jobs }> {
  if (store.events.read(id).length === 0) throw new UserError(`there's no run '${id}'. See your runs with: kriya status`);
  const rec = Recorder.resume(store.events, id);
  if (rec.state.release !== project.release) {
    io.err(`! ${id}: the recipes changed since this run started; it carries on with the current recipes (run upgrades come later)`);
  }
  const { s, jobs } = scheduler(project, rec.state.graph, rec, store);
  if (rec.state.status === "running") {
    try {
      s.recover();
      await drive(s, jobs, io);
    } catch (e) {
      // A step waiting on Claude with no key: say so, and still show and answer everything else.
      if (!(e instanceof MissingKey)) throw e;
      io.err(`! ${id}: ${e.message}`);
    }
  }
  return { rec, s, jobs };
}

function report(io: IO, state: RunState, waiting: InboxItem[]): void {
  io.out(`  ${summary(state, waiting.length)}`);
  if (state.status === "running" && waiting.length) io.out("  Next: kriya inbox");
}
