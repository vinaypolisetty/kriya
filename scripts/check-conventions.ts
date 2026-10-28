/**
 * The repo's conventions, checked (CONTRIBUTING.md, items marked ✓), so they
 * hold without anyone having to remember them:
 *
 *   - every source file opens with a header comment that says what it's for
 *   - every package has a README
 *   - every decision cited (`D-46`) is in docs/17-decisions.md
 *   - every CLI command is in docs/cli.md
 *   - every web API route is listed at the top of packages/cli/src/web.ts
 *   - the engine's run core imports nothing that could make it non-deterministic
 *   - tests live in packages/<pkg>/test and are named *.test.ts
 *
 *   pnpm check:conventions      (exit code 1 on any problem; CI runs it)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const problems: string[] = [];
const at = (file: string) => relative(ROOT, file);
const read = (file: string) => readFileSync(file, "utf8");

/** Every file under `dir` whose name matches, skipping dependencies and build output. */
function files(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".kriya"].includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, match) : match.test(name) ? [path] : [];
  });
}

const packages = readdirSync(join(ROOT, "packages")).filter((p) => statSync(join(ROOT, "packages", p)).isDirectory());

// ── Header comments ─────────────────────────────────────────────────────────
const sources = [...packages.flatMap((p) => files(join(ROOT, "packages", p, "src"), /\.tsx?$/)), ...files(join(ROOT, "packages", "adapters", "workers"), /\.py$/), ...files(join(ROOT, "scripts"), /\.ts$/)];
for (const file of sources) {
  const lines = read(file).split("\n").filter((l) => !l.startsWith("#!"));
  const start = lines.findIndex((l) => l.trim());
  const first = lines[start];
  // A doc comment sitting directly on an export documents that export, not the module.
  const end = lines.findIndex((l, i) => i >= start && l.includes("*/"));
  const onExport = /^export (async |default )?(function|const|let|class|type|interface|enum)\b/.test(lines[end + 1] ?? "");
  const ok = file.endsWith(".py") ? first?.startsWith('"""') : first?.startsWith("/**") && !onExport;
  if (!ok) problems.push(`${at(file)}: starts without a header comment. Open it with ${file.endsWith(".py") ? 'a """docstring"""' : "/** … */"} saying what the module is for (CONTRIBUTING.md › Comments)`);
}

// ── Package READMEs ─────────────────────────────────────────────────────────
for (const p of packages) {
  if (!existsSync(join(ROOT, "packages", p, "README.md"))) problems.push(`packages/${p}: has no README.md. Say what the package is for, its public API and how to test it (see packages/engine/README.md)`);
}

// ── Decisions cited exist ───────────────────────────────────────────────────
const decided = new Set([...read(join(ROOT, "docs", "17-decisions.md")).matchAll(/^\| (D-\d+) \|/gm)].map((m) => m[1]!));
const citing = [
  ...packages.flatMap((p) => [...files(join(ROOT, "packages", p, "src"), /\.(tsx?|py)$/), ...files(join(ROOT, "packages", p, "test"), /\.ts$/), ...files(join(ROOT, "packages", p), /^README\.md$/)]),
  ...files(join(ROOT, "packages", "adapters", "workers"), /\.py$/),
  ...files(join(ROOT, "docs"), /\.md$/).filter((f) => basename(f) !== "17-decisions.md"),
  ...["README.md", "CONTRIBUTING.md", "CLAUDE.md"].map((f) => join(ROOT, f)).filter(existsSync),
];
for (const file of citing) {
  for (const m of read(file).matchAll(/\bD-(\d{2,3})\b/g)) {
    if (!decided.has(`D-${m[1]}`)) problems.push(`${at(file)}: cites D-${m[1]}, which isn't in docs/17-decisions.md. Add the decision there, or fix the number`);
  }
}

// ── CLI commands are documented ─────────────────────────────────────────────
const commands = read(join(ROOT, "packages", "cli", "src", "commands.ts"));
const cliDoc = read(join(ROOT, "docs", "cli.md"));
for (const [, cmd] of commands.matchAll(/^\s+case "([a-z]+)": return await /gm)) {
  if (!cliDoc.includes(`\`kriya ${cmd}`)) problems.push(`docs/cli.md: doesn't describe \`kriya ${cmd}\`. Add a row to its Commands table`);
  if (!new RegExp(`^  kriya ${cmd}\\b`, "m").test(commands)) problems.push(`packages/cli/src/commands.ts: HELP doesn't list \`kriya ${cmd}\``);
}

// ── Web routes are listed in web.ts's header ────────────────────────────────
const web = read(join(ROOT, "packages", "cli", "src", "web.ts"));
const header = web.slice(0, web.indexOf("*/"));
for (const [, route] of web.slice(header.length).matchAll(/pathname === "(\/api\/[a-z/]+)"/g)) {
  if (!header.includes(route!)) problems.push(`packages/cli/src/web.ts: serves ${route} but its header doesn't list it. Add it to the route list at the top`);
}

// ── The engine's run core stays deterministic ───────────────────────────────
const CORE = ["events", "state", "recorder", "scheduler", "condition", "spec", "validate"];
const ALLOWED = /^(\.\/|zod$|node:crypto$)/;
for (const name of CORE) {
  const file = join(ROOT, "packages", "engine", "src", `${name}.ts`);
  for (const [, from] of read(file).matchAll(/^import [^;]*? from "([^"]+)";/gm)) {
    if (!ALLOWED.test(from!)) problems.push(`${at(file)}: imports "${from}". The engine's run core may only import its own files, zod and node:crypto: put I/O behind an interface (Executors, Tools, Blobs, Assets) instead`);
  }
  for (const m of read(file).matchAll(/\b(Date\.now|new Date|Math\.random|performance\.now)\b/g)) {
    problems.push(`${at(file)}: uses ${m[1]}. The run core can't read the clock or randomness (design rule 1); record the value as an event instead`);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────
for (const p of packages) {
  for (const file of files(join(ROOT, "packages", p, "src"), /\.test\.tsx?$/)) problems.push(`${at(file)}: tests go in packages/${p}/test/, not src/`);
  for (const file of files(join(ROOT, "packages", p, "test"), /\.tsx?$/)) {
    if (!file.endsWith(".test.ts")) problems.push(`${at(file)}: test files are named *.test.ts`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} convention problem${problems.length === 1 ? "" : "s"} (CONTRIBUTING.md)`);
  process.exit(1);
}
console.log(`✓ conventions: ${sources.length} source files, ${packages.length} packages, ${decided.size} decisions`);
