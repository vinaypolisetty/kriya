/**
 * ModelsLab as a kriya provider (D-99): the same five capabilities as
 * Replicate, on the models ModelsLab hosts (Nano Banana, Wan, Kling,
 * Seedance, ElevenLabs…). Prompts, references and voices are built exactly as
 * for Replicate (`mediaRequest`, `speechRequest`); only the calls differ. Each
 * capability has a default model, the endpoint it's asked at and that model's
 * input names; kriya.yaml and a step's own `model:` / `params:` override them.
 *
 * - The key goes in every request's body, and a failure can come back as
 *   HTTP 200 with `status: "error"`: the body decides, not the status line.
 * - A request answers `processing` with an id, fetched at its endpoint's
 *   `fetch/<id>` until it says `success` (as ModelsLab's own CLI does). Each
 *   job's fetch URL is written to the job ledger before waiting, so a
 *   restarted process fetches the same job instead of paying for another.
 * - ModelsLab queues only a few requests per account (5 on pay-as-you-go) and
 *   turns the rest away, so at most `concurrency` jobs are out at once, from
 *   request to result; a full queue is waited out like a throttle.
 * - Reference images go up through `base64_to_url` (5 MB at most; the link
 *   lasts a day). Outputs are deleted after a day too, so every file is
 *   downloaded into kriya's blob store; clips and audio are measured from
 *   their bytes.
 *
 * Plain `fetch`, no SDK: request, fetch, upload, download.
 */
import { createHash } from "node:crypto";
import type { Executors, Graph, Node } from "@kriya/engine";
import { durationOf } from "./duration.js";
import type { Jobs } from "./jobs.js";
import { mediaRequest, REPLICATE_CAPABILITIES, speechRequest, type Ask, type Img, type Ledger, type Media, type ModelFields, type ReplicateCapability } from "./replicate.js";

const API = "https://modelslab.com/api";

export const MODELSLAB_CAPABILITIES = REPLICATE_CAPABILITIES;
export type ModelsLabCapability = ReplicateCapability;

/** What each capability makes, its default model (`model_id`), where it's asked, its input names and the inputs it can't do without. */
const CAPABILITIES: Record<ModelsLabCapability, { makes: "image" | "video" | "audio"; model?: string; endpoint: string; fields: ModelFields; params?: Record<string, unknown> }> = {
  "image.generate": { makes: "image", model: "nano-banana", endpoint: "v7/images/image-to-image", fields: { prompt: "prompt", images: "init_image" } },
  "image.edit": { makes: "image", model: "nano-banana", endpoint: "v7/images/image-to-image", fields: { prompt: "prompt", images: "init_image" } },
  "video.from_image": { makes: "video", model: "wan2.7-i2v", endpoint: "v7/video-fusion/image-to-video", fields: { prompt: "prompt", images: "init_image" }, params: { duration: "5", resolution: "720p" } },
  // ElevenLabs takes the words alone (no style field): how to say it isn't sent.
  "audio.speech": { makes: "audio", model: "eleven_v4", endpoint: "v7/voice/text-to-speech", fields: { prompt: "prompt", voice: "voice_id" } },
  "audio.music": { makes: "audio", endpoint: "v7/voice/music-gen", fields: { prompt: "prompt" } },
};

/** What a finished job used, to price it. */
type Usage = { input: Record<string, unknown>; seconds: number | undefined };
const length = (u: Usage) => u.seconds ?? (Number.parseFloat(String(u.input.duration ?? 5)) || 5);

/**
 * US$ per job, from ModelsLab's model pages (Nov 2026), by `model_id` in
 * lower case. Override with `price_usd` or `price_per_second_usd`.
 */
const PRICES: Record<string, (u: Usage) => number> = {
  "nano-banana": () => 0.047,
  "nano-banana-pro": () => 0.18,
  "gemini-3.1-t2i": () => 0.1,
  "wan2.7-i2v": (u) => length(u) * (u.input.resolution === "1080p" ? 0.15 : 0.1),
  "kling-v2-5-turbo-i2v": (u) => length(u) * 0.042,
  // the page says both $0.067 and $0.084 a second (standard mode); this takes the higher
  "kling-v3-i2v": (u) => length(u) * 0.084,
  "seedance-1-5-pro": (u) => length(u) * (({ "720p": 0.06, "1080p": 0.14 })[String(u.input.resolution)] ?? 0.03),
  eleven_v4: (u) => (String(u.input.prompt ?? "").length / 1000) * 0.08,
};

/**
 * How one kind of step runs, set per capability in kriya.yaml and overridable
 * per step (`model:`, `params:`). Any ModelsLab model works: give its endpoint
 * and input names if they aren't the default model's.
 */
