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

const SYSTEM_CHAT = `You are the chat for one step of a kriya run: a production pipeline (a Reel, a report, an episode) where a person reviews each step's work and locks the version they want. You talk with the person about this step.

Besides answering, you can act:
- lock: make one of this step's versions its output. Only when the person clearly says so ("lock v3", "go with the night one"). If they only like a version, ask whether to lock it.
- make: a new version of this step. how "edit" changes an existing version and keeps everything else (only if the step can be edited); how "redo" makes the step again from its own prompt plus your instruction. A new version costs money, so make one when the person asks for a change, never to answer a question. Write the instruction as a short, concrete change for the model ("night, warm window light; keep the pose").
- patch: a new version from an existing one, with items of a list (shots, lines) added, changed, removed or moved by their id, and every other item kept exactly. When the person wants some items changed ("add a shot after P3-05", "cut P3-08", "P3-06 at night"), patch, never make: make writes the whole list again and every item's work can be redone. edits is JSON, a list of: {"op":"add","field":"shots","after":"P3-05","item":{every field of the item}}, {"op":"update","field":"shots","key":"P3-06","set":{"action":"…"}}, {"op":"remove","field":"shots","key":"P3-08"}, {"op":"move","field":"shots","key":"P3-04","before":"P3-02"}, {"op":"set","field":"hook","value":"…"}. A new item gets a new id next to its neighbour's (P3-05a), never renumber the others; an item's id never changes. Keep lines and the shots that hold them in step: add or remove both.
- change: a fact about a character, place or thing, not just this version: Mitra's voice, Bheem's look words, how someone speaks. These are Library facets. A change applies to this whole run: every step in it that used the facet is redone, not only this one. Set one field at a time (field is the part of the facet, like "voice" or "words"; empty when the facet is just words). Never change a file (a sheet, a sample): say the person has to change that in the Library. Use change when the person talks about the character or thing ("Mitra should sound older"); use make when it's about this one version ("make him smile here").
- keep: after a change, ask whether to keep it for future runs (the next episodes). Only if they say yes, keep it: it's written to the Library. If they say no, do nothing: it stays in this run only. Runs already finished never change.

Rules:
- Versions are v1, v2, v3… Always call them that.
- A lock's why is the person's own reason, copied word for word from their message (the reason only, not the command). If they gave none, leave it empty. Never write your own.
- Write patch edits from the version's output and the item shapes below; use the Library's names exactly.
- You can't change other steps, the Library or the recipe. When the person wants that, say what would need to change and where.
- If the run is finished, it's done and frozen: talk, but don't lock, make or change; say so. You can still keep a change made earlier.
- When the person points at something with @ (@Mitra, @shot_list v2), it's shown to you whole under "What the person points at": read it there. It's for you to look at; you still act only on this step and the Library's facets.
- Answer from what's recorded (prompts, checks, pictures). If you can't tell, say so.
- Be brief and plain. Answer in the person's language.`;

/** The answer, as a strict JSON Schema: words, then the actions (unused fields 0 or empty). */
const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "actions"],
  properties: {
    reply: { type: "string", description: "what you say to the person" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["do", "version", "why", "instruction", "how", "edits", "entity", "facet", "field", "value"],
        properties: {
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
        },
      },
    },
  },
};

/** The step and its versions in words, for the chat to read. */
export function briefText(b: ChatBrief): string {
  const clip = (v: unknown, max: number) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
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
  const locked = b.story.locked.map((x) => `- ${x.key}: ${clip(x.value, 600)}`);
  const points = b.points.map((p) => `- ${p.ref}: ${p.what}\n  ${clip(p.value, 8000)}`);
  const facets = b.facets.map((f) => `- ${f.ref} (${f.from === "this run" ? "changed for this run" : "from the Library"}): ${clip(f.value, 600)}`);
  return [
    `Step: ${b.step.name} (${b.step.key}, a ${b.step.kind} step). It makes: ${b.step.makes.join(", ") || "nothing"}.`,
    `What the recipe asks of it:\n${b.step.asks}`,
    ...(b.shapes.length ? [`What its lists hold:\n${b.shapes.join("\n")}`] : []),
    `It ${b.canEdit ? "can" : "can't"} be edited (how: edit). The run is ${b.finished ? "finished, so it's frozen" : "in progress"}.`,
    `Its versions:\n${versions.join("\n") || "(none yet)"}`,
    `Library facets it uses:\n${facets.join("\n") || "(none)"}`,
    `In the Library: ${b.library.join("; ") || "(nobody yet)"}`,
    `The story so far. Inputs: ${clip(b.story.inputs, 3000)}\nLocked work:\n${locked.join("\n") || "(nothing locked yet)"}`,
    ...(points.length ? [`What the person points at:\n${points.join("\n")}`] : []),
  ].join("\n\n");
}

/** How many pictures of what the person points at the chat sees, across everything pointed at. */
const POINTED_PICTURES = 6;

/** The chat on Claude. */
export function claudeChat(opts: { client?: Anthropic; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; media?: Media } = {}): Chat {
  let made: Anthropic | undefined;
  return async (b) => {
    const c = opts.client ?? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? (made ??= new Anthropic()) : undefined);
    if (!c) throw new MissingKey();
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [];
    // Earlier messages as they were said; one role after another, as the API needs.
    for (const t of b.thread) {
      const role = t.by === "you" ? "user" : "assistant";
      const last = messages.at(-1);
      if (last?.role === role) last.content = `${String(last.content)}\n\n${t.text}`;
      else messages.push({ role, content: t.text });
    }
    if (messages.at(-1)?.role === "user") messages.push({ role: "assistant", content: "(no answer)" });
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
    messages.push({ role: "user", content: [{ type: "text", text: briefText(b) }, ...pictures, ...pointed, { type: "text", text: `The person says: ${b.message}` }] });
    const m = await c.beta.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 8000,
      system: SYSTEM_CHAT,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: REPLY_SCHEMA } },
      messages,
    });
    if (m.stop_reason === "refusal") throw new Refusal("Claude declined to answer that");
    const text = m.content.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("");
    let got: { reply: string; actions: { do: string; version: number; why: string; instruction: string; how: string; edits: string; entity: string; facet: string; field: string; value: string }[] };
    try {
      got = JSON.parse(text) as typeof got;
    } catch {
      throw new Error("the chat's answer was cut off or garbled; say it again");
    }
    const actions = got.actions.map((a): ChatAction => {
      if (a.do === "lock") return { do: "lock", version: a.version, why: a.why };
      if (a.do === "patch") return { do: "patch", from: a.version, edits: a.edits };
      if (a.do === "change") return { do: "change", entity: a.entity, facet: a.facet, field: a.field, value: a.value };
      if (a.do === "keep") return { do: "keep", entity: a.entity, facet: a.facet };
      return { do: "make", from: a.version, instruction: a.instruction, how: a.how === "redo" ? "redo" : "edit" };
    });
    return { text: got.reply, actions, model: m.model, cost_usd: claudeCost(m) };
  };
}
