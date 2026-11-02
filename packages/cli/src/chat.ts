/**
 * Talking to a step (D-87), for `kriya chat` and the browser: what the chat is
 * told, and what is done with its answer.
 *
 * A message is recorded first (`ChatSaid`), then the chat answers from a brief
 * of the run's recorded state. What it asks to do is checked here and done the
 * way a click would do it, through the scheduler: a lock (answering the screen
 * that waits for it, if one does) or a new version (`make`). Then the answer is
 * recorded with what was done (`ChatAnswered`). The chat never touches the run
 * itself.
 *
 * A completed run is done and frozen: the chat talks about it, but nothing in
 * it is locked or made. In a run still going, a lock that leaves later work
 * stale has that work redone at once: in progress follows the change.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeChat, describeError, type Chat, type ChatBrief, type ChatReply, type Media } from "@kriya/adapters";
import { findGraph, intention, numbers, type NodeState, type RunState, type Scheduler } from "@kriya/engine";
import { fakeChat } from "./fake.js";
import { UserError, type Project } from "./project.js";

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
    story: { inputs: state.inputs, locked: lockedWork(state, key) },
    images: byNumber.filter((v) => shown.has(v.id)).flatMap((v) => Object.values(v.output).filter((x): x is string => typeof x === "string" && x.startsWith("blob:")).map((ref) => ({ n: num[v.id]!, ref }))),
    thread: n.thread.map((t) => ({ by: t.by, text: t.text })),
    message,
  };
}

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
 * One message to a step: recorded, answered, its actions done, the answer
 * recorded. The caller then drives the run (`drive`), since a new version or a
 * lock may set work going.
 */
export async function talk(project: Project, s: Scheduler, state: () => RunState, chat: Chat, key: string, text: string): Promise<Talked> {
  const message = text.trim();
  if (!message) throw new UserError("say something to the step, e.g. kriya chat <run> <step> \"why is v2 darker?\"");
  const brief = chatBrief(project, state(), key, message);
  s.said(key, message);
  const reply = await chat(brief);
  const did = reply.actions.map((a) => {
    try {
      return act(s, state, key, a, message);
    } catch (e) {
      return `couldn't ${a.do === "lock" ? `lock v${a.version}` : "make a new version"}: ${describeError(e)}`;
    }
  });
  s.answered(key, { text: reply.text, did, model: reply.model, cost_usd: reply.cost_usd });
  return { reply, did };
}

/** Does one thing the chat asked for, the way a click would, and says what was done. */
function act(s: Scheduler, state: () => RunState, key: string, a: ChatReply["actions"][number], message: string): string {
  if (state().status === "completed") return `didn't ${a.do === "lock" ? "lock" : "make"} anything: this run is finished, so it stays as it is`;
  const n = state().nodes[key]!;
  const byNumber = Object.fromEntries(Object.entries(numbers(n)).map(([id, k]) => [k, id]));
  if (a.do === "lock") {
    const id = byNumber[a.version];
    if (!id) return `couldn't lock v${a.version}: there's no v${a.version}`;
    // A lock's why is the creator's own words (D-29): anything the chat wrote itself is left out.
    const why = a.why.trim() && message.includes(a.why.trim()) ? a.why.trim() : undefined;
    s.choose(key, id, why);
    const stale = s.stale();
    if (stale.length === 0) return `locked v${a.version}`;
    s.rebuild();
    return `locked v${a.version}; redoing ${stale.length} step${stale.length === 1 ? "" : "s"} that used the old one`;
  }
  const from = a.from > 0 ? byNumber[a.from] : undefined;
  if (a.from > 0 && !from) return `couldn't make a new version: there's no v${a.from}`;
  const maker = s.make(key, { ...(from ? { from } : {}), instruction: a.instruction, redo: a.how === "redo" });
  return `making a new version${from ? ` from v${a.from}` : ""}${maker !== key ? ` with ${maker.split(".").at(-1)}` : ""}: ${a.instruction}`;
}

/** The conversation so far, for the terminal. */
export function threadLines(n: NodeState): string[] {
  return n.thread.flatMap((t) => [`${t.by === "you" ? "you" : "kriya"}: ${t.text}`, ...(t.did ?? []).map((d) => `  · ${d}`)]);
}
