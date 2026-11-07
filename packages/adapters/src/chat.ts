/**
 * A step's chat (D-87): the creator talks to one step of a run about its
 * versions, and the chat answers, and can do what a click could: lock a
 * version, or make a new one (an edit of a version, or the step made again
 * with an instruction), or patch one: items of a list added, changed, removed
 * or moved by key, the rest copied exactly (D-89). A fact about a character, place or thing (a Library
 * facet: a voice, a look's words, how someone speaks) it changes for this run,
 * then asks whether to keep it in the Library for future runs (D-88). It never
 * changes another step or the recipe.
 *
 * One Claude call per message. The answer is constrained to words plus a list
 * of actions (structured outputs), so what it wants to do arrives as data that
 * the caller checks and carries out; the chat itself touches nothing. The
 * caller records the message, the answer, its exact model and its cost.
 *
 * What it knows comes in a brief: the step and what it's for, every version
 * by number with why it exists, the prompt it was made with and its checks,
 * pictures of the latest ones, and the story so far (the run's inputs and
 * every locked output). Rejected versions of other steps stay out (D-11).
 * What the creator points at with @ (D-96) is shown whole, pictures too.
 *
 * The run's chat (D-95) is the same chat for the whole run, so the creator
 * doesn't have to find a step first: "add a shot after P3-05" from anywhere.
 * It sees every step in a line, the run's own steps (not a for-each's items)
 * whole, and no pictures; each action it asks for names its step by key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { claudeCost, DEFAULT_MODEL, MissingKey, Refusal, storedImage } from "./anthropic.js";
import type { Media } from "./replicate.js";

/** Everything the chat is told about the step, built by the caller from the run's recorded state. */
export type ChatBrief = {
  /** The step's key, its name, kind, and what the recipe asks of it (prompt, goal or tool). */
  step: { key: string; name: string; kind: string; asks: string; makes: string[] };
  /** The recipe's types the step's lists hold, `shot: id (text), place (library.place), …`, so a patch can write a whole item. */
  shapes: string[];
  /** Whether an edit step refines this one, so a version can be changed instead of made again. */
  canEdit: boolean;
  /** A completed run is done and frozen: the chat can talk, but not lock or make. */
  finished: boolean;
  versions: {
    n: number;
    branch: string;
    locked: boolean;
    intention: string;
    output: Record<string, unknown>;
    prompt?: string;
    model?: string;
    checks?: string;
  }[];
  /** The Library facets this step's versions used, as they read in this run now: changed for this run, or the Library's. */
  facets: { ref: string; value: unknown; from: "this run" | "Library" }[];
  /** Everyone in the Library, `Name (kind): facet, facet`, so the chat can name a facet this step doesn't use. */
  library: string[];
  /** The story so far: the run's inputs and every step's locked output. */
  story: { inputs: Record<string, unknown>; locked: { key: string; value: unknown }[] };
  /** What the creator points at with @ in their message (D-96): what each is, what it holds, the pictures in it. */
  points: { ref: string; what: string; value: unknown; images: string[] }[];
  /** Pictures to look at, by version number (image outputs only). */
  images: { n: number; ref: string }[];
  /** The conversation so far, oldest first. */
  thread: { by: "you" | "kriya"; text: string }[];
  /** What the creator just said. */
  message: string;
};

/** Something the chat asks to do. The caller checks it, then does it the way a click would. */
export type ChatAction =
  | { do: "lock"; version: number; why: string }
  | { do: "make"; from: number; instruction: string; how: "edit" | "redo" }
  /** Items of a list added, changed, removed or moved by key (D-89); `edits` is their JSON, checked by the caller. */
  | { do: "patch"; from: number; edits: string }
  /** One facet changed for this run: `field` names a part of it (`voice`, `words`), or is empty for a facet that's just words. */
  | { do: "change"; entity: string; facet: string; field: string; value: string }
  /** This run's change to a facet, kept in the Library for future runs. */
  | { do: "keep"; entity: string; facet: string };

export type ChatReply = { text: string; actions: ChatAction[]; model: string; cost_usd: number };

/** Answers a message in a step's chat. */
export type Chat = (brief: ChatBrief) => Promise<ChatReply>;

/** One step as a chat sees it: what it is and is asked, what its lists hold, its versions, the facets they used. */
export type StepBrief = Pick<ChatBrief, "step" | "shapes" | "canEdit" | "versions" | "facets">;

