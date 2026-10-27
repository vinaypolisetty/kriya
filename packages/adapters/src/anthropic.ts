/**
 * Claude as a kriya provider (Day 15, D-53, D-54).
 *
 * - `llm.write` / `llm.vision` model steps: one request per candidate, the
 *   answer constrained to the step's declared outputs (structured outputs).
 * - Checks (Day 20): a judge looks at each candidate's images against the
 *   step's `check.rubric` and answers pass or the issues, each with a fix.
 * - Agent steps: one request per turn. The engine owns the loop (D-26); this
 *   rebuilds the conversation from recorded turns, append-only, so Claude's
 *   thinking blocks stay valid and the prompt cache keeps hitting.
 *
 * Every call is a job: the engine gets a ticket at once and the answer is
 * delivered when it arrives (`settle`). The exact model version and the cost
 * come back with each answer and are recorded (rule 6).
 */
import Anthropic from "@anthropic-ai/sdk";
import { BUILT_IN_TOOL_SPECS, Pending, type AgentHistory, type AgentTurnResult, type Executors, type Graph, type Judged, type Node, type StepContext, type Tools } from "@kriya/engine";
import type { Jobs } from "./jobs.js";
import type { Media } from "./replicate.js";
import { fieldsSchema, type LibraryNames } from "./schema.js";

type Beta = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** US$ per million tokens: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
const CONTEXT_WINDOW = 1_000_000;

/**
 * Refusals re-run on Anthropic's recommended fallback model, server-side, and
 * old tool results are cleared server-side (context editing doesn't count as
 * editing history, so thinking blocks stay valid).
 */
const BETAS = ["server-side-fallback-2026-07-01", "context-management-2025-06-27"];

/** Claude declined the request (`stop_reason: "refusal"`), even after the fallback model. */
export class Refusal extends Error {}

/** No key to call Claude with. Thrown before anything is sent, so the step can simply run again once a key is set. */
export class MissingKey extends Error {
  constructor() {
    super("this step needs Claude, and there's no key. Put ANTHROPIC_API_KEY=… in .env at the project root (see .env.example), then run the command again");
  }
}

export type AnthropicOptions = {
  /** The recipes, to read each step's output types. */
  graphs: Graph[];
  jobs: Jobs;
  /** Where the step's own tools are described (agents). */
  tools?: Tools;
  /** Where the judge reads the images it checks (`blob:…`, project files). */
  media?: Media;
  /** The Library's names by kind, for fields typed `library.<kind>`. */
  names?: LibraryNames;
  client?: Anthropic;
  /** Used unless a step pins its own `model`. */
  model?: string;
  effort?: Effort;
  maxTokens?: number;
};

const SYSTEM_STEP =
  "You are one step in a kriya recipe: a production pipeline where a person reviews the results. Do exactly what the step asks, using the inputs given. Reply with JSON that fits the schema.";

const SYSTEM_AGENT =
  "You are an agent running one step of a kriya recipe: a production pipeline where a person reviews the results. Work toward the goal with your tools. Ask the person with ask_human only when you need a decision or a fact only they have. When you're done, call finish with your result; that ends the step.";

const SYSTEM_JUDGE =
  "You check one candidate made by a step in a production pipeline, before a person sees it. Look at the image closely. It passes only if every rule holds. For each rule it breaks, give one issue. Be strict about the rules and ignore everything else.";

/** What the judge answers, as a strict JSON Schema: pass, and the issues with a fix for each. */
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "issues"],
  properties: {
    pass: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "what", "where", "fix", "keep"],
        properties: {
          type: { type: "string", description: "a short snake_case name, e.g. extra_character, missing_detail, readable_text, wrong_look" },
          what: { type: "string", description: "the problem in plain words" },
          where: { type: "string", description: "where in the image (e.g. right edge), or empty if all over" },
          fix: { type: "string", enum: ["crop", "edit", "retry"], description: "crop if cutting an edge removes it, edit if one detail is wrong, retry if it's wrong overall" },
          keep: { type: "string", description: "for a crop: the area to keep, as x,y,w,h fractions of the image (e.g. 0,0,0.8,1 drops the right fifth); empty otherwise" },
        },
      },
    },
  },
};

