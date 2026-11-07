/**
 * Talking to a step (D-87), for `kriya chat` and the browser: what the chat is
 * told, and what is done with its answer.
 *
 * A message is recorded first (`ChatSaid`), then the chat answers from a brief
 * of the run's recorded state. What it asks to do is checked here and done the
 * way a click would do it, through the scheduler: a lock (answering the screen
 * that waits for it, if one does), a new version (`make`), or a patched one:
 * items of a list changed by key, the rest copied exactly (D-89). Then the answer is
 * recorded with what was done (`ChatAnswered`). The chat never touches the run
 * itself.
 *
 * A fact about a character, place or thing (a Library facet) changes for the
 * whole run (D-88): an override at the run's level, never the Library itself,
 * so other runs don't move. Only when the creator says to keep it is it written
 * to the Library, for runs from then on; finished runs keep what they were made
 * with.
 *
 * What the creator points at with @ (D-96) is shown to the chat whole
 * (refs.ts); a ref that names nothing is an error before anything is recorded.
 *
 * A completed run is done and frozen: the chat talks about it, but nothing in
 * it is locked, made or changed. In a run still going, a lock or a change that
 * leaves work stale has that work redone at once: in progress follows the change.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeChat, describeError, type Chat, type ChatBrief, type ChatReply, type Media } from "@kriya/adapters";
import { Edit, findGraph, intention, numbers, onBranch, suggest, type Graph, type NodeState, type RunState, type Scheduler } from "@kriya/engine";
import { parse } from "yaml";
import { z } from "zod";
import { MEDIA, writeFacet } from "./library.js";
import { fakeChat } from "./fake.js";
import { pointsIn } from "./refs.js";
import { namesOf, UserError, type Project } from "./project.js";

/** The recipe a step key is in, walking down for-each items: `per_shot[P3-04].pick` → shot_recipe and `per_shot[P3-04].`. */
export function recipeOf(project: Project, state: RunState, key: string) {
  let g = findGraph(project.graphs, state.graph);
  let prefix = "";
  for (const [, mapId, item] of key.matchAll(/(\w+)\[([^\]]+)\]\./g)) {
    const map = g?.nodes.find((n) => n.id === mapId);
    if (!map || map.kind !== "map") return undefined;
    prefix += `${mapId}[${item}].`;
    g = findGraph(project.graphs, map.graph);
  }
  return g ? { g, prefix } : undefined;
}

/** The chat this project talks with: Claude when `models: { llm: anthropic }`, else a fake that needs no key. */
export function chatFor(project: Project, media?: Media): Chat {
  if (project.settings.models.llm !== "anthropic") return fakeChat;
  const env = join(project.root, ".env");
  if (existsSync(env)) process.loadEnvFile(env); // keys already in the environment win
  return claudeChat({ ...(project.settings.claude ?? {}), ...(media ? { media } : {}) });
}

/** How many of a step's latest versions the chat sees pictures of, besides the locked one. */
const PICTURES = 6;