/** Everything the run's chat is told (D-95), built by the caller from the run's recorded state. */
export type RunChatBrief = {
  run: { id: string; recipe: string };
  /** A completed run is done and frozen: the chat can talk, but not lock or make. */
  finished: boolean;
  /** Every step that has started, a line each: its key, name and kind, where it is, its versions and lock. */
  steps: string[];
  /** The run's own steps that have versions (not a for-each's items), whole, as their own chat sees them. */
  whole: StepBrief[];
  library: string[];
  /** The story so far: the run's inputs and the locked output of every step not shown whole. */
  story: ChatBrief["story"];
  thread: ChatBrief["thread"];
  message: string;
};

/** Something the run's chat asks to do, and the step it's for by key (empty for change and keep: a facet is the run's). */
export type RunChatAction = ChatAction & { step: string };

export type RunChatReply = { text: string; actions: RunChatAction[]; model: string; cost_usd: number };

/** Answers a message in the run's chat. */
export type RunChat = (brief: RunChatBrief) => Promise<RunChatReply>;

/** What a chat can do, the same in a step's chat and the run's (D-95). */
const ACTS = `- lock: make one of the step's versions its output. Only when the person clearly says so ("lock v3", "go with the night one"). If they only like a version, ask whether to lock it.
- make: a new version of the step. how "edit" changes an existing version and keeps everything else (only if the step can be edited); how "redo" makes the step again from its own prompt plus your instruction. A new version costs money, so make one when the person asks for a change, never to answer a question. Write the instruction as a short, concrete change for the model ("night, warm window light; keep the pose").
- patch: a new version from an existing one, with items of a list (shots, lines) added, changed, removed or moved by their id, and every other item kept exactly. When the person wants some items changed ("add a shot after P3-05", "cut P3-08", "P3-06 at night"), patch, never make: make writes the whole list again and every item's work can be redone. edits is JSON, a list of: {"op":"add","field":"shots","after":"P3-05","item":{every field of the item}}, {"op":"update","field":"shots","key":"P3-06","set":{"action":"…"}}, {"op":"remove","field":"shots","key":"P3-08"}, {"op":"move","field":"shots","key":"P3-04","before":"P3-02"}, {"op":"set","field":"hook","value":"…"}. A new item gets a new id next to its neighbour's (P3-05a), never renumber the others; an item's id never changes. Keep lines and the shots that hold them in step: add or remove both.
- change: a fact about a character, place or thing, not just this version: Mitra's voice, Bheem's look words, how someone speaks. These are Library facets. A change applies to this whole run: every step in it that used the facet is redone, not only this one. Set one field at a time (field is the part of the facet, like "voice" or "words"; empty when the facet is just words). Never change a file (a sheet, a sample): say the person has to change that in the Library. Use change when the person talks about the character or thing ("Mitra should sound older"); use make when it's about this one version ("make him smile here").
- keep: after a change, ask whether to keep it for future runs (the next episodes). Only if they say yes, keep it: it's written to the Library. If they say no, do nothing: it stays in this run only. Runs already finished never change.`;

const SYSTEM_CHAT = `You are the chat for one step of a kriya run: a production pipeline (a Reel, a report, an episode) where a person reviews each step's work and locks the version they want. You talk with the person about this step.

Besides answering, you can act:
${ACTS}

Rules:
- Versions are v1, v2, v3… Always call them that.
- A lock's why is the person's own reason, copied word for word from their message (the reason only, not the command). If they gave none, leave it empty. Never write your own.
- Write patch edits from the version's output and the item shapes below; use the Library's names exactly.
- You can't change other steps, the Library or the recipe. When the person wants that, say what would need to change and where.
- If the run is finished, it's done and frozen: talk, but don't lock, make or change; say so. You can still keep a change made earlier.
- When the person points at something with @ (@Mitra, @shot_list v2), it's shown to you whole under "What the person points at": read it there. It's for you to look at; you still act only on this step and the Library's facets.
- Answer from what's recorded (prompts, checks, pictures). If you can't tell, say so.
- Be brief and plain. Answer in the person's language.`;

const SYSTEM_RUN_CHAT = `You are the chat for a whole kriya run: a production pipeline (a Reel, a report, an episode) where a person reviews each step's work and locks the version they want. You talk with the person about the run and any of its steps, so they don't have to find the step first.

Every step that has started is listed by its key. The run's own steps are shown whole, with their versions' outputs. Steps inside a for-each (keys like per_shot[P3-04].draw) are a line each: you can lock or make their versions by number, but you can't see their pictures; for a question about how one looks, send the person to that step's own chat.

Besides answering, you can act on a step. Every action names its step by its key, exactly as listed, and only a step that has versions (change and keep name none):
${ACTS}

Rules:
- Versions are v1, v2, v3… within each step. Always say which step's ("v2 of Break it into shots").
- A lock's why is the person's own reason, copied word for word from their message (the reason only, not the command). If they gave none, leave it empty. Never write your own.
- Write patch edits from the step's output and the item shapes shown with it; use the Library's names exactly.
- When it isn't clear which step the person means and the readings differ in cost (a whole shot list or one panel), ask; otherwise act on the likeliest and say which step you used.
- You can't change the Library's files or the recipe. When the person wants that, say what would need to change and where.
- If the run is finished, it's done and frozen: talk, but don't lock, make or change; say so. You can still keep a change made earlier.
- Answer from what's recorded. If you can't tell, say so.
- Be brief and plain. Answer in the person's language.`;

