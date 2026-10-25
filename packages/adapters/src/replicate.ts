/**
 * Replicate as a kriya provider: images (Day 16, D-56), clips, voices and
 * music (Day 17, D-58). Each capability has a default model and that model's
 * input names; kriya.yaml and a step's own `model:` / `params:` override them.
 *
 * - One prediction per candidate (`options: 3` → three). Reference images
 *   (character sheets, the panel being edited) go in as `image_input`; a clip
 *   starts from the one image its step received.
 * - Predictions live on Replicate, so a crash needn't pay twice: each one's id
 *   is written to a job ledger under the step's idempotency key right after
 *   it's created, and a restarted process polls the same predictions instead
 *   of starting new ones.
 * - Output URLs are deleted after an hour, so every file is downloaded into
 *   kriya's own blob store and recorded as `blob:<sha256>`. Clips and audio
 *   are measured from their bytes: a `seconds` field gets the real length.
 *
 * Plain `fetch`, no SDK: four HTTP calls (create, get, upload, download).
 */
import { createHash } from "node:crypto";
import type { Executors, Graph, Node, StepContext } from "@kriya/engine";
import { durationOf } from "./duration.js";
import type { Jobs } from "./jobs.js";

const API = "https://api.replicate.com/v1";

export const REPLICATE_CAPABILITIES = ["image.generate", "image.edit", "video.from_image", "audio.speech", "audio.music"] as const;
export type ReplicateCapability = (typeof REPLICATE_CAPABILITIES)[number];

/** A model's names for what kriya sends it. */
export type ModelFields = {
  /** The step's prompt; for speech, the words to say. */
  prompt?: string;
  /** Reference images (a list), or a clip's start frame (one image). */
  images?: string;
  /** Speech: the voice, from the speaker's `@voice` facet. */
  voice?: string;
  /** Speech: how to say it (the line's emotion, the voice's words, a redo note). */
  style?: string;
};

/** What each capability makes, its default model, and that model's input names. */
const CAPABILITIES: Record<ReplicateCapability, { makes: "image" | "video" | "audio"; model: string; fields: ModelFields }> = {
  "image.generate": { makes: "image", model: "google/nano-banana-2", fields: { prompt: "prompt", images: "image_input" } },
  "image.edit": { makes: "image", model: "google/nano-banana-2", fields: { prompt: "prompt", images: "image_input" } },
  "video.from_image": { makes: "video", model: "wan-video/wan-2.7-i2v", fields: { prompt: "prompt", images: "first_frame" } },
  "audio.speech": { makes: "audio", model: "google/gemini-3.1-flash-tts", fields: { prompt: "text", voice: "voice", style: "prompt" } },
  "audio.music": { makes: "audio", model: "google/lyria-2", fields: { prompt: "prompt" } },
};
export const DEFAULT_MODELS = Object.fromEntries(REPLICATE_CAPABILITIES.map((c) => [c, CAPABILITIES[c].model])) as Record<ReplicateCapability, string>;

/** What a finished prediction used, to price it. */
type Usage = { input: Record<string, unknown>; seconds: number | undefined; metrics: Record<string, unknown> };

/**
 * US$ per prediction, from Replicate's price pages (Oct 2026). Token-priced
 * models use the counts Replicate reports; the rest are estimates from the
 * output's length. Override with `price_usd` or `price_per_second_usd`.
 */
const PRICES: Record<string, (u: Usage) => number> = {
  "google/nano-banana": () => 0.039,
  "google/nano-banana-2": (u) => ({ "2K": 0.101, "4K": 0.151 })[String(u.input.resolution)] ?? 0.067,
  "wan-video/wan-2.7-i2v": (u) => (u.seconds ?? Number(u.input.duration ?? 5)) * (u.input.resolution === "720p" ? 0.1 : 0.15),
  // $2 per million input tokens, $0.04 per thousand output tokens (25 a second)
  "google/gemini-3.1-flash-tts": (u) =>
    typeof u.metrics.token_output_count === "number"
      ? Number(u.metrics.token_input_count ?? 0) * 2e-6 + u.metrics.token_output_count * 4e-5
      : (u.seconds ?? 0) * 0.001,
  "google/lyria-2": (u) => (u.seconds ?? 30) * 0.002,
};

