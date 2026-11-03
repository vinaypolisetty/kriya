/**
 * The chat eval: a step's chat (D-87) on real Claude, against real briefs
 * (capture.ts), checked on what it does, never on its words. The words change
 * every time; the actions are data, and a wrong one locks the wrong version or
 * spends money.
 *
 * Each case is a brief, a message (and sometimes a conversation before it) and
 * what should be done. Every answer of every case is also held to the rules
 * that always apply: a lock's why is the creator's own words (D-29), a
 * finished run is frozen, versions named exist, a change never sets a file,
 * a patch applies the way a click's would (D-89). A case runs a few times and
 * passes only if every run does: one miss in three means the prompt leaves
 * room for it.
 *
 * Not part of `pnpm test`: it calls Claude and costs money (it prints how
 * much). Run it when the chat's prompt, schema or brief changes, or the model.
 *
 *   pnpm eval:chat [--repeat 3] [--only <case>] [--model <id>] [--effort <level>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeChat, sniff, type ChatAction, type ChatBrief, type ChatReply, type Media } from "@kriya/adapters";
import { applyEdits, type Graph } from "@kriya/engine";
import { parseEdits } from "../src/chat.js";
import { FIXTURES, listIn, ROLES, type Meta, type Role, type Shape } from "./capture.js";

type Thread = ChatBrief["thread"];
type Case = {
  name: string;
  on: Role;
  thread?: (b: ChatBrief) => Thread;
  say: (b: ChatBrief) => string;
  /** What's wrong with the actions, or nothing. */
  expect: (a: ChatAction[], b: ChatBrief) => string | undefined;
};

// ── what the cases are about, read from the brief so any project's snapshot works ──
/** The character a step uses, by facet: `Mitra` for `Mitra.voice`. */
const who = (b: ChatBrief, facet: string) => b.facets.find((f) => f.ref.endsWith(`.${facet}`) && b.library.some((l) => l.startsWith(`${f.ref.slice(0, -facet.length - 1)} (character)`)))?.ref.slice(0, -facet.length - 1) ?? "?";
const ids = (b: ChatBrief) => listIn(b.versions.at(-1)!.output)!.ids;
const field = (b: ChatBrief) => listIn(b.versions.at(-1)!.output)!.field;
const latest = (b: ChatBrief) => b.versions.at(-1)!.n;

// ── expectations ──
const none = (a: ChatAction[]) => (a.length ? `did ${a.map((x) => x.do).join(", ")}; expected nothing` : undefined);
const only = <D extends ChatAction["do"]>(a: ChatAction[], d: D): Extract<ChatAction, { do: D }> | string => {
  if (a.length !== 1 || a[0]!.do !== d) return `did [${a.map((x) => x.do).join(", ") || "nothing"}]; expected one ${d}`;
  return a[0] as Extract<ChatAction, { do: D }>;
};
const edits = (a: Extract<ChatAction, { do: "patch" }>) => parseEdits(a.edits);