/** One action's fields, all required by the API (unused ones 0 or empty). */
const ACTION_FIELDS = {
  do: { type: "string", enum: ["lock", "make", "patch", "change", "keep"] },
  version: { type: "integer", description: "lock: the version to lock; make, patch: the version to start from; otherwise 0" },
  why: { type: "string", description: "lock: the person's reason, word for word from their message, or empty" },
  instruction: { type: "string", description: "make: what to change; otherwise empty" },
  how: { type: "string", enum: ["edit", "redo"], description: "make: edit a version, or make the step again; otherwise edit" },
  edits: { type: "string", description: "patch: the edits as a JSON list; otherwise empty" },
  entity: { type: "string", description: "change, keep: the Library name, e.g. Mitra; otherwise empty" },
  facet: { type: "string", description: "change, keep: the facet, e.g. voice; otherwise empty" },
  field: { type: "string", description: "change: the part of the facet to set, e.g. words, or empty if the facet is just words" },
  value: { type: "string", description: "change: the new value of that part; otherwise empty" },
};

/** The answer, as a strict JSON Schema: words, then the actions; the run's chat names each action's step (D-95). */
function replySchema(fields: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "actions"],
    properties: {
      reply: { type: "string", description: "what you say to the person" },
      actions: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(fields), properties: fields } },
    },
  };
}

const REPLY_SCHEMA = replySchema(ACTION_FIELDS);
const RUN_REPLY_SCHEMA = replySchema({ step: { type: "string", description: "the key of the step it's for, exactly as listed; empty for change and keep" }, ...ACTION_FIELDS });

const clip = (v: unknown, max: number) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** One step and its versions in words. `run` is a sentence about the run, said after whether it can be edited. */
function stepText(b: StepBrief, run = ""): string {
  const latest = b.versions.at(-1)?.n;
  const versions = b.versions.map((v) =>
    [
      `v${v.n}${v.locked ? " (locked)" : ""}${v.branch !== "main" ? ` [branch ${v.branch}]` : ""}: ${v.intention}`,
      // The locked and latest versions whole: a patch names items by id, and a 13-shot list runs past 1500.
      `  output: ${clip(v.output, v.locked || v.n === latest ? 30000 : 1500)}`,
      ...(v.checks ? [`  checks: ${v.checks}`] : []),
      ...(v.prompt ? [`  made with: ${clip(v.prompt, 800)}`] : []),
      ...(v.model ? [`  model: ${v.model}`] : []),
    ].join("\n"),
  );
  const facets = b.facets.map((f) => `- ${f.ref} (${f.from === "this run" ? "changed for this run" : "from the Library"}): ${clip(f.value, 600)}`);
  return [
    `Step: ${b.step.name} (${b.step.key}, a ${b.step.kind} step). It makes: ${b.step.makes.join(", ") || "nothing"}.`,
    `What the recipe asks of it:\n${b.step.asks}`,
    ...(b.shapes.length ? [`What its lists hold:\n${b.shapes.join("\n")}`] : []),
    `It ${b.canEdit ? "can" : "can't"} be edited (how: edit).${run ? ` ${run}` : ""}`,
    `Its versions:\n${versions.join("\n") || "(none yet)"}`,
    `Library facets it uses:\n${facets.join("\n") || "(none)"}`,
  ].join("\n\n");
}

/** Who's in the Library and the story so far, the same for a step's chat and the run's. */
function storyText(b: { library: string[]; story: ChatBrief["story"] }): string[] {
  const locked = b.story.locked.map((x) => `- ${x.key}: ${clip(x.value, 600)}`);
  return [`In the Library: ${b.library.join("; ") || "(nobody yet)"}`, `The story so far. Inputs: ${clip(b.story.inputs, 3000)}\nLocked work:\n${locked.join("\n") || "(nothing locked yet)"}`];
}

/** The step and its versions in words, for the chat to read. */
export function briefText(b: ChatBrief): string {
  const points = b.points.map((p) => `- ${p.ref}: ${p.what}\n  ${clip(p.value, 8000)}`);
  return [
    stepText(b, `The run is ${b.finished ? "finished, so it's frozen" : "in progress"}.`),
    ...storyText(b),
    ...(points.length ? [`What the person points at:\n${points.join("\n")}`] : []),
  ].join("\n\n");
}