/**
 * How one kind of step runs, set per capability in kriya.yaml and overridable
 * per step (`model:`, `params:`). Any Replicate model works: name its input
 * fields if they aren't the default model's.
 */
export type ModelSettings = {
  /** `owner/name`, or `owner/name:version` to pin a version. */
  model?: string;
  /** Inputs sent every time, e.g. `{ resolution: "2K" }` or `{ language_code: "hi-IN" }`; a step's own `params` win. */
  params?: Record<string, unknown>;
  /** The model's input names for what kriya sends. */
  fields?: ModelFields;
  /** US$ per output (an image, a clip, a line), for the cost on each version. */
  price_usd?: number;
  /** US$ per second of output, for clips and audio priced by length. */
  price_per_second_usd?: number;
};

/** Files at most this size go in as data URLs; larger ones are uploaded first (Replicate's advice). */
const INLINE_BYTES = 256 * 1024;

/** Where media comes from and goes to. The CLI reads `blob:…` from the store and image files from the project. */
export type Media = {
  /** An image a value names, or undefined if it names none. */
  read(value: string): { bytes: Uint8Array; mime: string } | { url: string } | undefined;
  /** Keeps a downloaded file; returns the value to record (`blob:<sha256>`). */
  write(bytes: Uint8Array): string;
};

/** Prediction ids by idempotency key, kept on disk, so a restart finds the jobs it already paid for. */
export type Ledger = { get(key: string): string[] | undefined; set(key: string, ids: string[]): void };

export type ReplicateOptions = {
  graphs: Graph[];
  jobs: Jobs;
  media: Media;
  ledger: Ledger;
  /** Defaults to REPLICATE_API_TOKEN, read when a call is made. */
  token?: string;
  fetch?: typeof fetch;
  /** How often to check on a running prediction. */
  pollMs?: number;
  /** Which capabilities this adapter runs; the rest go elsewhere. Default: all of them. */
  capabilities?: readonly ReplicateCapability[];
  /** Settings per capability; a step's own `model:` and `params:` win over them. */
  models?: Partial<Record<ReplicateCapability, ModelSettings>>;
};

/** No token to call Replicate with. Thrown before anything is sent, so the step can run again once one is set. */
export class MissingToken extends Error {
  constructor() {
    super("this step needs Replicate, and there's no token. Put REPLICATE_API_TOKEN=… in .env at the project root (see .env.example), then run the command again");
  }
}

/** A Replicate call that failed for good, in plain words. */
export class ReplicateError extends Error {}

type Prediction = { id: string; status: string; version: string; output: unknown; error: unknown; metrics?: Record<string, unknown> };

/** What a step's job is asked: the inputs to send, and what to record about them. */
type Ask = { input: Record<string, unknown>; prompt: string; references: { label: string; ref: string }[] };