export type ModelsLabSettings = {
  /** ModelsLab's `model_id`, e.g. `Kling-V2-5-Turbo-i2v`, as its model page writes it. */
  model?: string;
  /** Where the model is asked, e.g. `v7/images/text-to-image` (after https://modelslab.com/api/); a full URL works too. */
  endpoint?: string;
  /** Inputs sent every time, e.g. `{ resolution: 1080p }` or `{ aspect_ratio: "9:16" }`; a step's own `params` win. */
  params?: Record<string, unknown>;
  /** The model's input names for what kriya sends. */
  fields?: ModelFields;
  /** US$ per output (an image, a clip, a line), for the cost on each version. */
  price_usd?: number;
  /** US$ per second of output, for clips and audio priced by length. */
  price_per_second_usd?: number;
};

/** The largest file `base64_to_url` takes. */
const UPLOAD_BYTES = 5 * 1024 * 1024;
/** Uploaded links last a day; one older than this is uploaded again. */
const UPLOAD_KEEPS_MS = 20 * 60 * 60_000;

export type ModelsLabOptions = {
  graphs: Graph[];
  jobs: Jobs;
  media: Media;
  ledger: Ledger;
  /** Defaults to MODELSLAB_API_KEY, read when a call is made. */
  key?: string;
  fetch?: typeof fetch;
  /** How often to check on a job that's still processing. */
  pollMs?: number;
  /** How many jobs may be out at once, from request to result, across every step in this process (default 4: the smallest plan queues 5). */
  concurrency?: number;
  /** How long to keep waiting out a full queue before giving up, in ms (default 10 minutes). */
  patienceMs?: number;
  /** Waits; tests pass a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Which capabilities this adapter runs; the rest go elsewhere. Default: all of them. */
  capabilities?: readonly ModelsLabCapability[];
  /** Settings per capability; a step's own `model:` and `params:` win over them. */
  models?: Partial<Record<ModelsLabCapability, ModelsLabSettings>>;
  /** Words the knowledge base adds to an image or clip step's prompt (applied tips, D-76). Never to speech: they'd be read out. */
  prevent?: (node: Node) => string[];
};

/** No key to call ModelsLab with. Thrown before anything is sent, so the step can run again once one is set. */
export class MissingModelsLabKey extends Error {
  constructor() {
    super("this step needs ModelsLab, and there's no key. Put MODELSLAB_API_KEY=… in .env at the project root (see .env.example)");
  }
}

/** A ModelsLab call that failed for good, in plain words. */
export class ModelsLabError extends Error {}

/** What ModelsLab answers a request or a fetch with: the fields kriya reads. Legacy endpoints spell `message` "messege". */
type Reply = { status?: unknown; id?: unknown; output?: unknown; output_url?: unknown; proxy_links?: unknown; future_links?: unknown; fetch_result?: unknown; message?: unknown; messege?: unknown; code?: unknown; retry_after?: unknown };