/** The run in words (D-95): every step in a line, its own steps whole, the story so far. */
export function runBriefText(b: RunChatBrief): string {
  return [
    `Run: ${b.run.id} (recipe ${b.run.recipe}). It's ${b.finished ? "finished, so it's frozen" : "in progress"}.`,
    `Its steps, a line each:\n${b.steps.join("\n") || "(none started yet)"}`,
    ...b.whole.map((x) => stepText(x)),
    ...storyText(b),
  ].join("\n\n");
}

type Opts = { client?: Anthropic; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; media?: Media };
type Raw = { reply: string; actions: { step?: string; do: string; version: number; why: string; instruction: string; how: string; edits: string; entity: string; facet: string; field: string; value: string }[] };

/** One Claude call: the conversation so far, then this message; the answer as the schema's JSON, with the exact model and cost. */
function asker(opts: Opts) {
  let made: Anthropic | undefined;
  return async (system: string, schema: Record<string, unknown>, thread: ChatBrief["thread"], content: Anthropic.Beta.Messages.BetaContentBlockParam[]) => {
    const c = opts.client ?? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? (made ??= new Anthropic()) : undefined);
    if (!c) throw new MissingKey();
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [];
    // Earlier messages as they were said; one role after another, as the API needs.
    for (const t of thread) {
      const role = t.by === "you" ? "user" : "assistant";
      const last = messages.at(-1);
      if (last?.role === role) last.content = `${String(last.content)}\n\n${t.text}`;
      else messages.push({ role, content: t.text });
    }
    if (messages.at(-1)?.role === "user") messages.push({ role: "assistant", content: "(no answer)" });
    messages.push({ role: "user", content });
    const m = await c.beta.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 8000,
      system,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema } },
      messages,
    });
    if (m.stop_reason === "refusal") throw new Refusal("Claude declined to answer that");
    const text = m.content.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("");
    try {
      return { got: JSON.parse(text) as Raw, model: m.model, cost_usd: claudeCost(m) };
    } catch {
      throw new Error("the chat's answer was cut off or garbled; say it again");
    }
  };
}

/** An action as the API wrote it, with only the fields its kind uses. */
function action(a: Raw["actions"][number]): ChatAction {
  if (a.do === "lock") return { do: "lock", version: a.version, why: a.why };
  if (a.do === "patch") return { do: "patch", from: a.version, edits: a.edits };
  if (a.do === "change") return { do: "change", entity: a.entity, facet: a.facet, field: a.field, value: a.value };
  if (a.do === "keep") return { do: "keep", entity: a.entity, facet: a.facet };
  return { do: "make", from: a.version, instruction: a.instruction, how: a.how === "redo" ? "redo" : "edit" };
}

/** How many pictures of what the person points at the chat sees, across everything pointed at. */
const POINTED_PICTURES = 6;

/** The chat on Claude. */
export function claudeChat(opts: Opts = {}): Chat {
  const ask = asker(opts);
  return async (b) => {
    const pictures = b.images.flatMap(({ n, ref }) => {
      const img = storedImage(opts.media, ref);
      return img ? [{ type: "text" as const, text: `v${n}:` }, img] : [];
    });
    // Pictures of what was pointed at, a few at most: the rest are named in the brief.
    const pointed = b.points
      .flatMap((p) => p.images.map((ref) => ({ label: p.ref, img: storedImage(opts.media, ref) })))
      .filter((x) => x.img)
      .slice(0, POINTED_PICTURES)
      .flatMap(({ label, img }) => [{ type: "text" as const, text: `${label}:` }, img!]);
    const { got, model, cost_usd } = await ask(SYSTEM_CHAT, REPLY_SCHEMA, b.thread, [{ type: "text", text: briefText(b) }, ...pictures, ...pointed, { type: "text", text: `The person says: ${b.message}` }]);
    return { text: got.reply, actions: got.actions.map(action), model, cost_usd };
  };
}

/** The run's chat on Claude (D-95): no pictures, so no media. */
export function claudeRunChat(opts: Omit<Opts, "media"> = {}): RunChat {
  const ask = asker(opts);
  return async (b) => {
    const { got, model, cost_usd } = await ask(SYSTEM_RUN_CHAT, RUN_REPLY_SCHEMA, b.thread, [{ type: "text", text: runBriefText(b) }, { type: "text", text: `The person says: ${b.message}` }]);
    return { text: got.reply, actions: got.actions.map((a) => ({ ...action(a), step: a.step ?? "" })), model, cost_usd };
  };
}
