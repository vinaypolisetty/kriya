/**
 * What a chat message can point at with @ (D-96): `@Library` (everyone in
 * it), a Library entity by name (`@Mitra`, `@Chai stall`), another step of the
 * run (`@shot_list`, a step beside this one in its for-each item by its own id:
 * `@pick`), one version of a step (`@shot_list v2`), or one for-each item
 * (`@per_shot[P3-04]`: all of its steps).
 *
 * A step's chat sees its own step whole and only other steps' locked work
 * (D-87). What the creator points at is shown to it whole too, pictures and
 * all, even a version that isn't locked: they asked for it. It flows nowhere
 * else: the chat still acts only on its own step and the Library's facets, and
 * nothing pointed at goes into a step's next version.
 *
 * The browser's @ list and the chat's brief both come from `pointables`, so
 * what can be picked is exactly what is understood. Read from recorded state
 * only, like the rest of the brief.
 */
import type { ChatBrief } from "@kriya/adapters";
import { intention, numbers, onBranch, type NodeState, type RunState } from "@kriya/engine";
import { MEDIA, type Entity } from "./library.js";
import { recipeOf } from "./chat.js";
import { UserError, type Project } from "./project.js";

/** Something a message can point at, as typed after the @, with a line saying what it is. */
export type Pointable = { ref: string; kind: "library" | "entity" | "step" | "item"; label: string };

/** The step keys a ref is tried against, nearest first: `per_shot[P3-04].` then the run's own level. */
const levels = (key: string) => {
  const prefixes = [""];
  for (const m of key.matchAll(/\w+\[[^\]]+\]\./g)) prefixes.unshift(prefixes[0] + m[0]);
  return prefixes;
};

/** A run's steps that make versions (model, agent, tool), with their names: not reviews or for-each steps. */
function steps(project: Project, state: RunState): { key: string; name: string; n: NodeState }[] {
  return Object.entries(state.nodes).flatMap(([key, n]) => {
    const r = recipeOf(project, state, key);
    const node = r?.g.nodes.find((x) => x.id === key.slice(r.prefix.length));
    return node && (node.kind === "model" || node.kind === "agent" || node.kind === "tool") ? [{ key, name: node.name ?? node.id, n }] : [];
  });
}

/**
 * Everything a message to step `key` can point at, in the order the @ list
 * shows them. With `all`, also what's understood but not worth listing: this
 * step itself (`@draw v2` in draw's own chat) and steps with no versions yet.
 */
export function pointables(project: Project, state: RunState, key: string, all = false): Pointable[] {
  const near = levels(key);
  const short = (k: string) => k.slice(near.find((p) => k.startsWith(p))!.length);
  // This item's steps first, then the run's own, then other items'.
  const rank = (k: string) => (short(k).includes("[") ? near.length : near.findIndex((p) => k.startsWith(p)));
  const own = steps(project, state)
    .filter((x) => all || (x.key !== key && Object.keys(x.n.versions).length))
    .sort((a, b) => rank(a.key) - rank(b.key));
  const items = [...new Set(own.flatMap((x) => [...x.key.matchAll(/\w+\[[^\]]+\](?=\.)/g)].map((m) => x.key.slice(0, m.index + m[0].length))))];
  const versions = (n: NodeState) => Object.keys(n.versions).length;
  return [
    ...(project.library.entities.size ? [{ ref: "Library", kind: "library" as const, label: `everyone in the Library (${project.library.entities.size})` }] : []),
    ...[...project.library.entities.values()].map((e) => ({ ref: e.name, kind: "entity" as const, label: `${e.kind ?? "in the Library"}: ${Object.keys(e.facets).join(", ")}` })),
    ...own
      // The nearest of two steps with the same id wins (`@draw` beside this one, not the run's own `draw`).
      .filter((x, i) => own.findIndex((y) => short(y.key) === short(x.key)) === i)
      .map((x) => ({ ref: short(x.key), kind: "step" as const, label: `${x.name}: ${versions(x.n)} version${versions(x.n) === 1 ? "" : "s"}${x.n.locked ? `, v${numbers(x.n)[x.n.locked.version]} locked` : ""}` })),
    ...items.filter((i) => !key.startsWith(`${i}.`)).map((i) => ({ ref: i, kind: "item" as const, label: `all of ${i.slice(i.lastIndexOf("[") + 1, -1)}'s steps` })),
  ];
}

