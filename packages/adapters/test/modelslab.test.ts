import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText, readRun, Recorder, replay, Scheduler, type Assets, type Graph } from "@kriya/engine";
import { describeError, Jobs, MissingModelsLabKey, modelslabExecutors, settle, type Ledger, type Media, type ModelsLabOptions } from "../src/index.js";

const RELEASE = "a".repeat(64);
const API = "https://modelslab.com/api";

const recipe = (text: string): Graph => {
  const r = loadText(text);
  expect(r.problems).toEqual([]);
  return r.graphs[0]!;
};

const shotText = `graph: shot
level: shot
inputs:
  item: json
nodes:
  - id: draw
    kind: model
    capability: image.generate
    options: 3
    prompt: "{{item.action}}. Characters: {{item.characters@look}}"
    uses: [item.action, item.characters@look]
    params: { aspect_ratio: "16:9" }
    out: { image: image }
  - id: pick
    kind: screen
    review: pick_one
    show: draw.image
    actions:
      - { id: lock, needs: [selection], locks: true }
edges:
  - { from: draw, to: pick }
  - { from: pick, to: END, when: "action == 'lock'" }
`;
const shot = recipe(shotText);

/** A mono 16-bit WAV of `seconds` at 24 kHz. */
function wavOf(seconds: number): Uint8Array {
  const data = Math.round(seconds * 24000) * 2;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  put(0, "RIFF"), v.setUint32(4, 36 + data, true), put(8, "WAVE");
  put(12, "fmt "), v.setUint32(16, 16, true), v.setUint16(20, 1, true), v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true), v.setUint32(28, 48000, true), v.setUint16(32, 2, true), v.setUint16(34, 16, true);
  put(36, "data"), v.setUint32(40, data, true);
  return b;
}

/** An MP4 that's only its header: ftyp, then moov with an mvhd saying `seconds`. */
function mp4Of(seconds: number): Uint8Array {
  const box = (type: string, body: Uint8Array) => {
    const b = new Uint8Array(8 + body.length);
    new DataView(b.buffer).setUint32(0, b.length), b.set([...type].map((c) => c.charCodeAt(0)), 4), b.set(body, 8);
    return b;
  };
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(12, 1000), new DataView(mvhd.buffer).setUint32(16, Math.round(seconds * 1000));
  const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\0\0isommp41"));
  const moov = box("moov", box("mvhd", mvhd));
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp), out.set(moov, ftyp.length);
  return out;
}

type Call = { url: string; body: Record<string, unknown> | undefined };

/**
 * A stand-in for ModelsLab. Requests answer 200 `processing` with an id; a
 * job is fetched once while processing, then succeeds (or fails, if `fail`
 * says so). Every answer is HTTP 200, errors too, as ModelsLab does.
 */
