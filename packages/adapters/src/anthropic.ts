/**
 * Claude as a kriya provider (Day 15, D-53, D-54).
 *
 * - `llm.write` / `llm.vision` model steps: one request per candidate, the
 *   answer constrained to the step's declared outputs (structured outputs).
 * - `llm.research` (Day 34, D-74): the same, with Claude's web search and web
 *   fetch on. A long search pauses and is carried on; the pages it read are
 *   recorded as the version's references, and each search adds its cent.
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
  /** Where the judge reads the images it checks, and vision steps the images they look at (`blob:…`, project files). */
  media?: Media;
  /** The Library's names by kind, for fields typed `library.<kind>`. */
  names?: LibraryNames;
  client?: Anthropic;
  /** Used unless a step pins its own `model`. */
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Words the knowledge base adds to a step's prompt (applied tips, D-76). */
  prevent?: (node: Node) => string[];
};

const SYSTEM_STEP =
  "You are one step in a kriya recipe: a production pipeline where a person reviews the results. Do exactly what the step asks, using the inputs given. Reply with JSON that fits the schema.";

const SYSTEM_RESEARCH =
  "You are one step in a kriya recipe: a production pipeline where a person reviews the results. Find what the step asks for on the web: search, then read the pages themselves with web fetch. Prefer the original source over coverage of it. Copy facts and numbers exactly as the source gives them. Reply with JSON that fits the schema.";

/** Web search is billed per search on top of tokens (web fetch is tokens only). */
const USD_PER_SEARCH = 0.01;

const SYSTEM_AGENT =
  "You are an agent running one step of a kriya recipe: a production pipeline where a person reviews the results. Work toward the goal with your tools. Ask the person with ask_human only when you need a decision or a fact only they have. When you're done, call finish with your result; that ends the step.";

const SYSTEM_JUDGE =
  "You check one candidate made by a step in a production pipeline, before a person sees it. Look at the image closely. It passes only if every rule holds. For each rule it breaks, give one issue. Be strict about the rules and ignore everything else.";
/** The judge for written work: no image, so it reads the candidate against what the step was given. */
const SYSTEM_JUDGE_TEXT =
  "You check one candidate written by a step in a production pipeline, before a person sees it. Read it closely against what the step was asked and the material it was given: a number, name or claim that the material doesn't support is an issue. It passes only if every rule holds. For each rule it breaks, give one issue. Be strict about the rules and ignore everything else.";

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