export function modelslabExecutors(opts: ModelsLabOptions): Pick<Executors, "produce"> & { handles(node: Node): boolean } {
  const http = opts.fetch ?? fetch;
  const pollMs = opts.pollMs ?? 3000;
  const runs = new Set<string>(opts.capabilities ?? MODELSLAB_CAPABILITIES);
  /** Uploads by content hash, kept as promises so the same image sent twice at once goes up once. */
  const uploaded = new Map<string, { at: number; url: Promise<string> }>();

  const key = () => {
    const k = opts.key ?? process.env.MODELSLAB_API_KEY;
    if (!k) throw new MissingModelsLabKey();
    return k;
  };

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const patience = opts.patienceMs ?? 10 * 60_000;
  const url = (path: string) => (/^https?:/.test(path) ? path : `${(process.env.MODELSLAB_BASE_URL ?? API).replace(/\/$/, "")}/${path.replace(/^\//, "")}`);

  /**
   * One call: the key in the body, the answer read from the body. A full queue
   * (429, `rate_limited`) and a busy server (502–504, `upstream_unavailable`,
   * which isn't billed) are waited out, as long as ModelsLab asks or with
   * growing pauses; anything else fails for good.
   */
  const post = async (k: string, path: string, body: Record<string, unknown>, doing: string): Promise<Reply> => {
    for (let attempt = 0, waited = 0; ; attempt++) {
      const res = await http(url(path), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ ...body, key: k }) });
      const text = await res.text().catch(() => "");
      const reply = parse(text);
      if (res.ok && reply.status !== "error" && reply.status !== "failed") return reply;
      if (!busy(res.status, reply) || waited >= patience) throw new ModelsLabError(problem(res.status, reply, text, doing));
      const asked = Number(reply.retry_after) || Number(res.headers.get("retry-after")) || 0;
      const pause = Math.min(60_000, Math.max(asked * 1000, 1000 * 2 ** Math.min(attempt, 5)));
      waited += pause;
      await sleep(pause);
    }
  };

  /** Jobs out at ModelsLab, a few at a time: the rest wait their turn here rather than in its queue. */
  const slots = { free: Math.max(1, opts.concurrency ?? 4), queue: [] as (() => void)[] };
  const outAtOnce = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (slots.free === 0) await new Promise<void>((r) => slots.queue.push(r));
    else slots.free--;
    try {
      return await fn();
    } finally {
      const next = slots.queue.shift();
      if (next) next();
      else slots.free++;
    }
  };

  /** An image as ModelsLab takes it: a link. Files are uploaded once a process (again after most of a day, when the link runs out). */
  const asInput = async (k: string, img: Img): Promise<string> => {
    if ("url" in img) return img.url;
    if (img.bytes.length > UPLOAD_BYTES) throw new ModelsLabError(`a reference image is ${(img.bytes.length / 2 ** 20).toFixed(1)} MB, and ModelsLab takes 5 MB at most; save it smaller (a JPEG, or fewer pixels)`);
    const sha = createHash("sha256").update(img.bytes).digest("hex");
    const kept = uploaded.get(sha);
    if (kept && Date.now() - kept.at < UPLOAD_KEEPS_MS) return kept.url;
    const link = post(k, "v6/base64_to_url", { base64_string: `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}` }, "take a reference image").then((r) => {
      const u = linksOf(r.output)[0];
      if (!u) throw new ModelsLabError("ModelsLab took a reference image and gave no link to it");
      return u;
    });
    link.catch(() => uploaded.delete(sha)); // a failed upload can be tried again
    uploaded.set(sha, { at: Date.now(), url: link });
    return link;
  };

  /** A job's file, once ModelsLab says it's done. */
  const wait = async (k: string, at: string, what: string): Promise<string> => {
    for (;;) {
      const r = await post(k, at, {}, `make ${what}`);
      if (r.status === "success") {
        const link = linkOf(r);
        if (!link) throw new ModelsLabError(`ModelsLab finished without ${what}`);
        return link;
      }
      await new Promise((ok) => setTimeout(ok, pollMs));
    }
  };

  return {
    handles: (node) => node.kind === "model" && runs.has(node.capability),

    produce(node, ctx) {
      if (node.kind !== "model") throw new Error(`ModelsLab doesn't run ${node.kind} steps`);
      const k = key(); // before the ticket: no key, nothing starts
      const capability = node.capability as ModelsLabCapability;
      const cap = CAPABILITIES[capability];
      if (!cap) throw new ModelsLabError(`ModelsLab doesn't run '${node.capability}' steps; it runs ${MODELSLAB_CAPABILITIES.join(", ")}`);
      const field = Object.entries(node.out).find(([, type]) => type === cap.makes)?.[0];
      if (!field) throw new ModelsLabError(`'${node.id}' makes ${cap.makes === "audio" ? "audio" : `${cap.makes}s`}, so its out needs a ${cap.makes} field, e.g. out: { ${cap.makes === "video" ? "clip" : cap.makes}: ${cap.makes} }`);
      const timed = Object.entries(node.out).find(([f, type]) => f === "seconds" && type === "number")?.[0];
      const what = { image: "the image", video: "the clip", audio: "the audio" }[cap.makes];
      const idem = ctx.idempotencyKey!;
      const ticket = `modelslab:${idem}`;
      const settings = opts.models?.[capability] ?? {};
      const model = node.model ?? settings.model ?? cap.model;
      const endpoint = url(settings.endpoint ?? cap.endpoint);
      const fields = { ...cap.fields, ...(settings.fields ?? {}) };
      const base = { ...(cap.params ?? {}), ...(settings.params ?? {}) };
      const params = { ...base, ...(node.params ?? {}) };
      const price = (u: Usage) =>
        settings.price_usd ?? (settings.price_per_second_usd !== undefined ? (u.seconds ?? 0) * settings.price_per_second_usd : (PRICES[(model ?? "").toLowerCase()]?.(u) ?? 0));

      opts.jobs.start(ticket, {
        kind: "outputs",
        run: async () => {
          const entries = [...(opts.ledger.get(ticket) ?? [])];
          const ask: Ask =
            capability === "audio.speech"
              ? speechRequest(node, ctx, fields, base, node.params ?? {})
              : await mediaRequest(node, ctx, field, opts.media, cap.makes, fields, params, (img) => asInput(k, img), cap.makes === "audio" ? [] : (opts.prevent?.(node) ?? []));
          if (cap.makes === "image" && fields.images && ask.input[fields.images] === undefined && /image-to-image/.test(endpoint)) {
            throw new ModelsLabError(
              `'${node.id}' has no reference image, and ${model ?? "this model"} on ModelsLab draws from at least one. Give it a look from the Library, or a text-to-image model in kriya.yaml, e.g. modelslab: { ${capability}: { model: gemini-3.1-t2i, endpoint: v7/images/text-to-image, params: { aspect_ratio: "16:9", resolution: 1K } } }`,
            );
          }
          const body = { ...ask.input, ...(model ? { model_id: model } : {}) };

          /** One candidate: asked for (unless the ledger has it), then fetched until it's done. */
          const one = (i: number) =>
            outAtOnce(async () => {
              let entry = entries[i];
              let link: string | undefined;
              if (!entry) {
                const r = await post(k, endpoint, body, `make ${what}`);
                if (r.status === "success") link = linkOf(r);
                entry = fetchUrl(endpoint, r) ?? (link ? `output:${link}` : undefined);
                if (!entry) throw new ModelsLabError(`ModelsLab took the request for ${what} and gave no job to wait on (${JSON.stringify(r).slice(0, 200)})`);
                entries[i] = entry;
                opts.ledger.set(ticket, Array.from(entries, (e) => e ?? "")); // before waiting: a restart fetches this job instead of paying for another
              }
              return link ?? (entry.startsWith("output:") ? entry.slice(7) : await wait(k, entry, what));
            });
          const links = await Promise.all(Array.from({ length: node.options }, (_, i) => one(i)));

          const outputs: Record<string, unknown>[] = [];
          const meta = [];
          for (const link of links) {
            const res = await http(link);
            if (!res.ok) throw new ModelsLabError(`couldn't download ${what} from ModelsLab (${res.status}); outputs are kept for a day`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const seconds = cap.makes === "image" ? undefined : durationOf(bytes);
            if (timed && seconds === undefined) throw new ModelsLabError(`'${node.id}' needs the length of its ${cap.makes} (out: seconds), and kriya can't read it from this file; it reads WAV and MP4`);
            outputs.push({ [field]: opts.media.write(bytes), ...(timed ? { [timed]: seconds } : {}) });
            // ModelsLab names no versions: the model id (or, with none, the endpoint) is all there is to record.
            meta.push({
              model: `modelslab/${model ?? endpoint.split("/").pop()}`,
              cost_usd: Math.round(price({ input: body, seconds }) * 1e6) / 1e6,
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

const parse = (text: string): Reply => {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Reply) : {};
  } catch {
    return {};
  }
};

/** What ModelsLab said, as words: validation errors come as objects. */
const said = (r: Reply): string => {
  const m = r.message ?? r.messege;
  return typeof m === "string" ? m : m === undefined || m === null ? "" : JSON.stringify(m);
};

const linksOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : typeof v === "string" && v ? [v] : []);
const linkOf = (r: Reply): string | undefined => [r.output, r.output_url, r.proxy_links, r.future_links].flatMap(linksOf)[0];

/** Where to fetch a job: the endpoint's `fetch/<id>`, else the `fetch_result` link the answer gives. */
const fetchUrl = (endpoint: string, r: Reply): string | undefined =>
  typeof r.id === "number" || (typeof r.id === "string" && r.id)
    ? `${endpoint.replace(/\/[^/]+\/?$/, "")}/fetch/${r.id}`
    : typeof r.fetch_result === "string" && r.fetch_result
      ? r.fetch_result
      : undefined;

/** A full queue or a busy server: worth waiting out, not paid for. */
const busy = (status: number, r: Reply) =>
  [429, 502, 503, 504].includes(status) || r.code === "rate_limited" || r.code === "upstream_unavailable" || /rate limit|queued requests/i.test(said(r));

function problem(status: number, r: Reply, body: string, doing: string): string {
  const detail = (said(r) || (r.status === undefined ? body : "") || "no reason given").slice(0, 200);
  if (status === 401 || r.code === "invalid_api_key" || r.code === "unauthenticated" || /invalid api key/i.test(detail)) return "ModelsLab rejected the key. Check MODELSLAB_API_KEY in .env";
  if (status === 402 || r.code === "insufficient_balance" || r.code === "no_subscription" || /insufficient (credit|balance)/i.test(detail)) return `ModelsLab needs more credit on this account (${detail})`;
  if (busy(status, r)) return `ModelsLab kept turning requests away for 10 minutes (${detail}); try the step again later, or run fewer at once`;
  return `ModelsLab couldn't ${doing}: ${detail}`;
}