const CASES: Case[] = [
  // Locks: only when said, with the creator's reason.
  {
    name: "lock with a reason",
    on: "draw",
    say: () => "lock v2, the light on his face is right",
    expect: (a) => {
      const l = only(a, "lock");
      if (typeof l === "string") return l;
      if (l.version !== 2) return `locked v${l.version}`;
      return /light on his face is right/.test(l.why) ? undefined : `why was "${l.why}"`;
    },
  },
  { name: "lock in Hinglish", on: "draw", say: () => "v1 lock kar do", expect: (a) => { const l = only(a, "lock"); return typeof l === "string" ? l : l.version === 1 ? undefined : `locked v${l.version}`; } },
  { name: "lock by description", on: "draw", say: () => "go with the second one", expect: (a) => { const l = only(a, "lock"); return typeof l === "string" ? l : l.version === 2 ? undefined : `locked v${l.version}`; } },
  { name: "liking isn't locking", on: "draw", say: () => "I like v1", expect: none },
  // A question never costs money.
  { name: "a question does nothing", on: "draw", say: () => "why does v1 look so different from v2?", expect: none },
  // This version vs the character.
  {
    name: "a change to this picture is an edit",
    on: "draw",
    say: () => "make v1 in bright daylight, keep everything else",
    expect: (a) => {
      const m = only(a, "make");
      if (typeof m === "string") return m;
      return m.from === 1 && m.how === "edit" ? undefined : `made from v${m.from} by ${m.how}`;
    },
  },
  {
    name: "a fact about a character is a change",
    on: "draw",
    say: (b) => `${who(b, "look")} should always wear a red scarf, in every shot`,
    expect: (a, b) => {
      const c = only(a, "change");
      if (typeof c === "string") return c;
      return c.entity === who(b, "look") && c.facet === "look" && c.field === "words" ? undefined : `changed ${c.entity}.${c.facet}.${c.field}`;
    },
  },
  { name: "a file isn't changed by word", on: "draw", say: (b) => `use a different character sheet for ${who(b, "look")}, the new drawing is better`, expect: (a) => (a.some((x) => x.do === "change") ? "changed a facet; a sheet is a file" : undefined) },
  // Voices: the change, then whether to keep it.
  {
    name: "a voice change is a change",
    on: "voice",
    say: (b) => `${who(b, "voice")} should sound older and hoarse`,
    expect: (a, b) => {
      const c = only(a, "change");
      if (typeof c === "string") return c;
      return c.entity === who(b, "voice") && c.facet === "voice" && c.field === "words" ? undefined : `changed ${c.entity}.${c.facet}.${c.field}`;
    },
  },
  {
    name: "yes keeps it",
    on: "voice",
    thread: (b) => changed(b),
    say: () => "yes, keep it",
    expect: (a, b) => {
      const k = only(a, "keep");
      if (typeof k === "string") return k;
      return k.entity === who(b, "voice") && k.facet === "voice" ? undefined : `kept ${k.entity}.${k.facet}`;
    },
  },
  { name: "no leaves it in this run", on: "voice", thread: (b) => changed(b), say: () => "no, just this episode", expect: none },
  {
    name: "a retake is a new version, not a change",
    on: "voice",
    say: () => "this take sounds rushed, do it again with a pause before the last word",
    expect: (a) => { const m = only(a, "make"); return typeof m === "string" ? m : undefined; },
  },
  // A finished run talks, and does nothing.
  { name: "finished: no lock", on: "finished", say: () => "lock v2", expect: none },
  { name: "finished: no new version", on: "finished", say: () => "make v2 at night", expect: none },
  // A list is patched by key, never written again (D-89).
  {
    name: "cut one item",
    on: "list",
    say: (b) => `cut ${ids(b)[2]}`,
    expect: (a, b) => {
      const p = only(a, "patch");
      if (typeof p === "string") return p;
      const e = edits(p).filter((x) => x.field === field(b));
      return e.length === 1 && e[0]!.op === "remove" && e[0]!.key === ids(b)[2] ? undefined : `edits to ${field(b)}: ${JSON.stringify(e)}`;
    },
  },
  {
    name: "add one item",
    on: "list",
    say: (b) => `add a shot after ${ids(b)[1]} where everyone looks up at the sky`,
    expect: (a, b) => {
      const p = only(a, "patch");
      if (typeof p === "string") return p;
      const e = edits(p).filter((x) => x.field === field(b));
      if (e.length !== 1 || e[0]!.op !== "add" || e[0]!.after !== ids(b)[1]) return `edits to ${field(b)}: ${JSON.stringify(e).slice(0, 300)}`;
      const id = (e[0]!.item as { id?: unknown }).id;
      return typeof id === "string" && !ids(b).includes(id) ? undefined : `the new item's id is ${JSON.stringify(id)}`;
    },
  },
  {
    name: "change one item",
    on: "list",
    say: (b) => `${ids(b)[0]} at night`,
    expect: (a, b) => {
      const p = only(a, "patch");
      if (typeof p === "string") return p;
      const e = edits(p).filter((x) => x.field === field(b));
      return e.length === 1 && e[0]!.op === "update" && e[0]!.key === ids(b)[0] ? undefined : `edits to ${field(b)}: ${JSON.stringify(e).slice(0, 300)}`;
    },
  },
  {
    name: "a new hook is set, not remade",
    on: "list",
    say: () => "the hook is flat, make it a question that makes you want the next part",
    expect: (a, b) => {
      const p = only(a, "patch");
      if (typeof p === "string") return p;
      const e = edits(p);
      return e.length === 1 && e[0]!.op === "set" && e[0]!.field !== field(b) ? undefined : `edits: ${JSON.stringify(e).slice(0, 300)}`;
    },
  },
];

/** A conversation where the chat has just changed the character's voice for this run and asked whether to keep it. */
function changed(b: ChatBrief): Thread {
  const c = who(b, "voice");
  return [
    { by: "you", text: `${c} should sound older and hoarse` },
    { by: "kriya", text: `Changed ${c}'s voice to "an old man, hoarse and slow" for this run; the lines that use it are being redone. Keep it for future episodes too?` },
  ];
}

