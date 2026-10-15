/**
 * Validates every recipe under a folder. Exit code 1 on any error.
 *   pnpm validate:examples
 */
import { resolve } from "node:path";
import { formatProblems, loadDir } from "./load.js";

const dir = resolve(process.argv[2] ?? ".");
const { graphs, problems } = loadDir(dir);
const errors = problems.filter((p) => p.severity === "error");

if (problems.length) console.log(formatProblems(problems));
console.log(`\n${graphs.length} graph(s) loaded · ${errors.length} error(s) · ${problems.length - errors.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