function fakeModelsLab(opts: { fail?: (n: number) => string | undefined; refuse?: Record<string, unknown>; queueFull?: number; done?: boolean } = {}) {
  let full = 0;
  let n = 0;
  let out = 0;
  const peak = { out: 0 };
  const calls: Call[] = [];
  const jobs = new Map<number, { polls: number; ext: string; error?: string }>();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (url === `${API}/v6/base64_to_url`) return json({ status: "success", id: 7, output: [`https://pub.r2.dev/up/${createHash("sha256").update(String(body!.base64_string)).digest("hex").slice(0, 8)}.png`] });
    const fetched = /\/fetch\/(\d+)$/.exec(url);
    if (fetched) {
      const id = Number(fetched[1]);
      const job = jobs.get(id)!;
      if (job.polls++ === 0) return json({ status: "processing", id, eta: 10, message: "Your request is being processed" });
      out--;
      if (job.error) return json({ status: "error", id, message: job.error });
      return json({ status: "success", id, output: [`https://pub.r2.dev/out/${id}.${job.ext}`] });
    }
    const file = /pub\.r2\.dev\/out\/(\d+)\.(\w+)$/.exec(url);
    if (file) return new Response(new Uint8Array(file[2] === "mp4" ? mp4Of(5) : file[2] === "wav" ? wavOf(3) : new TextEncoder().encode(`jpeg bytes of ${file[1]}`)));
    if (url.startsWith(`${API}/v7/`)) {
      if (opts.refuse) return json(opts.refuse);
      if (full < (opts.queueFull ?? 0)) {
        full++;
        return json({ status: "error", message: "Rate limit exceeded. Maximum 5 queued requests allowed.", retry_after: 30 });
      }
      const id = ++n;
      const ext = /video/.test(url) ? "mp4" : /voice/.test(url) ? "wav" : "jpg";
      if (opts.done) return json({ status: "success", id, output: [`https://pub.r2.dev/out/${id}.${ext}`] });
      jobs.set(id, { polls: 0, ext, ...(opts.fail?.(id) ? { error: opts.fail(id) } : {}) });
      peak.out = Math.max(peak.out, ++out);
      return json({ status: "processing", id, eta: 10, message: "Your request is being processed", fetch_result: `${API}/v6/images/fetch/${id}`, future_links: [`https://pub.r2.dev/out/${id}.${ext}`] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const asks = () => calls.filter((c) => c.url.startsWith(`${API}/v7/`) && !c.url.includes("/fetch/"));
  return { fetch: fetchFn, calls, peak, asks, fetches: () => calls.filter((c) => c.url.includes("/fetch/")), uploads: () => calls.filter((c) => c.url.endsWith("/base64_to_url")) };
}

/** `sheets/<Name>.png` are character sheets (`big` makes them 6 MB); `blob:` are kept outputs. */
function memoryMedia(big = false): Media & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    read(value) {
      const sheet = /^sheets\/(\w+)\.png$/.exec(value);
      if (sheet) return { bytes: big ? new Uint8Array(6 * 1024 * 1024).fill(1) : new TextEncoder().encode(`${sheet[1]} sheet`), mime: "image/png" };
      if (value.startsWith("blob:")) {
        const b = blobs.get(value.slice(5));
        return b ? { bytes: b, mime: "image/jpeg" } : undefined;
      }
      return undefined;
    },
    write(bytes) {
      const h = createHash("sha256").update(bytes).digest("hex");
      blobs.set(h, bytes);
      return `blob:${h}`;
    },
  };
}

const memoryLedger = (): Ledger & { m: Map<string, string[]> } => {
  const m = new Map<string, string[]>();
  return { m, get: (k) => m.get(k), set: (k, ids) => void m.set(k, [...ids]) };
};

const ITEM = { item: { id: "P3-08", action: "Bheem leaps up screaming; Dhanpat tumbles into the mud", characters: ["Bheem", "Dhanpat"] } };
const ASSETS: Assets = { facet: (entity) => ({ version: "v1", value: `sheets/${entity}.png` }) };

function start(o: { graph?: Graph; inputs?: Record<string, unknown>; lab?: ReturnType<typeof fakeModelsLab>; media?: ReturnType<typeof memoryMedia>; ledger?: Ledger; models?: ModelsLabOptions["models"]; assets?: Assets; key?: string | null; sleeps?: number[]; concurrency?: number } = {}) {
  const graph = o.graph ?? shot;
  const lab = o.lab ?? fakeModelsLab();
  const media = o.media ?? memoryMedia();
  const ledger = o.ledger ?? memoryLedger();
  const jobs = new Jobs();
  const sleeps = o.sleeps;
  const ml = modelslabExecutors({ graphs: [graph], jobs, media, ledger, fetch: lab.fetch, pollMs: 0, ...(sleeps ? { sleep: async (ms: number) => void sleeps.push(ms) } : {}), ...(o.concurrency ? { concurrency: o.concurrency } : {}), ...(o.key === null ? {} : { key: o.key ?? "ml_test" }), ...(o.models ? { models: o.models } : {}) });
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(graph, rec, { produce: ml.produce, decide: () => undefined }, [graph], { assets: o.assets ?? ASSETS });
  s.start(RELEASE, o.inputs ?? ITEM);
  return { s, rec, jobs, log, lab, media, ledger };
}

describe("image.generate on ModelsLab (D-99)", () => {
  it("three candidates: three jobs, each image downloaded and kept as a blob", async () => {
    const { s, rec, jobs, lab, media } = start();
    await settle(s, jobs, describeError);
    expect(lab.asks()).toHaveLength(3);
    const versions = Object.values(rec.state.nodes.draw!.versions);
    expect(versions.map((v) => v.output.image)).toEqual([1, 2, 3].map((id) => `blob:${createHash("sha256").update(`jpeg bytes of ${id}`).digest("hex")}`));
    expect(media.blobs.size).toBe(3);
    expect(rec.state.nodes.pick!.status).toBe("awaiting_human");
  });

  it("sends the key and model in the body, the prompt naming each sheet, the sheets as uploaded links, and the step's params", async () => {
    const { s, jobs, lab } = start();
    await settle(s, jobs, describeError);
    const ask = lab.asks()[0]!;
    expect(ask.url).toBe(`${API}/v7/images/image-to-image`);
    expect(ask.body).toMatchObject({ key: "ml_test", model_id: "nano-banana", aspect_ratio: "16:9" });
    expect(ask.body!.prompt).toContain("Characters: Bheem (image 1); Dhanpat (image 2)");
    expect(ask.body!.init_image).toEqual([expect.stringMatching(/^https:\/\/pub\.r2\.dev\/up\//), expect.stringMatching(/^https:\/\/pub\.r2\.dev\/up\//)]);
    expect(lab.uploads()).toHaveLength(2); // two sheets, uploaded once for all three candidates
    expect(lab.uploads()[0]!.body).toEqual({ key: "ml_test", base64_string: `data:image/png;base64,${Buffer.from("Bheem sheet").toString("base64")}` });
  });

  it("fetches each job at its endpoint's fetch/<id>, with the key, until it's done", async () => {
    const { s, jobs, lab } = start();
    await settle(s, jobs, describeError);
    expect(lab.fetches().map((c) => c.url)).toEqual(expect.arrayContaining([`${API}/v7/images/fetch/1`, `${API}/v7/images/fetch/2`, `${API}/v7/images/fetch/3`]));
    expect(lab.fetches()).toHaveLength(6); // processing once, then done
    expect(lab.fetches()[0]!.body).toEqual({ key: "ml_test" });
  });

  it("records the model and its price, and the prompt and references it was asked with", async () => {
    const { s, rec, jobs } = start();
    await settle(s, jobs, describeError);
    const v = rec.state.nodes.draw!.versions["1.1"]!;
    expect(v.model).toBe("modelslab/nano-banana");
    expect(v.costUsd).toBe(0.047);
    expect(v.prompt).toContain("Reference images: 1 = Bheem's look; 2 = Dhanpat's look.");
    expect(v.references).toEqual([
      { label: "Bheem's look", ref: `sha256:${createHash("sha256").update("Bheem sheet").digest("hex")}` },
      { label: "Dhanpat's look", ref: `sha256:${createHash("sha256").update("Dhanpat sheet").digest("hex")}` },
    ]);
  });

  it("settings per capability: model, endpoint, params and price; a step's own params win", async () => {
    const { s, rec, jobs, lab } = start({ models: { "image.generate": { model: "nano-banana-pro", params: { resolution: "2K", aspect_ratio: "1:1" }, price_usd: 0.2 } } });
    await settle(s, jobs, describeError);
    expect(lab.asks()[0]!.body).toMatchObject({ model_id: "nano-banana-pro", resolution: "2K", aspect_ratio: "16:9" });
    expect(rec.state.nodes.draw!.versions["1.1"]!).toMatchObject({ model: "modelslab/nano-banana-pro", costUsd: 0.2 });
  });

  it("an answer that's already done is used at once, without fetching", async () => {
    const { s, rec, jobs, lab } = start({ lab: fakeModelsLab({ done: true }) });
    await settle(s, jobs, describeError);
    expect(Object.keys(rec.state.nodes.draw!.versions)).toEqual(["1.1", "1.2", "1.3"]);
    expect(lab.fetches()).toEqual([]);
  });

  it("a draw with no reference image says how to draw from words alone, before anything is paid", async () => {
    const { s, rec, jobs, lab } = start({ assets: { facet: () => ({ version: "v1", value: "words only" }) } });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.failure).toContain("'draw' has no reference image, and nano-banana on ModelsLab draws from at least one");
    expect(rec.state.nodes.draw!.failure).toContain("model: gemini-3.1-t2i, endpoint: v7/images/text-to-image");
    expect(lab.asks()).toEqual([]);
  });

  it("…and with a text-to-image model it draws", async () => {
    const { s, rec, jobs, lab } = start({ assets: { facet: () => ({ version: "v1", value: "words only" }) }, models: { "image.generate": { model: "gemini-3.1-t2i", endpoint: "v7/images/text-to-image" } } });
    await settle(s, jobs, describeError);
    expect(lab.asks()[0]!.url).toBe(`${API}/v7/images/text-to-image`);
    expect(lab.asks()[0]!.body).not.toHaveProperty("init_image");
    expect(rec.state.nodes.draw!.versions["1.1"]!).toMatchObject({ model: "modelslab/gemini-3.1-t2i", costUsd: 0.1 });
    expect(lab.fetches()[0]!.url).toBe(`${API}/v7/images/fetch/1`);
  });

  it("a reference image over 5 MB fails saying how to fix it, before anything is paid", async () => {
    const { s, rec, jobs, lab } = start({ media: memoryMedia(true) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.failure).toBe("a reference image is 6.0 MB, and ModelsLab takes 5 MB at most; save it smaller (a JPEG, or fewer pixels)");
    expect(lab.calls).toEqual([]);
  });
});

describe("crashes and failures", () => {
  it("a restart fetches the jobs it already started instead of paying again", async () => {
    const lab = fakeModelsLab();
    const ledger = memoryLedger();
    const media = memoryMedia();
    const first = start({ lab, ledger, media });
    first.s.run(); // the job starts in this process…
    await new Promise((r) => setTimeout(r, 10)); // …asks for its three images…
    expect(ledger.m.get("modelslab:run1/draw#1")).toEqual([1, 2, 3].map((id) => `${API}/v7/images/fetch/${id}`)); // …and the process dies here

    const jobs = new Jobs();
    const ml = modelslabExecutors({ graphs: [shot], jobs, media, ledger, fetch: lab.fetch, pollMs: 0, key: "ml_test" });
    const r2 = Recorder.resume(first.log, "run1");
    const s2 = new Scheduler(shot, r2, { produce: ml.produce, decide: () => undefined }, [shot], { assets: ASSETS });
    s2.recover();
    await settle(s2, jobs, describeError);
    expect(lab.asks()).toHaveLength(3); // still three: nothing paid twice
    expect(Object.keys(r2.state.nodes.draw!.versions)).toEqual(["1.1", "1.2", "1.3"]);
    expect(replay(readRun(first.log, "run1"))).toEqual(r2.state);
  });

  it("a failed job fails the step with ModelsLab's reason", async () => {
    const { s, rec, jobs } = start({ lab: fakeModelsLab({ fail: (n) => (n === 2 ? "NSFW content detected" : undefined) }) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw).toMatchObject({ status: "failed", failure: "ModelsLab couldn't make the image: NSFW content detected" });
  });

  it("an error in a 200 answer is still an error: a bad key fails the step with what to fix", async () => {
    const { s, rec, jobs } = start({ lab: fakeModelsLab({ refuse: { status: "error", code: "invalid_api_key", message: "Invalid API key" } }) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.failure).toBe("ModelsLab rejected the key. Check MODELSLAB_API_KEY in .env");
  });

  it("out of credit says so", async () => {
    const { s, rec, jobs } = start({ lab: fakeModelsLab({ refuse: { status: "error", message: "Insufficient credits. Please add more credits to continue." } }) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.failure).toBe("ModelsLab needs more credit on this account (Insufficient credits. Please add more credits to continue.)");
  });

  it("a full queue is waited out, as long as ModelsLab asks, and the step goes on", async () => {
    const sleeps: number[] = [];
    const { s, rec, jobs, lab } = start({ lab: fakeModelsLab({ queueFull: 2 }), sleeps });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.failure).toBeUndefined();
    expect(Object.keys(rec.state.nodes.draw!.versions)).toEqual(["1.1", "1.2", "1.3"]);
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(lab.asks()).toHaveLength(5); // two turned away, then three made
  });

  it("only a few jobs are out at once, from request to result; the rest wait their turn", async () => {
    const lab = fakeModelsLab();
    const { s, rec, jobs } = start({ graph: recipe(shotText.replace("options: 3", "options: 6")), lab, concurrency: 2 });
    await settle(s, jobs, describeError);
    expect(lab.asks()).toHaveLength(6);
    expect(lab.peak.out).toBe(2);
    expect(Object.keys(rec.state.nodes.draw!.versions)).toHaveLength(6);
  });

  it("no key: nothing starts, and the step can run once one is set", () => {
    const saved = process.env.MODELSLAB_API_KEY;
    delete process.env.MODELSLAB_API_KEY;
    try {
      const { s, lab } = start({ key: null });
      expect(() => s.run()).toThrow(MissingModelsLabKey);
      expect(lab.calls).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.MODELSLAB_API_KEY = saved;
    }
  });
});

const clip = recipe(`graph: clip
level: shot
inputs:
  item: json
  panel: image
nodes:
  - id: animate
    kind: model
    capability: video.from_image
    trust: always
    prompt: "{{item.action}}. Camera static. With {{item.characters@look}}"
    uses: [inputs.panel, item.action, item.characters@look]
    out: { clip: video, seconds: number }
edges:
  - { from: animate, to: END }
`);
const CLIP = { ...ITEM, panel: "sheets/Panel.png" };

describe("video.from_image on ModelsLab", () => {
  it("the panel is the one start image; Wan 2.7 at 720p for 5 seconds; the clip is kept with its measured length and priced by it", async () => {
    const { s, rec, jobs, lab } = start({ graph: clip, inputs: CLIP });
    await settle(s, jobs, describeError);
    const ask = lab.asks()[0]!;
    expect(ask.url).toBe(`${API}/v7/video-fusion/image-to-video`);
    expect(ask.body).toMatchObject({ model_id: "wan2.7-i2v", duration: "5", resolution: "720p", init_image: expect.stringMatching(/^https:\/\/pub\.r2\.dev\/up\//) });
    expect(ask.body!.prompt).toBe("Bheem leaps up screaming; Dhanpat tumbles into the mud. Camera static. With Bheem; Dhanpat");
    expect(lab.fetches()[0]!.url).toBe(`${API}/v7/video-fusion/fetch/1`);
    expect(rec.state.nodes.animate!.versions["1.1"]!).toMatchObject({ output: { seconds: 5 }, model: "modelslab/wan2.7-i2v", costUsd: 0.5 });
  });

  it("Kling by its model id, priced per second", async () => {
    const { s, rec, jobs, lab } = start({ graph: clip, inputs: CLIP, models: { "video.from_image": { model: "Kling-V2-5-Turbo-i2v", params: { duration: "5" } } } });
    await settle(s, jobs, describeError);
    expect(lab.asks()[0]!.body).toMatchObject({ model_id: "Kling-V2-5-Turbo-i2v", duration: "5" });
    expect(rec.state.nodes.animate!.versions["1.1"]!.costUsd).toBe(0.21);
  });
});

const voice = recipe(`graph: voice
level: line
inputs:
  item: json
nodes:
  - id: speak
    kind: model
    capability: audio.speech
    prompt: "{{item.hinglish}}"
    uses: [item.hinglish, item.emotion, item.speaker@voice]
    out: { audio: audio, seconds: number }
edges:
  - { from: speak, to: END }
`);
const LINE = { item: { id: "L1", speaker: "Mitra", hinglish: "Arre beta, chai thandi ho jayegi.", emotion: "worried" } };
const VOICES: Assets = { facet: () => ({ version: "v1", value: { voice: "NNl6r8mD7vthiJatiJt1", words: "warm and slow" } }) };

describe("audio.speech on ModelsLab", () => {
  it("ElevenLabs gets the words and the speaker's voice id, and no direction to read out", async () => {
    const { s, rec, jobs, lab } = start({ graph: voice, inputs: LINE, assets: VOICES });
    await settle(s, jobs, describeError);
    const ask = lab.asks()[0]!;
    expect(ask.url).toBe(`${API}/v7/voice/text-to-speech`);
    expect(ask.body).toEqual({ key: "ml_test", model_id: "eleven_v4", prompt: "Arre beta, chai thandi ho jayegi.", voice_id: "NNl6r8mD7vthiJatiJt1" });
    const v = rec.state.nodes.speak!.versions["1.1"]!;
    expect(v.prompt).toBe("Say: Arre beta, chai thandi ho jayegi.\nVoice: NNl6r8mD7vthiJatiJt1");
    expect(v.output.seconds).toBe(3);
    expect(v.costUsd).toBe(0.00264); // 33 characters at $0.08 a thousand
  });
});

describe("which steps ModelsLab runs", () => {
  it("only the capabilities it's given", () => {
    const ml = modelslabExecutors({ graphs: [shot], jobs: new Jobs(), media: memoryMedia(), ledger: memoryLedger(), capabilities: ["video.from_image"] });
    expect(ml.handles(clip.nodes[0]!)).toBe(true);
    expect(ml.handles(shot.nodes[0]!)).toBe(false);
  });
});
