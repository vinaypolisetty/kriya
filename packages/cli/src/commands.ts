/**
 * The kriya commands. Each one is a separate process: it opens the run from
 * `.kriya/kriya.db`, calls `recover()` (so a closed terminal or a crash loses
 * nothing), does one thing, and exits. Written as functions so tests can call
 * them directly.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { formatProblems, Recorder, Scheduler, type InboxItem, type NodeState, type RunState } from "@kriya/engine";
import { openStore, type Store } from "@kriya/store";
import { fakeExecutors, projectAssets } from "./fake.js";
import { loadProject, UserError, type Project } from "./project.js";

export type IO = { out: (line: string) => void; err: (line: string) => void; cwd: string };

const HELP = `kriya: run recipes with people in the loop

  kriya init <folder> [--example mohalla-mitra]   start a project
  kriya run <recipe> [--input name=value]… [--id name]
                                                  start a run (fake models, no cost)
  kriya status [run]                              your runs, or one run's steps
  kriya inbox                                     what's waiting on you
  kriya decide <item> <button> [--pick v] [--note text] [--region x,y,w,h]
                                                  answer an inbox item (its number, or run:step)
  kriya lock <run> <step> <version> [--why text]  lock a version yourself

Values starting with @ are read from a file: --input story_pages=@pages.txt`;

export function main(argv: string[], io: IO): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "init": return init(rest, io);
      case "run": return run(rest, io);
      case "status": return status(rest, io);
      case "inbox": return inbox(io);
      case "decide": return decide(rest, io);
      case "lock": return lock(rest, io);
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

function init(args: string[], io: IO): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { example: { type: "string" } } });
  const folder = positionals[0];
  if (!folder) throw new UserError("say which folder to create: kriya init <folder>");
  const root = resolve(io.cwd, folder);
  if (existsSync(join(root, "kriya.yaml"))) throw new UserError(`'${folder}' already has a kriya.yaml`);
  const example = values.example;
  if (example && !existsSync(join(EXAMPLES, example))) throw new UserError(`there's no example called '${example}'. Try: mohalla-mitra`);

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

function run(args: string[], io: IO): number {
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
    const s = scheduler(project, graph.graph, rec);
    s.start(project.release, inputs, project.settings.context);
    s.run();
    io.out(`✓ Started ${id} (${recipe})`);
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

function status(args: string[], io: IO): number {
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const runs = store.events.runs();
    const id = args[0];
    if (!id) {
      if (runs.length === 0) io.out("No runs yet. Start one with: kriya run <recipe>");
      for (const r of runs) {
        const { rec, s } = openRun(project, store, r, io);
        io.out(`${r.padEnd(24)} ${rec.state.graph.padEnd(16)} ${summary(rec.state, s.inbox().length)}`);
      }
      return 0;
    }
    const { rec, s } = openRun(project, store, id, io);
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

function inbox(io: IO): number {
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const entries = allInbox(project, store, io);
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

function decide(args: string[], io: IO): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { pick: { type: "string" }, note: { type: "string" }, region: { type: "string" } } });
  const [item, action] = positionals;
  if (!item || !action) throw new UserError("say which item and which button: kriya decide <item> <button>");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const entries = allInbox(project, store, io);
    const entry = /^\d+$/.test(item) ? entries[Number(item) - 1] : entries.find((e) => `${e.run}:${e.key}` === item);
    if (!entry) throw new UserError(`there's no inbox item '${item}'. See them with: kriya inbox`);
    const { rec, s } = openRun(project, store, entry.run, io);
    // A button that needs a pick, with exactly one option on show: that's the pick.
    const needsPick = entry.buttons.find((b) => b.id === action)?.needs.includes("selection");
    const pick = values.pick ?? (needsPick && entry.shows.length === 1 ? entry.shows[0]!.version : undefined);
    s.answer(entry.key, {
      action,
      ...(pick ? { selection: [pick] } : {}),
      ...(values.note ? { note: values.note } : {}),
      ...(values.region ? { region: values.region } : {}),
    });
    s.run();
    io.out(`✓ ${action} on ${entry.key}`);
    report(io, rec.state, s.inbox());
    return 0;
  } finally {
    store.close();
  }
}

function allInbox(project: Project, store: Store, io: IO): Entry[] {
  const runs = store.events.runs();
  return runs.flatMap((r) => {
    const { s, rec } = openRun(project, store, r, io);
    return rec.state.status === "running" ? s.inbox().map((i) => ({ ...i, run: r })) : [];
  });
}

// ── lock ────────────────────────────────────────────────────────────────────

function lock(args: string[], io: IO): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { why: { type: "string" } } });
  const [id, step, version] = positionals;
  if (!id || !step || !version) throw new UserError("say which run, step and version: kriya lock <run> <step> <version>");
  const project = checkedProject(io);
  const store = openStore(join(project.root, ".kriya"));
  try {
    const { rec, s } = openRun(project, store, id, io);
    s.lock(step, version, values.why);
    io.out(`✓ Locked ${step} to ${version}`);
    const stale = s.stale();
    if (stale.length === 0) s.run(); // nothing to redo: the run settles again
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

// ── shared ──────────────────────────────────────────────────────────────────

function checkedProject(io: IO): Project {
  const project = loadProject(io.cwd);
  const errors = project.problems.filter((p) => p.severity === "error");
  if (errors.length) throw new UserError(`your recipes have problems:\n${formatProblems(errors)}`);
  return project;
}

function scheduler(project: Project, graphId: string, rec: Recorder): Scheduler {
  const graph = project.graphs.find((g) => g.graph === graphId);
  if (!graph) throw new UserError(`this run uses recipe '${graphId}', which isn't in your recipes any more`);
  return new Scheduler(graph, rec, fakeExecutors(project.graphs), project.graphs, {
    assets: projectAssets(project.settings.library, project.settings.models === "fake"),
  });
}

/** Opens a run in this process: replays its log and asks again for anything in flight. */
function openRun(project: Project, store: Store, id: string, io: IO): { rec: Recorder; s: Scheduler } {
  if (store.events.read(id).length === 0) throw new UserError(`there's no run '${id}'. See your runs with: kriya status`);
  const rec = Recorder.resume(store.events, id);
  if (rec.state.release !== project.release) {
    io.err(`! ${id}: the recipes changed since this run started; it carries on with the current recipes (run upgrades come later)`);
  }
  const s = scheduler(project, rec.state.graph, rec);
  if (rec.state.status === "running") {
    s.recover();
    s.run();
  }
  return { rec, s };
}

function report(io: IO, state: RunState, waiting: InboxItem[]): void {
  io.out(`  ${summary(state, waiting.length)}`);
  if (state.status === "running" && waiting.length) io.out("  Next: kriya inbox");
}