/** Characters that can't end a ref: `@Mitra's` and `@shot_list.` point, `@Mitras` doesn't. */
const NAME_CHAR = /[\p{L}\p{N}_\-[]/u;

/**
 * What a message points at, for the chat's brief: each @ref found, nearest
 * step first. A ref that names nothing is an error before anything is
 * recorded, with the nearest names, so a typo never reaches the chat.
 */
export function pointsIn(project: Project, state: RunState, key: string, message: string): ChatBrief["points"] {
  const listed = pointables(project, state, key);
  const byLength = pointables(project, state, key, true).sort((a, b) => b.ref.length - a.ref.length);
  const points: ChatBrief["points"] = [];
  // An @ at the start, or after a space or bracket, then a letter: not an email address, not "@ 5pm".
  for (const m of message.matchAll(/(?<=^|[\s("'])@(?=[\p{L}\p{N}_])/gu)) {
    const rest = message.slice(m.index + 1);
    const hit = byLength.find((p) => rest.toLowerCase().startsWith(p.ref.toLowerCase()) && !NAME_CHAR.test(rest[p.ref.length] ?? ""));
    if (!hit) {
      const typed = /^[^\s,;:!?)]+/.exec(rest)![0].replace(/[.'"]+$/, "");
      const like = listed.filter((p) => p.ref.toLowerCase().includes(typed.toLowerCase())).slice(0, 3);
      throw new UserError(`there's nothing called @${typed} in this run or the Library.${like.length ? ` Did you mean ${like.map((p) => `@${p.ref}`).join(", ")}?` : ""} Type @ in the browser for a list`);
    }
    const version = hit.kind === "step" ? /^(?: |\.)v(\d+)\b/i.exec(rest.slice(hit.ref.length))?.[1] : undefined;
    const ref = `@${hit.ref}${version ? ` v${version}` : ""}`;
    if (points.some((p) => p.ref === ref)) continue;
    points.push(point(project, state, key, hit, ref, version ? Number(version) : undefined));
  }
  return points;
}

/** One thing pointed at: what it is, what it holds, and the pictures in it. */
function point(project: Project, state: RunState, key: string, p: Pointable, ref: string, version?: number): ChatBrief["points"][number] {
  if (p.kind === "library") {
    const value = Object.fromEntries([...project.library.entities.values()].map((e) => [e.name, facets(state, e)]));
    return { ref, what: "everyone in the Library, as they read in this run", value, images: [] };
  }
  if (p.kind === "entity") {
    const e = project.library.entities.get(p.ref)!;
    const value = facets(state, e);
    return { ref, what: `${e.name}, ${e.kind ? `a ${e.kind}` : "an entry"} in the Library, as it reads in this run`, value, images: files(value) };
  }
  const found = steps(project, state);
  const stepAt = (k: string) => found.find((x) => x.key === k);
  if (p.kind === "item") {
    const inside = found.filter((x) => x.key.startsWith(`${p.ref}.`));
    const shown = inside.flatMap((x) => {
      const v = shownVersion(x.n);
      return v ? [{ x, v }] : [];
    });
    const value = Object.fromEntries(shown.map(({ x, v }) => [x.key.slice(p.ref.length + 1), { version: label(x.n, v), output: v.output }]));
    return { ref, what: `${p.ref}: each of its steps' locked version, else its latest`, value, images: shown.flatMap(({ v }) => blobs(v.output)) };
  }
  const k = levels(key).map((pre) => pre + p.ref).find((c) => stepAt(c))!;
  const { name, n } = stepAt(k)!;
  const num = numbers(n);
  const v = version ? Object.values(n.versions).find((x) => num[x.id] === version) : shownVersion(n);
  if (version && !v) throw new UserError(`${name} has no v${version}: it has ${Object.keys(n.versions).length ? `v1 to v${Math.max(...Object.values(num))}` : "no versions yet"}`);
  if (!v) return { ref, what: `the step ${name} (${k}): no versions yet`, value: null, images: [] };
  const why = intention(n, v);
  return { ref, what: `the step ${name} (${k}), ${label(n, v)}${n.status === "stale" ? ", stale: something it used has changed" : ""}; made ${why}`, value: v.output, images: blobs(v.output) };
}

/** The version a step shows when no version is named: its locked one, else the latest on its branch. */
const shownVersion = (n: NodeState) => (n.locked ? n.versions[n.locked.version] : onBranch(n).at(-1));

const label = (n: NodeState, v: NodeState["versions"][string]) => `v${numbers(n)[v.id]}${n.locked?.version === v.id ? " (locked)" : " (not locked)"}`;

/** An entity's facets as they read in this run: the run's change, else the Library's (D-88). */
const facets = (state: RunState, e: Entity) =>
  Object.fromEntries(Object.entries(e.facets).map(([f, v]) => [f, state.overrides.run?.[`${e.name}.${f}`] ?? v]));

/** The pictures a step made (stored blobs; the chat's media reader skips anything that isn't an image). */
const blobs = (output: Record<string, unknown>) => Object.values(output).filter((x): x is string => typeof x === "string" && x.startsWith("blob:"));

/** The files a facet names (a look's sheet), anywhere inside it. */
const files = (v: unknown): string[] => (typeof v === "string" ? (MEDIA.test(v) ? [v] : []) : Array.isArray(v) ? v.flatMap(files) : v && typeof v === "object" ? Object.values(v).flatMap(files) : []);