/** What the chat is told about one step: built from recorded state only. */
export function chatBrief(project: Project, state: RunState, key: string, message: string): ChatBrief {
  const n = state.nodes[key];
  const r = recipeOf(project, state, key);
  const node = r?.g.nodes.find((x) => x.id === key.slice(r.prefix.length));
  if (!n || !node || !r) throw new UserError(`there's no step '${key}' in this run yet. See its steps with: kriya status <run>`);
  if (node.kind === "screen" || node.kind === "map" || node.kind === "subgraph") {
    const shows = node.kind === "screen" ? node.show?.split(".")[0] : undefined;
    throw new UserError(`'${key}' has no versions of its own to talk about${shows ? `; talk to the step it shows: ${r.prefix}${shows}` : ""}`);
  }
  const num = numbers(n);
  const byNumber = Object.values(n.versions).sort((a, b) => num[a.id]! - num[b.id]!);
  const asks = node.kind === "model" ? (node.prompt ?? node.send ?? node.capability) : node.kind === "agent" ? node.goal : `the ${node.tool} tool`;
  const shown = new Set([...byNumber.slice(-PICTURES).map((v) => v.id), ...(n.locked ? [n.locked.version] : [])]);
  return {
    step: { key, name: node.name ?? node.id, kind: node.kind, asks, makes: Object.entries(node.out).map(([f, t]) => `${f} (${t})`) },
    shapes: shapes(Object.values(node.out), r.g.types),
    canEdit: r.g.nodes.some((x) => (x.kind === "model" || x.kind === "agent") && x.refines === node.id),
    finished: state.status === "completed",
    versions: byNumber.map((v) => ({
      n: num[v.id]!,
      branch: v.branch,
      locked: n.locked?.version === v.id,
      intention: intention(n, v),
      output: v.output,
      ...(v.prompt ? { prompt: v.prompt } : {}),
      ...(v.model ? { model: v.model } : {}),
      ...(v.verdicts.length ? { checks: checks(v.verdicts) } : {}),
    })),
    facets: usedFacets(project, state, n),
    library: [...project.library.entities.values()].map((e) => `${e.name}${e.kind ? ` (${e.kind})` : ""}: ${Object.keys(e.facets).join(", ")}`),
    story: { inputs: state.inputs, locked: lockedWork(state, key) },
    points: pointsIn(project, state, key, message),
    images: byNumber.filter((v) => shown.has(v.id)).flatMap((v) => Object.values(v.output).filter((x): x is string => typeof x === "string" && x.startsWith("blob:")).map((ref) => ({ n: num[v.id]!, ref }))),
    thread: n.thread.map((t) => ({ by: t.by, text: t.text })),
    message,
  };
}

/** The declared types a step's outputs hold, nested ones too, in words: `shot: id (text), place (library.place), …`. */
function shapes(types: string[], declared: Graph["types"], seen = new Set<string>()): string[] {
  return types.flatMap((t) => {
    const name = /^list<(.+)>$/.exec(t)?.[1] ?? t;
    const d = declared[name];
    if (!d || seen.has(name)) return [];
    seen.add(name);
    return [`${name}: ${Object.entries(d.fields).map(([f, ft]) => `${f} (${ft})`).join(", ")}`, ...shapes(Object.values(d.fields), declared, seen)];
  });
}

/** Edits as YAML or JSON (one edit, or a list), checked before anything is made (D-89). */
export function parseEdits(text: string): Edit[] {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new UserError(`the edits aren't readable YAML or JSON: ${describeError(e)}`);
  }
  const r = z.array(Edit).safeParse(Array.isArray(raw) ? raw : [raw]);
  if (!r.success) {
    const first = r.error.issues[0]!;
    throw new UserError(`edit ${Number(first.path[0] ?? 0) + 1} doesn't look right${first.path.length > 1 ? ` (at ${first.path.slice(1).join(".")})` : ""}: ${first.message}. An edit is one of: add (field, item, after or before), update (field, key, set), remove (field, key), move (field, key, after or before), set (field, value)`);
  }
  return r.data;
}

/** The facets a step's versions used, as they read in this run now: the run's change, or the Library's. */
function usedFacets(project: Project, state: RunState, n: NodeState): ChatBrief["facets"] {
  const refs = [...new Set(Object.values(n.versions).flatMap((v) => Object.keys(v.assets ?? {})))];
  return refs.map((ref) => {
    const changed = state.overrides.run?.[ref];
    if (changed !== undefined) return { ref, value: changed, from: "this run" as const };
    const [entity, facet] = splitRef(ref);
    return { ref, value: project.library.entities.get(entity)?.facets[facet] ?? null, from: "Library" as const };
  });
}

/** `Chai stall.look` → `Chai stall`, `look`: names can have spaces and dots, facets can't. */
const splitRef = (ref: string): [string, string] => [ref.slice(0, ref.lastIndexOf(".")), ref.slice(ref.lastIndexOf(".") + 1)];