export function replicateExecutors(opts: ReplicateOptions): Pick<Executors, "produce"> & { handles(node: Node): boolean } {
  const http = opts.fetch ?? fetch;
  const pollMs = opts.pollMs ?? 1500;
  const runs = new Set<string>(opts.capabilities ?? REPLICATE_CAPABILITIES);
  /** Uploads by content hash, kept as promises so the same image sent twice at once goes up once. */
  const uploaded = new Map<string, Promise<string>>();

  const token = () => {
    const t = opts.token ?? process.env.REPLICATE_API_TOKEN;
    if (!t) throw new MissingToken();
    return t;
  };

  const call = async <T>(t: string, path: string, init: RequestInit = {}): Promise<T> => {
    const res = await http(path.startsWith("http") ? path : `${process.env.REPLICATE_BASE_URL ?? API}${path}`, { ...init, headers: { Authorization: `Bearer ${t}`, ...(init.headers ?? {}) } });
    if (!res.ok) throw new ReplicateError(httpProblem(res.status, await res.text().catch(() => "")));
    return (await res.json()) as T;
  };

  /** An image as Replicate takes it: small ones inline, large ones uploaded once per process. */
  const asInput = async (t: string, img: Img): Promise<string> => {
    if ("url" in img) return img.url;
    if (img.bytes.length <= INLINE_BYTES) return `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}`;
    const sha = createHash("sha256").update(img.bytes).digest("hex");
    let url = uploaded.get(sha);
    if (!url) {
      const form = new FormData();
      form.append("content", new Blob([new Uint8Array(img.bytes)], { type: img.mime }), `${sha.slice(0, 12)}.${img.mime.split("/")[1] ?? "bin"}`);
      form.append("type", img.mime);
      url = call<{ urls: { get: string } }>(t, "/files", { method: "POST", body: form }).then((f) => f.urls.get);
      url.catch(() => uploaded.delete(sha)); // a failed upload can be tried again
      uploaded.set(sha, url);
    }
    return url;
  };

  const wait = async (t: string, id: string, makes: string): Promise<Prediction> => {
    const what = { image: "the image", video: "the clip", audio: "the audio" }[makes];
    for (;;) {
      const p = await call<Prediction>(t, `/predictions/${id}`);
      if (p.status === "succeeded") return p;
      if (p.status === "failed") throw new ReplicateError(`Replicate couldn't make ${what}: ${String(p.error ?? "no reason given")}`);
      if (p.status === "canceled") throw new ReplicateError(`the job for ${what} was canceled on Replicate`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };

  return {
    handles: (node) => node.kind === "model" && runs.has(node.capability),

    produce(node, ctx) {
      if (node.kind !== "model") throw new Error(`Replicate doesn't run ${node.kind} steps`);
      const t = token(); // before the ticket: no token, nothing starts
      const capability = node.capability as ReplicateCapability;
      const cap = CAPABILITIES[capability];
      if (!cap) throw new ReplicateError(`Replicate doesn't run '${node.capability}' steps; it runs ${REPLICATE_CAPABILITIES.join(", ")}`);
      const field = Object.entries(node.out).find(([, type]) => type === cap.makes)?.[0];
      if (!field) throw new ReplicateError(`'${node.id}' makes ${cap.makes === "audio" ? "audio" : `${cap.makes}s`}, so its out needs a ${cap.makes} field, e.g. out: { ${cap.makes === "video" ? "clip" : cap.makes}: ${cap.makes} }`);
      const timed = Object.entries(node.out).find(([f, type]) => f === "seconds" && type === "number")?.[0];
      const key = ctx.idempotencyKey!;
      const ticket = `replicate:${key}`;
      const settings = opts.models?.[capability] ?? {};
      const model = node.model ?? settings.model ?? cap.model;
      const [name, pinned] = model.split(":") as [string, string | undefined];
      const fields = { ...cap.fields, ...(settings.fields ?? {}) };
      const params = { ...(settings.params ?? {}), ...(node.params ?? {}) };
      const price = (u: Usage) =>
        settings.price_usd ?? (settings.price_per_second_usd !== undefined ? (u.seconds ?? 0) * settings.price_per_second_usd : (PRICES[name]?.(u) ?? 0));

      opts.jobs.start(ticket, {
        kind: "outputs",
        run: async () => {
          const ids = [...(opts.ledger.get(key) ?? [])];
          const ask =
            capability === "audio.speech"
              ? speechRequest(node, ctx, fields, settings.params ?? {}, node.params ?? {})
              : await mediaRequest(node, ctx, field, opts.media, cap.makes, fields, params, (img) => asInput(t, img));
          if (ids.length < node.options) {
            for (let i = ids.length; i < node.options; i++) {
              const created = pinned
                ? await call<Prediction>(t, "/predictions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: pinned, input: ask.input }) })
                : await call<Prediction>(t, `/models/${name}/predictions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: ask.input }) });
              ids.push(created.id);
              opts.ledger.set(key, ids); // before waiting: a restart polls this job instead of paying for another
            }
          }
          const done = await Promise.all(ids.map((id) => wait(t, id, cap.makes)));
          const outputs: Record<string, unknown>[] = [];
          const meta = [];
          for (const p of done) {
            const url = Array.isArray(p.output) ? p.output[0] : p.output;
            if (typeof url !== "string") throw new ReplicateError(`Replicate finished without ${cap.makes === "audio" ? "any audio" : `a ${cap.makes}`}`);
            const res = await http(url, { headers: { Authorization: `Bearer ${t}` } });
            if (!res.ok) throw new ReplicateError(`couldn't download the ${cap.makes} from Replicate (${res.status}); outputs are kept for an hour`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const seconds = cap.makes === "image" ? undefined : durationOf(bytes);
            if (timed && seconds === undefined) throw new ReplicateError(`'${node.id}' needs the length of its ${cap.makes} (out: seconds), and kriya can't read it from this file; it reads WAV and MP4`);
            outputs.push({ [field]: opts.media.write(bytes), ...(timed ? { [timed]: seconds } : {}) });
            // Replicate hides the version of its official models ("hidden"): then the name is all there is to record.
            meta.push({
              model: p.version && p.version !== "hidden" ? `${name}:${p.version}` : name,
              cost_usd: Math.round(price({ input: ask.input, seconds, metrics: p.metrics ?? {} }) * 1e6) / 1e6,
              prompt: ask.prompt,
              references: ask.references,
            });
          }
          return { outputs, meta };
        },
      });
      return { ticket };
    },
  };
}

type Img = { bytes: Uint8Array; mime: string } | { url: string };
type Facet = { entity: string; facet: string; value: unknown };
const isFacet = (v: unknown): v is Facet => !!v && typeof v === "object" && "value" in v && "entity" in v;
const fill = (prompt: string | undefined, sub: (ref: string) => string) => (prompt ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref: string) => sub(ref));
const refsIn = (prompt: string | undefined) => new Set([...(prompt ?? "").matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!));

/**
 * Images, clips and music: the prompt with `{{refs}}` filled in, and the images
 * the step received.
 *
 * - Images: every image is a reference (an edit's own panel first). A look
 *   facet brings its words into the prompt ("Mitra, a thin 60-year-old bald
 *   man… (image 2)") and its sheet into the references; words alone draw from
 *   the description (a minor character, a place without a sheet).
 * - Clips: the one image the step received is the start frame; looks bring
 *   their words only (the frame already shows who's who).
 * - Music: words only.
 */
async function mediaRequest(
  node: Extract<Node, { kind: "model" }>,
  ctx: StepContext,
  field: string,
  media: Media,
  makes: "image" | "video" | "audio",
  fields: ModelFields,
  params: Record<string, unknown>,
  upload: (img: Img) => Promise<string>,
): Promise<Ask> {
  const images: { label: string; img: Img }[] = [];
  const add = (label: string, v: unknown): string | undefined => {
    if (typeof v !== "string" || makes === "audio") return undefined;
    const img = media.read(v);
    if (!img) return undefined;
    images.push({ label, img });
    return makes === "image" ? `image ${images.length}` : "the start frame";
  };
  const parent = ctx.parent?.output[field];
  if (makes === "image" && parent !== undefined && !add("the image to edit", parent)) throw new ReplicateError(`the version to edit has no image kriya can read (${String(parent)})`);

  /** A received value as prompt text; images become "image N" and join the references. */
  const words = (ref: string, v: unknown): string => {
    if (Array.isArray(v)) return v.map((x, i) => words(`${ref}[${i}]`, x)).join("; ");
    if (isFacet(v)) {
      const look = (v.value && typeof v.value === "object" ? v.value : { image: v.value }) as { image?: unknown; words?: unknown };
      const n = makes === "image" ? add(`${v.entity}'s ${v.facet}`, look.image) : undefined;
      const desc = typeof look.words === "string" ? look.words : n || makes !== "image" ? undefined : typeof look.image === "string" ? look.image : undefined;
      return `${v.entity}${desc ? `, ${desc}` : ""}${n ? ` (${n})` : ""}`;
    }
    return add(ref, v) ?? (typeof v === "string" ? v : JSON.stringify(v));
  };
  const used = refsIn(node.prompt);
  let prompt = fill(node.prompt, (ref) => words(ref, ctx.uses[ref]));
  for (const [ref, v] of Object.entries(ctx.uses)) if (!used.has(ref)) words(ref, v);
  prompt = prompt.trimEnd();
  if (ctx.instruction && !prompt.includes(ctx.instruction)) prompt += `\nChange: ${ctx.instruction}`;
  if (makes === "image" && images.length) prompt += `\n\nReference images: ${images.map((x, i) => `${i + 1} = ${x.label}`).join("; ")}.`;
  prompt = prompt.trim();
  if (makes === "video" && images.length !== 1) {
    throw new ReplicateError(
      images.length === 0
        ? `'${node.id}' makes a clip from an image, and it received none. Add the panel to its uses, e.g. uses: [pick.selected]`
        : `'${node.id}' makes a clip from one image, and it received ${images.length} (${images.map((x) => x.label).join(", ")}). Keep one image in its uses`,
    );
  }

  const sent = await Promise.all(images.map((x) => upload(x.img)));
  const input: Record<string, unknown> = { ...params, [fields.prompt ?? "prompt"]: prompt };
  if (sent.length && fields.images) input[fields.images] = makes === "video" ? sent[0] : sent;
  const references = images.map((x) => ({ label: x.label, ref: "url" in x.img ? x.img.url : `sha256:${createHash("sha256").update(x.img.bytes).digest("hex")}` }));
  return { input, prompt, references };
}

/**
 * Speech: the prompt is the words to say. The voice comes from the speaker's
 * `@voice` facet: a voice name (`Charon`), or `{ voice: Charon, words: "warm,
 * slow" }`. Everything else the step received (the line's emotion, the
 * speaker's `@speech`, the voice's words, a redo note) becomes how to say it,
 * after any style the settings or the step give in `params`.
 */
function speechRequest(
  node: Extract<Node, { kind: "model" }>,
  ctx: StepContext,
  fields: ModelFields,
  base: Record<string, unknown>,
  own: Record<string, unknown>,
): Ask {
  const text = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(text).join("; ");
    if (isFacet(v)) return text(v.value);
    if (v && typeof v === "object" && "words" in v) return String((v as { words: unknown }).words);
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  const used = refsIn(node.prompt);
  const say = fill(node.prompt, (ref) => text(ctx.uses[ref])).trim();
  if (!say) throw new ReplicateError(`'${node.id}' says nothing: its prompt is the line to speak, e.g. prompt: "{{item.hinglish}}"`);

  const styleField = fields.style ?? "prompt";
  const voiceField = fields.voice ?? "voice";
  let voice: string | undefined;
  let voiceOf: string | undefined;
  const how: string[] = [own[styleField], base[styleField]].filter((x): x is string => typeof x === "string").slice(0, 1);
  for (const [ref, v] of Object.entries(ctx.uses)) {
    if (used.has(ref) || v === undefined || v === null) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      if (isFacet(one) && one.facet === "voice") {
        const val = (one.value && typeof one.value === "object" ? one.value : { voice: one.value }) as { voice?: unknown; words?: unknown };
        if (typeof val.voice === "string") [voice, voiceOf] = [val.voice, one.entity];
        if (typeof val.words === "string") how.push(`${one.entity}'s voice: ${val.words}`);
      } else if (isFacet(one)) how.push(`${one.entity}'s ${one.facet}: ${text(one.value)}`);
      else how.push(`${ref.split(".").pop()}: ${text(one)}`);
    }
  }
  if (ctx.instruction) how.push(`Change: ${ctx.instruction}`);

  // The speaker's voice beats the settings' default voice; a step's own params beat both.
  const input: Record<string, unknown> = { ...base, ...(voice ? { [voiceField]: voice } : {}), ...own, [fields.prompt ?? "text"]: say };
  if (how.length) input[styleField] = how.join("\n");
  else delete input[styleField];
  const style = input[styleField];
  const prompt = [`Say: ${say}`, typeof style === "string" ? `How: ${style.replace(/\n/g, "\n     ")}` : undefined, input[voiceField] !== undefined ? `Voice: ${String(input[voiceField])}` : undefined].filter(Boolean).join("\n");
  return { input, prompt, references: voice ? [{ label: `${voiceOf}'s voice`, ref: voice }] : [] };
}

function httpProblem(status: number, body: string): string {
  const detail = (() => {
    try {
      return String((JSON.parse(body) as { detail?: unknown }).detail ?? body);
    } catch {
      return body;
    }
  })().slice(0, 200);
  if (status === 401) return "Replicate rejected the token. Check REPLICATE_API_TOKEN in .env";
  if (status === 402) return `Replicate needs billing set up or more credit for this account (${detail})`;
  if (status === 429) return "Replicate is rate-limiting this token; try the step again in a minute";
  if (status === 404) return `Replicate has no such model or job (${detail})`;
  return `Replicate returned an error (${status}): ${detail}`;
}
