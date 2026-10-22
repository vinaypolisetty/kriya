#!/usr/bin/env -S npx tsx
import { main } from "./commands.js";

// `kriya inbox | head` closes the pipe early: that's fine, just stop.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => (e.code === "EPIPE" ? process.exit(0) : (() => { throw e; })()));
}

process.exitCode = main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), cwd: process.cwd() });