export function anthropicExecutors(opts: AnthropicOptions): Pick<Executors, "produce" | "turn" | "check" | "managesContext"> & { handles(node: Node): boolean } {
  let made: Anthropic | undefined;
  /** The client, made on the first call: a key is needed only when Claude is actually asked something. */
  const client = (): Anthropic => {
    if (opts.client) return opts.client;
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new MissingKey();
    return (made ??= new Anthropic());
  };
  const maxTokens = opts.maxTokens ?? 16000;
  const effort = opts.effort ?? "high";
  const graphOf = (node: Node) => opts.graphs.find((g) => g.nodes.includes(node));

  const request = async (c: Anthropic, params: Omit<Beta, "betas" | "fallbacks" | "max_tokens">): Promise<Message> => {
    const m = await c.beta.messages.create({ ...params, betas: BETAS, fallbacks: "default", max_tokens: maxTokens });
    if (m.stop_reason === "refusal") throw new Refusal(`Claude declined this step${m.stop_details?.category ? ` (${m.stop_details.category})` : ""}`);
    if (m.stop_reason === "max_tokens") throw new Error(`Claude's answer was cut off at ${maxTokens} tokens`);
    return m;
  };

  return {
    managesContext: true,

    handles: (node) => node.kind === "agent" || (node.kind === "model" && /^llm\./.test(node.capability)),

    produce(node, ctx) {
      if (node.kind !== "model") throw new Error(`Claude doesn't run ${node.kind} steps`);
      const ticket = `claude:${ctx.idempotencyKey}`;
      const c = client(); // before the ticket: no key, nothing starts and the step stays as it was
      const schema = fieldsSchema(node.out, graphOf(node)?.types ?? {}, opts.names);
      opts.jobs.start(ticket, {
        kind: "outputs",
        run: async () => {
          const content = stepContent(node.prompt ?? "", ctx, node.capability === "llm.vision");
          const prompt = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
          const references = content.flatMap((b, i) => (b.type === "image" && b.source.type === "url" ? [{ label: `image ${i + 1}`, ref: b.source.url }] : []));
          const answers = await Promise.all(
            Array.from({ length: node.options }, () =>
              request(c, {
                model: node.model ?? opts.model ?? DEFAULT_MODEL,
                system: SYSTEM_STEP,
                output_config: { effort, format: { type: "json_schema", schema } },
                messages: [{ role: "user", content }],
              }),
            ),
          );
          return { outputs: answers.map(parseJson), meta: answers.map((m) => ({ model: m.model, cost_usd: cost(m), prompt, references })) };
        },
      });
      return { ticket };
    },

    check(node, ctx, candidates) {
      if (node.kind === "agent" || !node.check?.rubric) throw new Error(`'${node.id}' has no rubric`);
      const ticket = `check:${ctx.idempotencyKey}`;
      const c = client();
      const media = opts.media;
      if (!media) throw new Error("the judge has nowhere to read images from");
      const rubric = node.check.rubric;
      const fields = Object.entries(node.out).filter(([, t]) => t === "image").map(([f]) => f);
      const asked = "prompt" in node && node.prompt ? judgeText(node.prompt, ctx) : (node.name ?? node.id);
      opts.jobs.start(ticket, {
        kind: "verdicts",
        run: () =>
          Promise.all(
            candidates.map(async (cand): Promise<Judged> => {
              const images = fields.flatMap((f): Anthropic.Beta.Messages.BetaImageBlockParam[] => {
                const v = cand.output[f];
                const img = typeof v === "string" ? media.read(v) : undefined;
                if (!img) return [];
                if ("url" in img) return [{ type: "image", source: { type: "url", url: img.url } }];
                if (!/^image\/(png|jpeg|webp|gif)$/.test(img.mime)) return [];
                return [{ type: "image", source: { type: "base64", media_type: img.mime as "image/png", data: Buffer.from(img.bytes).toString("base64") } }];
              });
              if (images.length === 0) throw new Error(`version ${cand.version} has no image the judge can read`);
              const m = await request(c, {
                model: opts.model ?? DEFAULT_MODEL,
                system: SYSTEM_JUDGE,
                output_config: { effort, format: { type: "json_schema", schema: VERDICT_SCHEMA } },
                messages: [{ role: "user", content: [...images, { type: "text" as const, text: `What the step was asked:\n${asked}\n\nRules:\n${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}` }] }],
              });
              const v = parseJson(m) as { pass: boolean; issues: { type: string; what: string; where: string; fix: string; keep: string }[] };
              const issues = v.issues.map(({ where, keep, ...i }) => ({ ...i, ...(where ? { where } : {}), ...(keep && i.fix === "crop" ? { keep } : {}) }));
              return { version: cand.version, pass: v.pass && issues.length === 0, issues, model: m.model, cost_usd: cost(m) };
            }),
          ),
      });
      return { ticket };
    },

    turn(node, ctx, history) {
      const ticket = `claude:${ctx.idempotencyKey}`;
      const c = client();
      const types = graphOf(node)?.types ?? {};
      opts.jobs.start(ticket, {
        kind: "turn",
        run: async () => {
          const m = await request(c, {
            model: opts.model ?? DEFAULT_MODEL,
            system: SYSTEM_AGENT,
            cache_control: { type: "ephemeral" },
            context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
            output_config: { effort },
            tools: agentTools(node.tools, opts.tools, fieldsSchema(node.out, types, opts.names)),
            messages: agentMessages(node.goal, ctx, history),
          });
          return turnResult(m, node.out);
        },
      });
      return new Pending(ticket);
    },
  };
}