// ── the rules every answer keeps ──
const FILE = /\.(png|jpe?g|webp|gif|wav|mp3|m4a|mp4|mov)$/i;
function rules(b: ChatBrief, message: string, a: ChatAction[], shape: Shape | undefined): string[] {
  const problems: string[] = [];
  const has = (n: number) => b.versions.some((v) => v.n === n);
  for (const x of a) {
    if (b.finished && x.do !== "keep") problems.push(`${x.do} in a finished run`);
    if (x.do === "lock") {
      if (!has(x.version)) problems.push(`locked v${x.version}, which isn't there`);
      if (x.why && !message.includes(x.why)) problems.push(`a lock's why that isn't the creator's words: "${x.why}"`);
    }
    if ((x.do === "make" || x.do === "patch") && x.from !== 0 && !has(x.from)) problems.push(`${x.do} from v${x.from}, which isn't there`);
    if (x.do === "make" && !x.instruction.trim()) problems.push("a make with no instruction");
    if (x.do === "change") {
      const now = b.facets.find((f) => f.ref === `${x.entity}.${x.facet}`)?.value;
      const was = now && typeof now === "object" ? (now as Record<string, unknown>)[x.field] : undefined;
      if (FILE.test(x.value) || (typeof was === "string" && FILE.test(was))) problems.push(`changed a file: ${x.entity}.${x.facet}.${x.field}`);
    }
    if (x.do === "patch") {
      try {
        const base = b.versions.find((v) => v.n === (x.from || latest(b)))!.output;
        if (shape) applyEdits(base, parseEdits(x.edits), { out: shape.out, types: shape.types as Graph["types"], keyOf: (f) => shape.keys[f] ?? "id", names: (k) => shape.names[k] ?? [] });
      } catch (e) {
        problems.push(`a patch a click couldn't make: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return problems;
}

// ── running it ──
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  }));
  return out;
}

async function main(argv: string[]) {
  if (!existsSync(join(FIXTURES, "meta.json"))) throw new Error(`there's no snapshot to run on. Take one from a project of yours first:\n  pnpm eval:capture <project folder> ${Object.keys(ROLES).map((r) => `${r}=<run>:<step>`).join(" ")}`);
  const meta = JSON.parse(readFileSync(join(FIXTURES, "meta.json"), "utf8")) as Meta;
  const env = join(meta.project, ".env");
  if (existsSync(env)) process.loadEnvFile(env); // keys already in the environment win
  const briefs = Object.fromEntries(Object.keys(ROLES).map((r) => [r, JSON.parse(readFileSync(join(FIXTURES, `${r}.json`), "utf8")) as ChatBrief])) as Record<Role, ChatBrief>;
  const shape = JSON.parse(readFileSync(join(FIXTURES, "list.shape.json"), "utf8")) as Shape;
  const media: Media = {
    read(ref) {
      const path = join(FIXTURES, "blobs", ref.slice("blob:".length));
      if (!ref.startsWith("blob:") || !existsSync(path)) return undefined;
      const bytes = readFileSync(path);
      return { bytes, mime: sniff(bytes) };
    },
    write: () => "",
  };
  const repeat = Number(flag(argv, "repeat") ?? 3);
  const only = flag(argv, "only");
  const model = flag(argv, "model") ?? meta.claude.model;
  const effort = (flag(argv, "effort") ?? meta.claude.effort) as Meta["claude"]["effort"];
  const chat = claudeChat({ media, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  const cases = CASES.filter((c) => !only || c.name.includes(only));
  if (cases.length === 0) throw new Error(`no case is called '${only}'. Cases: ${CASES.map((c) => c.name).join("; ")}`);

  console.log(`chat eval: ${cases.length} cases × ${repeat}, on ${Object.values(meta.steps).join(", ")} (snapshot of ${meta.at.slice(0, 10)})`);
  type Run = { reply?: ChatReply; problems: string[] };
  const jobs = cases.flatMap((c) =>
    Array.from({ length: repeat }, () => async (): Promise<Run> => {
      const b0 = briefs[c.on];
      const message = c.say(b0);
      const b = { ...b0, thread: c.thread?.(b0) ?? [], message };
      try {
        const reply = await chat(b);
        const wrong = (() => {
          try {
            return c.expect(reply.actions, b);
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        })();
        return { reply, problems: [...(wrong ? [wrong] : []), ...rules(b, message, reply.actions, shape)] };
      } catch (e) {
        return { problems: [`no answer: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }),
  );
  const runs = await pool(jobs, 4);

  let cost = 0;
  let failed = 0;
  const report = cases.map((c, i) => {
    const mine = runs.slice(i * repeat, (i + 1) * repeat);
    const passed = mine.filter((r) => r.problems.length === 0).length;
    cost += mine.reduce((s, r) => s + (r.reply?.cost_usd ?? 0), 0);
    if (passed < repeat) failed++;
    const first = mine.find((r) => r.problems.length)?.problems[0];
    console.log(`${passed === repeat ? "✓" : "✗"} ${`${passed}/${repeat}`.padEnd(5)} ${c.on.padEnd(9)} ${c.name}${first ? `\n         ${first}` : ""}`);
    return { case: c.name, on: c.on, message: c.say(briefs[c.on]), passed, runs: mine.map((r) => ({ problems: r.problems, text: r.reply?.text, actions: r.reply?.actions, model: r.reply?.model, cost_usd: r.reply?.cost_usd })) };
  });
  const file = join(FIXTURES, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ meta, model: runs.find((r) => r.reply)?.reply?.model, effort, repeat, cost_usd: cost, cases: report }, null, 2));
  console.log(`\n${cases.length - failed}/${cases.length} cases passed every run · $${cost.toFixed(2)} · answers in ${file}`);
  return failed === 0;
}

main(process.argv.slice(2)).then(
  (ok) => process.exit(ok ? 0 : 1),
  (e: unknown) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
