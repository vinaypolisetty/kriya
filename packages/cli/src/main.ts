#!/usr/bin/env -S npx tsx
/**
 * The `kriya` executable (run by bin/kriya): hands the arguments to `main` in
 * commands.ts with the real terminal, and sets the exit code.
 */
import { main } from "./commands.js";

// `kriya inbox | head` closes the pipe early: that's fine, just stop.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => (e.code === "EPIPE" ? process.exit(0) : (() => { throw e; })()));
}

process.exitCode = await main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), cwd: process.cwd() });