/** A plain-words reason for a failed call, for the step's failure. */
export function describeError(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "Claude rejected the API key. Check ANTHROPIC_API_KEY in .env";
  if (e instanceof Anthropic.PermissionDeniedError) return "this API key can't use that Claude model";
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate-limiting this key; try the step again in a minute";
  if (e instanceof Anthropic.APIConnectionError) return "couldn't reach Claude; check your internet connection";
  if (e instanceof Anthropic.APIError) return `Claude returned an error (${e.status}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// ── Model steps ─────────────────────────────────────────────────────────────

/** A prompt or goal with its `{{refs}}` filled in from what the step received, and the refs it used. */
function fill(text: string, ctx: StepContext): { text: string; used: Set<string> } {
  const used = new Set<string>();
  const filled = text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref: string) => {
    used.add(ref);
    return show(ctx.uses[ref]);
  });
  return { text: filled, used };
}

/** A step's prompt as the judge reads it: Library facets as their words ("Bheem: a very tall bodybuilder…"). */
function judgeText(prompt: string, ctx: StepContext): string {
  const words = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(words).join("; ");
    if (v && typeof v === "object" && "entity" in v && "value" in v) {
      const f = v as { entity: string; value: unknown };
      const w = f.value && typeof f.value === "object" ? (f.value as { words?: unknown }).words : undefined;
      return typeof w === "string" ? `${f.entity} (${w})` : f.entity;
    }
    return show(v);
  };
  return prompt.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref: string) => words(ctx.uses[ref])).trim();
}

/** The prompt with its `{{refs}}` filled in, then any other inputs; images first for vision. */
function stepContent(prompt: string, ctx: StepContext, vision: boolean): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const { text, used } = fill(prompt, ctx);
  const rest = Object.entries(ctx.uses).filter(([k]) => !used.has(k));
  const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  if (vision) {
    for (const [, v] of rest) if (typeof v === "string" && /^https:\/\/\S+$/.test(v)) blocks.push({ type: "image", source: { type: "url", url: v } });
  }
  const inputs = rest.length ? `\n\nInputs:\n${rest.map(([k, v]) => `- ${k}: ${show(v)}`).join("\n")}` : "";
  const parent = ctx.parent ? `\n\nStart from this version:\n${show(ctx.parent.output)}` : "";
  const change = ctx.instruction ? `\n\nChange: ${ctx.instruction}` : "";
  blocks.push({ type: "text", text: `${text.trim()}${inputs}${parent}${change}` });
  return blocks;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function parseJson(m: Message): Record<string, unknown> {
  const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Claude's answer wasn't the JSON the step declares");
  }
}

function cost(m: Message): number {
  const p = PRICES[m.model];
  if (!p) return 0;
  const u = m.usage;
  return ((u.input_tokens ?? 0) * p[0] + (u.output_tokens ?? 0) * p[1] + (u.cache_read_input_tokens ?? 0) * p[2] + (u.cache_creation_input_tokens ?? 0) * p[3]) / 1e6;
}

// ── Agents ─────────────────────────────────────────────────────────────────

function agentTools(names: string[], tools: Tools | undefined, outSchema: Record<string, unknown>): Anthropic.Beta.Messages.BetaToolUnion[] {
  const own = names.map((name) => {
    const builtIn = BUILT_IN_TOOL_SPECS[name as keyof typeof BUILT_IN_TOOL_SPECS];
    const spec = builtIn ?? tools?.describe?.(name);
    if (!spec) throw new Error(`the tool '${name}' has no description for Claude; describe it in the tools setup`);
    return { name, description: spec.description, input_schema: spec.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema };
  });
  const builtIns = Object.entries(BUILT_IN_TOOL_SPECS)
    .filter(([name]) => !names.includes(name))
    .map(([name, spec]) => ({ name, description: spec.description, input_schema: spec.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema }));
  // Sorted by name: the tool list is part of the cached prefix and must not change between turns.
  return [...own, ...builtIns, { name: "finish", description: "End the step with your result.", input_schema: outSchema as Anthropic.Beta.Messages.BetaTool.InputSchema, strict: true }].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * The conversation so far, rebuilt from recorded turns. Append-only: every
 * earlier message is byte-identical to what was sent then, including the notes
 * as they stood after each turn.
 */
function agentMessages(goal: string, ctx: StepContext, history: AgentHistory): Anthropic.Beta.Messages.BetaMessageParam[] {
  const { text, used } = fill(goal, ctx);
  const inputs = Object.entries(ctx.uses).filter(([k]) => !used.has(k));
  const first = `Goal: ${text.trim()}${inputs.length ? `\n\nInputs:\n${inputs.map(([k, v]) => `- ${k}: ${show(v)}`).join("\n")}` : ""}`;
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: first }];
  const notes: Record<string, string> = {};
  for (const h of history) {
    const content = (h.reply.raw ?? []) as Anthropic.Beta.Messages.BetaContentBlock[];
    messages.push({ role: "assistant", content: content as unknown as Anthropic.Beta.Messages.BetaContentBlockParam[] });
    const uses = content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
    const calls = "calls" in h.reply ? h.reply.calls : [];
    const results: Anthropic.Beta.Messages.BetaContentBlockParam[] = uses.map((u, i) => {
      const r = h.results.find((x) => x.call === i + 1);
      if (r?.ok && calls[i]?.tool === "note") {
        const a = calls[i]!.args as { key: string; text: string };
        notes[a.key] = a.text;
      }
      return { type: "tool_result", tool_use_id: u.id, content: show(r?.result ?? null), is_error: r ? !r.ok : true };
    });
    if (Object.keys(notes).length) results.push({ type: "text", text: `Your notes:\n${Object.entries(notes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}` });
    messages.push({ role: "user", content: results });
  }
  return messages;
}

function turnResult(m: Message, out: Record<string, string>): AgentTurnResult {
  const raw = JSON.parse(JSON.stringify(m.content)) as unknown;
  const uses = m.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
  const finish = uses.find((u) => u.name === "finish");
  const usage = { input: (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0), output: m.usage.output_tokens ?? 0 };
  const base = { tokens: usage, model: m.model, cost_usd: cost(m), context_window: CONTEXT_WINDOW };
  if (finish) return { ...base, reply: { final: finish.input as Record<string, unknown>, raw } };
  if (uses.length) return { ...base, reply: { calls: uses.map((u) => ({ tool: u.name, args: u.input })), raw } };
  // Ended without finish: a single text output can take the answer as written.
  const fields = Object.entries(out);
  const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  if (fields.length === 1 && fields[0]![1] === "text" && text) return { ...base, reply: { final: { [fields[0]![0]]: text }, raw } };
  throw new Error("Claude ended its turn without calling finish or a tool");
}
