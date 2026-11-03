/**
 * Snapshots real chat briefs for the chat eval (chat.eval.ts): a step of a
 * real run, as the chat would be told about it, plus the pictures it would
 * see. Read-only: the run is replayed from its events, never recovered, so
 * nothing runs and nothing is spent.
 *
 * The snapshot goes to evals/.fixtures/ (gitignored): a project's pictures and
 * story are its creator's, not the repo's. Taking it again is how the eval
 * moves to newer work; until then it reads the same briefs every time.
 *
 *   pnpm eval:capture <project folder> draw=<run>:<step> finished=<run>:<step> list=<run>:<step> voice=<run>:<step>
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openStore } from "@kriya/store";
import { readRun, replay } from "@kriya/engine";
import { chatBrief, recipeOf } from "../src/chat.js";
import { loadProject, namesOf } from "../src/project.js";

/** What each part of the eval needs its step to be. */
export const ROLES = {
  draw: "a picture step in a run still going, with at least 3 versions and an edit step",
  finished: "a step with at least 2 versions in a finished run",
  list: "a step in a run still going whose output is a list of items with ids (a shot list)",
  voice: "a voice step in a run still going that uses a character's voice from the Library",
} as const;
export type Role = keyof typeof ROLES;

export const FIXTURES = resolve(import.meta.dirname, ".fixtures");

/** Where the snapshot came from, so the eval uses the same model settings and key. */
/** What a patch on the list step is checked against, as the engine checks it: the step's outputs, the recipe's types, item keys, the Library's names. */
export type Shape = { out: Record<string, string>; types: Record<string, unknown>; keys: Record<string, string>; names: Record<string, string[]> };

export type Meta = { project: string; claude: { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" }; steps: Record<string, string>; at: string };

/** The first list of records with string ids in an output, with its field: what a patch edits. */
export function listIn(output: Record<string, unknown>): { field: string; ids: string[] } | undefined {
  for (const [field, v] of Object.entries(output)) {
    if (Array.isArray(v) && v.length > 2 && v.every((x) => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string")) {
      return { field, ids: v.map((x) => (x as { id: string }).id) };
    }
  }
  return undefined;
}

function shapeOf(project: ReturnType<typeof loadProject>, state: ReturnType<typeof replay>, key: string): Shape {
  const r = recipeOf(project, state, key)!;
  const node = r.g.nodes.find((x) => x.id === key.slice(r.prefix.length));
  if (!node || !("out" in node)) throw new Error(`'${key}' makes nothing a patch could change`);
  const keys = Object.fromEntries(Object.keys(node.out).map((f) => [f, r.g.nodes.flatMap((n) => (n.kind === "map" && n.over === `${node.id}.${f}` && n.key ? [n.key] : []))[0] ?? "id"]));
  const kinds = [...new Set([...project.library.entities.values()].flatMap((e) => (e.kind ? [e.kind] : [])))];
  return { out: node.out, types: r.g.types, keys, names: Object.fromEntries(kinds.map((k) => [k, namesOf(project)(k)])) };
}

function main(argv: string[]) {
  const [folder, ...picks] = argv;
  const usage = `usage: pnpm eval:capture <project folder> ${Object.keys(ROLES).map((r) => `${r}=<run>:<step>`).join(" ")}\n${Object.entries(ROLES).map(([r, d]) => `  ${r}: ${d}`).join("\n")}`;
  if (!folder || picks.length !== Object.keys(ROLES).length) throw new Error(usage);
  const project = loadProject(resolve(folder));
  const store = openStore(join(project.root, ".kriya"));
  mkdirSync(join(FIXTURES, "blobs"), { recursive: true });
  const steps: Record<string, string> = {};
  try {
    for (const pick of picks) {
      const m = /^(\w+)=([^:]+):(.+)$/.exec(pick);
      if (!m || !(m[1]! in ROLES)) throw new Error(`can't read '${pick}'\n${usage}`);
      const [, role, run, key] = m as unknown as [string, Role, string, string];
      const state = replay(readRun(store.events, run));
      const brief = { ...chatBrief(project, state, key, ""), thread: [] };
      const fail = (why: string) => {
        throw new Error(`${role}=${run}:${key} won't do: ${why}. It needs ${ROLES[role]}`);
      };
      if ((role === "finished") !== brief.finished) fail(brief.finished ? "its run is finished" : "its run isn't finished");
      if (brief.versions.length < (role === "draw" ? 3 : 2) && role !== "list" && role !== "voice") fail(`it has ${brief.versions.length} versions`);
      if (role === "draw" && (!brief.canEdit || brief.images.length === 0)) fail("it has no edit step or no pictures");
      if (role === "list" && !listIn(brief.versions.at(-1)?.output ?? {})) fail("its latest version holds no list of items with ids");
      if (role === "voice" && !brief.facets.some((f) => f.ref.endsWith(".voice"))) fail("it uses no Library voice");
      for (const { ref } of brief.images) {
        const hash = ref.slice("blob:".length);
        const to = join(FIXTURES, "blobs", hash);
        const bytes = existsSync(to) ? undefined : store.blobs.get(hash);
        if (bytes) writeFileSync(to, bytes);
      }
      writeFileSync(join(FIXTURES, `${role}.json`), JSON.stringify(brief, null, 2));
      if (role === "list") writeFileSync(join(FIXTURES, "list.shape.json"), JSON.stringify(shapeOf(project, state, key), null, 2));
      steps[role] = `${run}:${key}`;
      console.log(`✓ ${role}: ${run} ${key} · ${brief.versions.length} versions, ${brief.images.length} pictures, facets ${brief.facets.map((f) => f.ref).join(", ") || "none"}`);
    }
  } finally {
    store.close();
  }
  const meta: Meta = { project: project.root, claude: project.settings.claude ?? {}, steps, at: new Date().toISOString() };
  writeFileSync(join(FIXTURES, "meta.json"), JSON.stringify(meta, null, 2));
  console.log(`Saved in ${FIXTURES}. Run the eval with: pnpm eval:chat`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