/** What the checks said about a version, in one line. */
function checks(verdicts: NodeState["versions"][string]["verdicts"]): string {
  const issues = verdicts.flatMap((x) => x.issues.map((i) => i.what ?? i.type));
  return issues.length ? `issues: ${issues.join("; ")}` : "passed";
}

/** Every other step's locked output, in words: media are named, not pasted (only the step's own pictures are shown). */
function lockedWork(state: RunState, key: string): { key: string; value: unknown }[] {
  const named = (v: unknown): unknown =>
    typeof v === "string" ? (v.startsWith("blob:") || v.startsWith("fake://") ? "(media)" : v) : Array.isArray(v) ? v.map(named) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, named(x)])) : v;
  return Object.entries(state.nodes).flatMap(([k, n]) => {
    if (k === key || !n.locked || n.status === "stale") return [];
    const out = n.versions[n.locked.version]?.output ?? {};
    if (Object.values(out).every((v) => named(v) === "(media)")) return [];
    return [{ key: k, value: named(out) }];
  });
}

export type Talked = { reply: ChatReply; did: string[] };

/**
 * One message to a step, start to finish: heard, answered, acted on. The
 * caller then drives the run (`drive`), since a new version or a lock may set
 * work going. `kriya web` does the two halves itself, so the chat's answer is
 * waited for outside the line of writes (D-86).
 */
export async function talk(project: Project, s: Scheduler, chat: Chat, key: string, text: string): Promise<Talked> {
  const brief = hear(project, s, key, text);
  const r = await chat(brief);
  return { reply: r, did: reply(project, s, key, brief.message, r) };
}

/** Records what the creator said and returns what the chat is told (the conversation before this message). */
export function hear(project: Project, s: Scheduler, key: string, text: string): ChatBrief {
  const message = text.trim();
  if (!message) throw new UserError('say something to the step, e.g. kriya chat <run> <step> "why is v2 darker?"');
  const brief = chatBrief(project, s.state, key, message);
  s.said(key, message);
  return brief;
}

/** Does what the chat asked, the way a click would, and records its answer with what was done. */
export function reply(project: Project, s: Scheduler, key: string, message: string, r: ChatReply): string[] {
  const did = r.actions.map((a) => {
    try {
      return act(project, s, key, a, message);
    } catch (e) {
      const what = a.do === "lock" ? `lock v${a.version}` : a.do === "make" || a.do === "patch" ? "make a new version" : `${a.do} ${a.entity}'s ${a.facet}`;
      return `couldn't ${what}: ${describeError(e)}`;
    }
  });
  s.answered(key, { text: r.text, did, model: r.model, cost_usd: r.cost_usd });
  return did;
}

/** Does one thing the chat asked for, the way a click would, and says what was done. */
function act(project: Project, s: Scheduler, key: string, a: ChatReply["actions"][number], message: string): string {
  if (a.do === "keep") return keep(project, s, a.entity, a.facet);
  if (s.state.status === "completed") return `didn't ${a.do} anything: this run is finished, so it stays as it is`;
  if (a.do === "change") return change(project, s, a);
  const n = s.state.nodes[key]!;
  const byNumber = Object.fromEntries(Object.entries(numbers(n)).map(([id, k]) => [k, id]));
  if (a.do === "lock") {
    const id = byNumber[a.version];
    if (!id) return `couldn't lock v${a.version}: there's no v${a.version}`;
    // A lock's why is the creator's own words (D-29): anything the chat wrote itself is left out.
    const why = a.why.trim() && message.includes(a.why.trim()) ? a.why.trim() : undefined;
    s.choose(key, id, why);
    return `locked v${a.version}${redo(s, "the old one")}`;
  }
  const from = a.from > 0 ? byNumber[a.from] : undefined;
  if (a.from > 0 && !from) return `couldn't make a new version: there's no v${a.from}`;
  if (a.do === "patch") {
    const base = from ?? n.locked?.version ?? onBranch(n).at(-1)?.id;
    if (!base) return "couldn't make a new version: this step has no version yet to change";
    const made = s.patch(key, base, parseEdits(a.edits), { note: message, names: namesOf(project) });
    const num = numbers(s.state.nodes[key]!);
    return `made v${num[made.version]} from v${num[base]}: ${made.did.join("; ")}. Nothing is locked yet`;
  }
  const maker = s.make(key, { ...(from ? { from } : {}), instruction: a.instruction, redo: a.how === "redo" });
  return `making a new version${from ? ` from v${a.from}` : ""}${maker !== key ? ` with ${maker.split(".").at(-1)}` : ""}: ${a.instruction}`;
}