/** The same verdict for written work: no crop, and `where` names the field or sentence. */
const TEXT_VERDICT_SCHEMA = {
  ...VERDICT_SCHEMA,
  properties: {
    ...VERDICT_SCHEMA.properties,
    issues: {
      ...VERDICT_SCHEMA.properties.issues,
      items: {
        ...VERDICT_SCHEMA.properties.issues.items,
        properties: {
          ...VERDICT_SCHEMA.properties.issues.items.properties,
          type: { type: "string", description: "a short snake_case name, e.g. unsupported_number, missing_section, advice, wrong_company" },
          where: { type: "string", description: "which field or sentence, or empty if all over" },
          fix: { type: "string", enum: ["edit", "retry"], description: "edit if one part is wrong, retry if it's wrong overall" },
          keep: { type: "string", description: "always empty" },
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

  /**
   * One `llm.research` answer: Claude with web search and web fetch. The API
   * runs the searches inside the request; when a long one pauses
   * (`pause_turn`), the paused message goes back unchanged and it carries on.
   * `params`: `max_searches` (default 5), `max_fetches` (default 5), `domains`
   * (only search these sites), `effort` (this step's own, e.g. `medium` to spend less).
   */
  const research = async (c: Anthropic, model: string, content: Anthropic.Beta.Messages.BetaContentBlockParam[], schema: Record<string, unknown>, p: Record<string, unknown>) => {
    const tools = [
      { type: "web_search_20260209", name: "web_search", max_uses: Number(p.max_searches ?? 5), ...(Array.isArray(p.domains) ? { allowed_domains: p.domains.map(String) } : {}) },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: Number(p.max_fetches ?? 5), max_content_tokens: 40000 },
    ] as unknown as Anthropic.Beta.Messages.BetaToolUnion[];
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content }];
    const pages = new Set<string>();
    let spent = 0;
    for (let round = 1; ; round++) {
      const m = await request(c, { model, system: SYSTEM_RESEARCH, output_config: { effort: (p.effort as Effort | undefined) ?? effort, format: { type: "json_schema", schema } }, tools, messages });
      const searches = (m.usage as { server_tool_use?: { web_search_requests?: number } | null }).server_tool_use?.web_search_requests ?? 0;
      spent += cost(m) + searches * USD_PER_SEARCH;
      for (const b of m.content as { type: string; content?: { type?: string; url?: string } }[]) {
        if (b.type === "web_fetch_tool_result" && b.content?.type === "web_fetch_result" && b.content.url) pages.add(b.content.url);
      }
      if (m.stop_reason !== "pause_turn") return { m, cost: Math.round(spent * 1e6) / 1e6, pages: [...pages] };
      if (round >= 6) throw new Error("the web research didn't finish after 6 rounds; try the step again, or narrow what it looks for");
      messages.push({ role: "assistant", content: m.content as unknown as Anthropic.Beta.Messages.BetaContentBlockParam[] });
    }
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
          const content = stepContent(node.prompt ?? "", ctx, node.capability === "llm.vision", opts.prevent?.(node) ?? [], opts.media);
          const prompt = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
          const references = content.flatMap((b, i) => (b.type === "image" && b.source.type === "url" ? [{ label: `image ${i + 1}`, ref: b.source.url }] : []));
          const model = node.model ?? opts.model ?? DEFAULT_MODEL;
          if (node.capability === "llm.research") {
            const found = await Promise.all(Array.from({ length: node.options }, () => research(c, model, content, schema, node.params ?? {})));
            return { outputs: found.map((f) => parseJson(f.m)), meta: found.map((f) => ({ model: f.m.model, cost_usd: f.cost, prompt, references: f.pages.map((url, i) => ({ label: `page ${i + 1}`, ref: url })) })) };
          }
          // Each candidate is its own request, so without a word on which take it is, every one finds the same obvious answer.
          const takes = Array.from({ length: node.options }, (_, i) => (node.options > 1 ? take(i + 1, node.options) : ""));
          const answers = await Promise.all(
            takes.map((t) =>
              request(c, {
                model,
                system: SYSTEM_STEP,
                output_config: { effort, format: { type: "json_schema", schema } },
                messages: [{ role: "user", content: t ? [...content, { type: "text", text: t }] : content }],
              }),
            ),
          );
          return { outputs: answers.map(parseJson), meta: answers.map((m, i) => ({ model: m.model, cost_usd: cost(m), prompt: takes[i] ? `${prompt}\n${takes[i]}` : prompt, references })) };
        },
      });
      return { ticket };
    },

    check(node, ctx, candidates) {
      if (node.kind === "agent" || !node.check?.rubric) throw new Error(`'${node.id}' has no rubric`);
      const ticket = `check:${ctx.idempotencyKey}`;
      const c = client();
      const media = opts.media;
      const rubric = node.check.rubric;
      const fields = Object.entries(node.out).filter(([, t]) => t === "image").map(([f]) => f);
      // A step with no image is written work: the judge reads it (D-73).
      const written = fields.length === 0;
      if (!written && !media) throw new Error("the judge has nowhere to read images from");
      const asked = ctx.send ?? ("prompt" in node && node.prompt ? judgeText(node.prompt, ctx) : (node.name ?? node.id));
      const rules = `Rules:\n${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
      opts.jobs.start(ticket, {
        kind: "verdicts",
        run: () =>
          Promise.all(
            candidates.map(async (cand): Promise<Judged> => {
              if (written) {
                const m = await request(c, {
                  model: opts.model ?? DEFAULT_MODEL,
                  system: SYSTEM_JUDGE_TEXT,
                  output_config: { effort, format: { type: "json_schema", schema: TEXT_VERDICT_SCHEMA } },
                  messages: [{ role: "user", content: [{ type: "text", text: `What the step was asked, with the material it was given:\n${asked}\n\nThe candidate:\n${show(cand.output)}\n\n${rules}` }] }],
                });
                return verdictOf(m, cand.version);
              }
              const images = fields.flatMap((f): Anthropic.Beta.Messages.BetaImageBlockParam[] => {
                const v = cand.output[f];
                const img = typeof v === "string" ? storedImage(media, v) : undefined;
                return img ? [img] : [];
              });
              if (images.length === 0) throw new Error(`version ${cand.version} has no image the judge can read`);
              const m = await request(c, {
                model: opts.model ?? DEFAULT_MODEL,
                system: SYSTEM_JUDGE,
                output_config: { effort, format: { type: "json_schema", schema: VERDICT_SCHEMA } },
                messages: [{ role: "user", content: [...images, { type: "text" as const, text: `What the step was asked:\n${asked}\n\n${rules}` }] }],
              });
              return verdictOf(m, cand.version);
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

/** The judge's answer as a verdict to record: empty fields dropped, `keep` only on a crop. */
function verdictOf(m: Message, version: string): Judged {
  const v = parseJson(m) as { pass: boolean; issues: { type: string; what: string; where: string; fix: string; keep: string }[] };
  const issues = v.issues.map(({ where, keep, ...i }) => ({ ...i, ...(where ? { where } : {}), ...(keep && i.fix === "crop" ? { keep } : {}) }));
  return { version, pass: v.pass && issues.length === 0, issues, model: m.model, cost_usd: cost(m) };
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

/**
 * The prompt with its `{{refs}}` filled in and the knowledge base's words after it, then any other inputs; images first for vision.
 * A vision step sees `https://` images and, given `media`, stored ones (`blob:…`), alone or in a list; a list's images are
 * labelled in order (`frames 0:`, `frames 1:`…) so the prompt can tie them to another list, like their times.
 */
function stepContent(prompt: string, ctx: StepContext, vision: boolean, prevent: string[] = [], media?: Media): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const { text: filled, used } = fill(prompt, ctx);
  const text = [filled.trim(), ...prevent].join("\n");
  const rest = Object.entries(ctx.uses).filter(([k]) => !used.has(k));
  const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  const shown = new Set<string>();
  if (vision) {
    for (const [k, v] of rest) {
      if (typeof v === "string" && /^https:\/\/\S+$/.test(v)) {
        blocks.push({ type: "image", source: { type: "url", url: v } });
        continue;
      }
      const list = Array.isArray(v) ? v : [v];
      const images = list.map((x) => (typeof x === "string" && x.startsWith("blob:") ? storedImage(media, x) : undefined));
      if (list.length === 0 || images.some((i) => !i)) continue;
      for (const [i, image] of images.entries()) {
        if (Array.isArray(v)) blocks.push({ type: "text", text: `${k} ${i}:` });
        blocks.push(image!);
      }
      shown.add(k);
    }
  }
  const inputs = rest.length ? `\n\nInputs:\n${rest.map(([k, v]) => `- ${k}: ${shown.has(k) ? "(the images above)" : show(v)}`).join("\n")}` : "";
  const parent = ctx.parent ? `\n\nStart from this version:\n${show(ctx.parent.output)}` : "";
  const change = ctx.instruction ? `\n\nChange: ${ctx.instruction}` : "";
  blocks.push({ type: "text", text: `${text.trim()}${inputs}${parent}${change}` });
  return blocks;
}

/** What a candidate is told when a step makes several: which one it is, and to differ from the rest. */
export const take = (i: number, n: number) =>
  `Take ${i} of ${n}. The other takes answer the same brief separately, so make this one a different answer, not the same one reworded. If the brief says what each take is, do take ${i}.`;

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** A stored image as an image block Claude reads, or undefined if it isn't one (a clip, a voice, a missing blob). */
function storedImage(media: Media | undefined, ref: string): Anthropic.Beta.Messages.BetaImageBlockParam | undefined {
  const img = media?.read(ref);
  if (!img) return undefined;
  if ("url" in img) return { type: "image", source: { type: "url", url: img.url } };
  if (!/^image\/(png|jpeg|webp|gif)$/.test(img.mime)) return undefined;
  return { type: "image", source: { type: "base64", media_type: img.mime as "image/png", data: Buffer.from(img.bytes).toString("base64") } };
}

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
