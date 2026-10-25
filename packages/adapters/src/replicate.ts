/**
 * Replicate as a kriya provider (Day 16, D-56): `image.generate` and
 * `image.edit` on Nano Banana by default.
 *
 * - One prediction per candidate (`options: 3` → three). Reference images
 *   (character sheets, the panel being edited) go in as `image_input`.
 * - Predictions live on Replicate, so a crash needn't pay twice: each one's id
 *   is written to a job ledger right after it's created, and a restarted
 *   process polls the same predictions instead of starting new ones.
 * - Output URLs are deleted after an hour, so every image is downloaded into
 *   kriya's own blob store and recorded as `blob:<sha256>`.
 *
 * Plain `fetch`, no SDK: four HTTP calls (create, get, upload, download).
 */
import { createHash } from "node:crypto";
import type { Executors, Graph, Node, StepContext } from "@kriya/engine";
import type { Jobs } from "./jobs.js";

const API = "https://api.replicate.com/v1";
export const DEFAULT_IMAGE_MODEL = "google/nano-banana-2";

/** US$ per image, estimates (Replicate reports no price): override with `price_usd` in the model settings. */
const PRICE_PER_IMAGE: Record<string, number> = { "google/nano-banana": 0.039, "google/nano-banana-2": 0.067 };

/**
 * How one kind of image step runs, set per capability in kriya.yaml and
 * overridable per step (`model:`, `params:`). Any Replicate image model works:
 * name the input fields it uses if they aren't `prompt` and `image_input`.
 */
export type ImageModelSettings = {
  /** `owner/name`, or `owner/name:version` to pin a version. */
  model?: string;
  /** Inputs sent every time, e.g. `{ resolution: "2K", output_format: "png" }`; a step's own `params` win. */
  params?: Record<string, unknown>;
  /** The model's names for the prompt and the reference images. */
  fields?: { prompt?: string; images?: string };
  /** US$ per image, for the cost on each version. */
  price_usd?: number;
};

/** Files at most this size go in as data URLs; larger ones are uploaded first (Replicate's advice). */
const INLINE_BYTES = 256 * 1024;

/** Where images come from and go to. The CLI reads `blob:…` from the store and image files from the project. */
export type Media = {
  /** An image a value names, or undefined if it names none. */
  read(value: string): { bytes: Uint8Array; mime: string } | { url: string } | undefined;
  /** Keeps a downloaded image; returns the value to record (`blob:<sha256>`). */
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
  /** Settings per capability; a step's own `model:` and `params:` win over them. */
  models?: Partial<Record<"image.generate" | "image.edit", ImageModelSettings>>;
};

/** No token to call Replicate with. Thrown before anything is sent, so the step can run again once one is set. */
export class MissingToken extends Error {
  constructor() {
    super("this step needs Replicate, and there's no token. Put REPLICATE_API_TOKEN=… in .env at the project root (see .env.example), then run the command again");
  }
}

/** A Replicate call that failed for good, in plain words. */
export class ReplicateError extends Error {}

type Prediction = { id: string; status: string; version: string; output: unknown; error: unknown };