/** Redoes the run's stale work at once (in progress follows the change), and says how much. */
function redo(s: Scheduler, what = "it"): string {
  const stale = s.stale().length;
  const waiting = s.outdated().length; // takes waiting for you, made with the old one, are made again too (D-90)
  if (stale + waiting === 0) return "";
  s.rebuild();
  const steps = stale ? `redoing ${stale} step${stale === 1 ? "" : "s"} that used ${what}` : "";
  const takes = waiting ? `making new takes for the ${waiting === 1 ? "review" : `${waiting} reviews`} waiting for you` : "";
  return `; ${[steps, takes].filter(Boolean).join(", and ")}`;
}

/** One facet changed for this run (D-88): every step here that used it goes stale and is redone; the Library is untouched. */
function change(project: Project, s: Scheduler, a: Extract<ChatReply["actions"][number], { do: "change" }>): string {
  const e = project.library.entities.get(a.entity);
  if (!e) throw new UserError(`there's no '${a.entity}' in the Library${suggest(a.entity, [...project.library.entities.keys()])}`);
  const allowed = e.kind ? project.settings.kinds[e.kind] : undefined;
  if (allowed && !allowed.includes(a.facet)) throw new UserError(`a ${e.kind} has no '${a.facet}'${suggest(a.facet, allowed)}`);
  const value = a.value.trim();
  if (!value) throw new UserError("say what it should be");
  const now = s.state.overrides.run?.[`${a.entity}.${a.facet}`] ?? e.facets[a.facet];
  let next: unknown;
  if (!a.field) {
    if (now && typeof now === "object") throw new UserError(`${a.entity}'s ${a.facet} has parts (${Object.keys(now).join(", ")}); say which one to change`);
    next = value;
  } else {
    if (typeof now === "string") throw new UserError(`${a.entity}'s ${a.facet} is just words; change it whole`);
    const old = (now as Record<string, unknown> | undefined)?.[a.field];
    if (typeof old === "string" && MEDIA.test(old)) throw new UserError(`${a.entity}'s ${a.facet} ${a.field} is a file (${old}); change that in the Library yourself`);
    next = { ...((now as Record<string, unknown> | undefined) ?? {}), [a.field]: value };
  }
  s.override("run", a.entity, a.facet, next);
  return `changed ${a.entity}'s ${a.facet}${a.field ? ` ${a.field}` : ""} to "${value}" for this run${redo(s)}`;
}

/** This run's change to a facet, written to the Library for runs from now on (D-88). Finished runs keep theirs. */
function keep(project: Project, s: Scheduler, entity: string, facet: string): string {
  const value = s.state.overrides.run?.[`${entity}.${facet}`];
  const e = project.library.entities.get(entity);
  if (value === undefined || !e) throw new UserError(`${entity}'s ${facet} hasn't been changed in this run, so there's nothing to keep`);
  writeFacet(project.root, e, facet, value);
  return `kept ${entity}'s ${facet} in the Library (${e.file}): runs from now on start with it; finished runs keep theirs`;
}

/** The conversation so far, for the terminal. */
export function threadLines(n: NodeState): string[] {
  return n.thread.flatMap((t) => [`${t.by === "you" ? "you" : "kriya"}: ${t.text}`, ...(t.did ?? []).map((d) => `  · ${d}`)]);
}
