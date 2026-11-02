/**
 * A step's chat (D-87): the creator talks to one step of a run about its
 * versions, and the chat answers, and can do what a click could: lock a
 * version, or make a new one (an edit of a version, or the step made again
 * with an instruction). It never changes another step, the Library or the recipe.
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
 */
import Anthropic from "@anthropic-ai/sdk";
import { claudeCost, DEFAULT_MODEL, MissingKey, Refusal, storedImage } from "./anthropic.js";
import type { Media } from "./replicate.js";

/** Everything the chat is told about the step, built by the caller from the run's recorded state. */
export type ChatBrief = {
  /** The step's key, its name, kind, and what the recipe asks of it (prompt, goal or tool). */
  step: { key: string; name: string; kind: string; asks: string; makes: string[] };
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
  /** The story so far: the run's inputs and every step's locked output. */
  story: { inputs: Record<string, unknown>; locked: { key: string; value: unknown }[] };
  /** Pictures to look at, by version number (image outputs only). */
  images: { n: number; ref: string }[];
  /** The conversation so far, oldest first. */
  thread: { by: "you" | "kriya"; text: string }[];
  /** What the creator just said. */
  message: string;
};

/** Something the chat asks to do. The caller checks it, then does it the way a click would. */
export type ChatAction = { do: "lock"; version: number; why: string } | { do: "make"; from: number; instruction: string; how: "edit" | "redo" };

export type ChatReply = { text: string; actions: ChatAction[]; model: string; cost_usd: number };

/** Answers a message in a step's chat. */
export type Chat = (brief: ChatBrief) => Promise<ChatReply>;

const SYSTEM_CHAT = `You are the chat for one step of a kriya run: a production pipeline (a Reel, a report, an episode) where a person reviews each step's work and locks the version they want. You talk with the person about this step.

Besides answering, you can act, but only on this step:
- lock: make one of its versions the step's output. Only when the person clearly says so ("lock v3", "go with the night one"). If they only like a version, ask whether to lock it.
- make: a new version. how "edit" changes an existing version and keeps everything else (only if the step can be edited); how "redo" makes the step again from its own prompt plus your instruction. A new version costs money, so make one when the person asks for a change, never to answer a question. Write the instruction as a short, concrete change for the model ("night, warm window light; keep the pose").

Rules:
- Versions are v1, v2, v3… Always call them that.
- A lock's why is the person's own reason, copied word for word from their message (the reason only, not the command). If they gave none, leave it empty. Never write your own.
- You can't change other steps, the Library or the recipe. When the person wants that, say what would need to change and where.
- If the run is finished, it's done and frozen: talk, but don't lock or make; say so.
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
        required: ["do", "version", "why", "instruction", "how"],
        properties: {
          do: { type: "string", enum: ["lock", "make"] },
          version: { type: "integer", description: "lock: the version to lock; make: the version to start from (0 for none)" },
          why: { type: "string", description: "lock: the person's reason, word for word from their message, or empty" },
          instruction: { type: "string", description: "make: what to change; empty for lock" },
          how: { type: "string", enum: ["edit", "redo"], description: "make: edit a version, or make the step again; edit for lock" },
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
  const versions = b.versions.map((v) =>
    [
      `v${v.n}${v.locked ? " (locked)" : ""}${v.branch !== "main" ? ` [branch ${v.branch}]` : ""}: ${v.intention}`,
      `  output: ${clip(v.output, 1500)}`,
      ...(v.checks ? [`  checks: ${v.checks}`] : []),
      ...(v.prompt ? [`  made with: ${clip(v.prompt, 800)}`] : []),
      ...(v.model ? [`  model: ${v.model}`] : []),
    ].join("\n"),
  );
  const locked = b.story.locked.map((x) => `- ${x.key}: ${clip(x.value, 600)}`);
  return [
    `Step: ${b.step.name} (${b.step.key}, a ${b.step.kind} step). It makes: ${b.step.makes.join(", ") || "nothing"}.`,
    `What the recipe asks of it:\n${b.step.asks}`,
    `It ${b.canEdit ? "can" : "can't"} be edited (how: edit). The run is ${b.finished ? "finished, so it's frozen" : "in progress"}.`,
    `Its versions:\n${versions.join("\n") || "(none yet)"}`,
    `The story so far. Inputs: ${clip(b.story.inputs, 3000)}\nLocked work:\n${locked.join("\n") || "(nothing locked yet)"}`,
  ].join("\n\n");
}

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
    messages.push({ role: "user", content: [{ type: "text", text: briefText(b) }, ...pictures, { type: "text", text: `The person says: ${b.message}` }] });
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
    let got: { reply: string; actions: { do: string; version: number; why: string; instruction: string; how: string }[] };
    try {
      got = JSON.parse(text) as typeof got;
    } catch {
      throw new Error("the chat's answer was cut off or garbled; say it again");
    }
    const actions = got.actions.map((a): ChatAction =>
      a.do === "lock" ? { do: "lock", version: a.version, why: a.why } : { do: "make", from: a.version, instruction: a.instruction, how: a.how === "redo" ? "redo" : "edit" },
    );
    return { text: got.reply, actions, model: m.model, cost_usd: claudeCost(m) };
  };
}