export function replicateExecutors(opts: ReplicateOptions): Pick<Executors, "produce"> & { handles(node: Node): boolean } {
  const http = opts.fetch ?? fetch;
  const pollMs = opts.pollMs ?? 1500;
  /** Uploads by content hash, kept as promises so the same image sent twice at once goes up once. */
  const uploaded = new Map<string, Promise<string>>();
  const graphOf = (node: Node) => opts.graphs.find((g) => g.nodes.includes(node));

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
  const asInput = async (t: string, img: { bytes: Uint8Array; mime: string } | { url: string }): Promise<string> => {
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

  const wait = async (t: string, id: string): Promise<Prediction> => {
    for (;;) {
      const p = await call<Prediction>(t, `/predictions/${id}`);
      if (p.status === "succeeded") return p;
      if (p.status === "failed") throw new ReplicateError(`Replicate couldn't make the image: ${String(p.error ?? "no reason given")}`);
      if (p.status === "canceled") throw new ReplicateError("the image job was canceled on Replicate");
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };

  return {
    handles: (node) => node.kind === "model" && (node.capability === "image.generate" || node.capability === "image.edit"),

    produce(node, ctx) {
      if (node.kind !== "model") throw new Error(`Replicate doesn't run ${node.kind} steps`);
      const t = token(); // before the ticket: no token, nothing starts
      const field = Object.entries(node.out).find(([, type]) => type === "image")?.[0];
      if (!field) throw new ReplicateError(`'${node.id}' makes images, so its out needs an image field, e.g. out: { image: image }`);
      const key = ctx.idempotencyKey!;
      const ticket = `replicate:${key}`;
      const settings = opts.models?.[node.capability as "image.generate" | "image.edit"] ?? {};
      const model = node.model ?? settings.model ?? DEFAULT_IMAGE_MODEL;
      const [name, pinned] = model.split(":") as [string, string | undefined];
      const fields = { prompt: settings.fields?.prompt ?? "prompt", images: settings.fields?.images ?? "image_input" };
      const price = settings.price_usd ?? PRICE_PER_IMAGE[name] ?? 0;

      opts.jobs.start(ticket, {
        kind: "outputs",
        run: async () => {
          const ids = [...(opts.ledger.get(key) ?? [])];
          const ask = buildRequest(node, ctx, field, opts.media);
          if (ids.length < node.options) {
            const images = await Promise.all(ask.images.map((x) => asInput(t, x.img)));
            const input = { ...(settings.params ?? {}), ...(node.params ?? {}), [fields.prompt]: ask.prompt, ...(images.length ? { [fields.images]: images } : {}) };
            for (let i = ids.length; i < node.options; i++) {
              const created = pinned
                ? await call<Prediction>(t, "/predictions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: pinned, input }) })
                : await call<Prediction>(t, `/models/${name}/predictions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
              ids.push(created.id);
              opts.ledger.set(key, ids); // before waiting: a restart polls this job instead of paying for another
            }
          }
          const done = await Promise.all(ids.map((id) => wait(t, id)));
          const outputs: Record<string, unknown>[] = [];
          for (const p of done) {
            const url = Array.isArray(p.output) ? p.output[0] : p.output;
            if (typeof url !== "string") throw new ReplicateError("Replicate finished without an image");
            const res = await http(url, { headers: { Authorization: `Bearer ${t}` } });
            if (!res.ok) throw new ReplicateError(`couldn't download the image from Replicate (${res.status}); outputs are kept for an hour`);
            outputs.push({ [field]: opts.media.write(new Uint8Array(await res.arrayBuffer())) });
          }
          const references = ask.images.map((x) => ({ label: x.label, ref: "url" in x.img ? x.img.url : `sha256:${createHash("sha256").update(x.img.bytes).digest("hex")}` }));
          // Replicate hides the version of its official models ("hidden"): then the name is all there is to record.
          return {
            outputs,
            meta: done.map((p) => ({ model: p.version && p.version !== "hidden" ? `${name}:${p.version}` : name, cost_usd: price, prompt: ask.prompt, references })),
          };
        },
      });
      return { ticket };
    },
  };
}

/**
 * What the model is asked: the prompt with `{{refs}}` filled in, and every
 * image the step received as a reference (an edit's own panel first). A look
 * facet brings its words into the prompt ("Mitra, a thin 60-year-old bald
 * man… (image 2)") and its sheet into the references; words alone draw from
 * the description (a minor character, a place without a sheet).
 */
function buildRequest(
  node: Extract<Node, { kind: "model" }>,
  ctx: StepContext,
  field: string,
  media: Media,
): { prompt: string; images: { label: string; img: { bytes: Uint8Array; mime: string } | { url: string } }[] } {
  const images: { label: string; img: { bytes: Uint8Array; mime: string } | { url: string } }[] = [];
  const add = (label: string, v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const img = media.read(v);
    if (!img) return undefined;
    images.push({ label, img });
    return `image ${images.length}`;
  };
  const parent = ctx.parent?.output[field];
  if (parent !== undefined && !add("the image to edit", parent)) throw new ReplicateError(`the version to edit has no image kriya can read (${String(parent)})`);

  /** A received value as prompt text; images become "image N" and join the references. */
  const words = (ref: string, v: unknown): string => {
    if (Array.isArray(v)) return v.map((x, i) => words(`${ref}[${i}]`, x)).join("; ");
    if (v && typeof v === "object" && "value" in v && "entity" in v) {
      const f = v as { entity: string; facet: string; value: unknown };
      const look = (f.value && typeof f.value === "object" ? f.value : { image: f.value }) as { image?: unknown; words?: unknown };
      const n = add(`${f.entity}'s ${f.facet}`, look.image);
      const desc = typeof look.words === "string" ? look.words : n ? undefined : typeof look.image === "string" ? look.image : undefined;
      return `${f.entity}${desc ? `, ${desc}` : ""}${n ? ` (${n})` : ""}`;
    }
    return add(ref, v) ?? (typeof v === "string" ? v : JSON.stringify(v));
  };
  const used = new Set<string>();
  let prompt = (node.prompt ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref: string) => {
    used.add(ref);
    return words(ref, ctx.uses[ref]);
  });
  for (const [ref, v] of Object.entries(ctx.uses)) if (!used.has(ref)) words(ref, v);
  prompt = prompt.trimEnd();
  if (ctx.instruction && !prompt.includes(ctx.instruction)) prompt += `\nChange: ${ctx.instruction}`;
  if (images.length) prompt += `\n\nReference images: ${images.map((x, i) => `${i + 1} = ${x.label}`).join("; ")}.`;
  return { prompt: prompt.trim(), images };
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
