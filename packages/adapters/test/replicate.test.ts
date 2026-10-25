import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText, readRun, Recorder, replay, Scheduler, type Assets, type Graph } from "@kriya/engine";
import { describeError, durationOf, Jobs, MissingToken, replicateExecutors, settle, type Ledger, type Media, type ReplicateOptions } from "../src/index.js";

const RELEASE = "a".repeat(64);

const recipe = (text: string): Graph => {
  const r = loadText(text);
  expect(r.problems).toEqual([]);
  return r.graphs[0]!;
};
const VERSION = "5bdc2c7cd642ae33611d8c33f79615f98ff02509ab8db9d8ec1cc6c36d378fba";

const shot: Graph = (() => {
  const r = loadText(`graph: shot
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
      - { id: edit, needs: [selection, note] }
  - id: edit
    kind: model
    capability: image.edit
    refines: draw
    prompt: "Keep everything exactly the same. Only change: {{pick.note}}"
    out: { image: image }
edges:
  - { from: draw, to: pick }
  - { from: pick, to: edit, when: "action == 'edit'" }
  - { from: edit, to: pick, max_loops: 2 }
  - { from: pick, to: END, when: "action == 'lock'" }
`);
  expect(r.problems).toEqual([]);
  return r.graphs[0]!;
})();

type Call = { method: string; url: string; body?: unknown };

/** A mono 16-bit WAV of `seconds` at 24 kHz, as Gemini TTS returns. */
function wavOf(seconds: number): Uint8Array {
  const rate = 24000;
  const data = Math.round(seconds * rate) * 2;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  put(0, "RIFF"), v.setUint32(4, 36 + data, true), put(8, "WAVE");
  put(12, "fmt "), v.setUint32(16, 16, true), v.setUint16(20, 1, true), v.setUint16(22, 1, true);
  v.setUint32(24, rate, true), v.setUint32(28, rate * 2, true), v.setUint16(32, 2, true), v.setUint16(34, 16, true);
  put(36, "data"), v.setUint32(40, data, true);
  return b;
}

/** An MP4 that's only its header: ftyp, then moov with an mvhd saying `seconds` (version 0 or 1). */
function mp4Of(seconds: number, version: 0 | 1 = 0): Uint8Array {
  const mvhd = new Uint8Array(version ? 120 : 108);
  const m = new DataView(mvhd.buffer);
  m.setUint32(0, mvhd.length), mvhd.set([..."mvhd"].map((c) => c.charCodeAt(0)), 4), m.setUint8(8, version);
  if (version) m.setUint32(28, 1000), m.setBigUint64(32, BigInt(Math.round(seconds * 1000)));
  else m.setUint32(20, 1000), m.setUint32(24, Math.round(seconds * 1000));
  const box = (type: string, body: Uint8Array) => {
    const b = new Uint8Array(8 + body.length);
    new DataView(b.buffer).setUint32(0, b.length), b.set([...type].map((c) => c.charCodeAt(0)), 4), b.set(body, 8);
    return b;
  };
  const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\0\0isommp41"));
  const moov = box("moov", mvhd);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp), out.set(moov, ftyp.length);
  return out;
}

/**
 * A stand-in for Replicate. Predictions run for one poll, then succeed (or
 * fail, if `fail` says so). Image models make bytes named after the
 * prediction; clip models an MP4 and audio models a WAV `seconds(n)` long.
 */
function fakeReplicate(opts: { fail?: (n: number) => string | undefined; status?: number; version?: string; seconds?: (n: number) => number; metrics?: Record<string, unknown>; bytes?: Uint8Array } = {}) {
  const version = opts.version ?? VERSION;
  const calls: Call[] = [];
  const predictions = new Map<string, { polls: number; error?: string; ext: string; seconds: number }>();
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof FormData ? "form" : undefined;
    calls.push({ method, url, body });
    if (opts.status) return json({ detail: "nope" }, opts.status);
    if (method === "POST" && url.endsWith("/files")) return json({ id: "f1", urls: { get: "https://api.replicate.com/v1/files/f1" } }, 201);
    if (method === "POST" && url.endsWith("/predictions")) {
      const id = `p${++n}`;
      const ext = /i2v|video/.test(url) ? "mp4" : /tts|lyria|music/.test(url) ? "wav" : "jpg";
      predictions.set(id, { polls: 0, ext, seconds: opts.seconds?.(n) ?? 5, ...(opts.fail?.(n) ? { error: opts.fail(n) } : {}) });
      return json({ id, status: "starting", version, output: null, error: null }, 201);
    }
    const get = /\/predictions\/(\w+)$/.exec(url);
    if (get) {
      const p = predictions.get(get[1]!)!;
      if (p.polls++ === 0) return json({ id: get[1], status: "processing", version, output: null, error: null });
      if (p.error) return json({ id: get[1], status: "failed", version, output: null, error: p.error });
      return json({ id: get[1], status: "succeeded", version, output: `https://replicate.delivery/out/${get[1]}.${p.ext}`, error: null, ...(opts.metrics ? { metrics: opts.metrics } : {}) });
    }
    const out = /replicate\.delivery\/out\/(\w+)\.(\w+)$/.exec(url);
    if (out) {
      const p = predictions.get(out[1]!)!;
      if (opts.bytes) return new Response(new Uint8Array(opts.bytes));
      return new Response(new Uint8Array(out[2] === "mp4" ? mp4Of(p.seconds) : out[2] === "wav" ? wavOf(p.seconds) : new TextEncoder().encode(`jpeg bytes of ${out[1]}`)));
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, creates: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/predictions")) };
}

/** Images in memory: `sheets/<Name>.png` are character sheets (`big` makes them 300 KB), `blob:` are kept outputs. */
function memoryMedia(big = false): Media & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    read(value) {
      const sheet = /^sheets\/(\w+)\.png$/.exec(value);
      if (sheet) return { bytes: big ? new Uint8Array(300 * 1024).fill(1) : new TextEncoder().encode(`${sheet[1]} sheet`), mime: "image/png" };
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
const ASSETS = { facet: (entity: string, facet: string) => ({ version: "v1", value: `sheets/${entity}.png` }) };

function start(o: { graph?: Graph; inputs?: Record<string, unknown>; replicate?: ReturnType<typeof fakeReplicate>; media?: ReturnType<typeof memoryMedia>; ledger?: Ledger; models?: ReplicateOptions["models"]; assets?: Assets; decide?: (screen: string) => unknown; token?: string | null } = {}) {
  const graph = o.graph ?? shot;
  const replicate = o.replicate ?? fakeReplicate();
  const media = o.media ?? memoryMedia();
  const ledger = o.ledger ?? memoryLedger();
  const jobs = new Jobs();
  const rep = replicateExecutors({ graphs: [graph], jobs, media, ledger, fetch: replicate.fetch, pollMs: 0, ...(o.token === null ? {} : { token: o.token ?? "r8_test" }), ...(o.models ? { models: o.models } : {}) });
  const exec = { produce: rep.produce, decide: (n: { id: string }) => o.decide?.(n.id) as never };
  const log = new SqliteEventLog(openDatabase(":memory:"));
  const rec = Recorder.start(log, "run1");
  const s = new Scheduler(graph, rec, exec, [graph], { assets: o.assets ?? ASSETS });
  s.start(RELEASE, o.inputs ?? ITEM);
  return { s, rec, jobs, log, replicate, media, ledger };
}

describe("image.generate on Replicate (D-56)", () => {
  it("three candidates: three predictions, each image downloaded and kept as a blob", async () => {
    const { s, rec, jobs, replicate, media } = start();
    await settle(s, jobs, describeError);
    expect(replicate.creates()).toHaveLength(3);
    const versions = Object.values(rec.state.nodes.draw!.versions);
    expect(versions.map((v) => v.output.image)).toEqual(["p1", "p2", "p3"].map((p) => `blob:${createHash("sha256").update(`jpeg bytes of ${p}`).digest("hex")}`));
    expect(media.blobs.size).toBe(3);
    expect(rec.state.nodes.pick!.status).toBe("awaiting_human");
  });

  it("sends the prompt with characters named by their reference image, the sheets, and the step's params", async () => {
    const { s, jobs, replicate } = start();
    await settle(s, jobs, describeError);
    const { input } = replicate.creates()[0]!.body as { input: { prompt: string; image_input: string[]; aspect_ratio: string } };
    expect(input.prompt).toBe(
      "Bheem leaps up screaming; Dhanpat tumbles into the mud. Characters: Bheem (image 1); Dhanpat (image 2)\n\nReference images: 1 = Bheem's look; 2 = Dhanpat's look.",
    );
    expect(input.image_input).toEqual([`data:image/png;base64,${Buffer.from("Bheem sheet").toString("base64")}`, `data:image/png;base64,${Buffer.from("Dhanpat sheet").toString("base64")}`]);
    expect(input.aspect_ratio).toBe("16:9");
    expect(replicate.creates()[0]!.url).toBe("https://api.replicate.com/v1/models/google/nano-banana-2/predictions");
  });

  it("records the exact model version, the estimated cost, and the prompt and references it was asked with", async () => {
    const { s, rec, jobs, log } = start();
    await settle(s, jobs, describeError);
    const made = readRun(log, "run1").filter((e) => e.type === "CandidateProduced");
    expect(made.map((e) => ("model" in e ? e.model : undefined))).toEqual(Array(3).fill(`google/nano-banana-2:${VERSION}`));
    expect(made.map((e) => ("cost_usd" in e ? e.cost_usd : undefined))).toEqual([0.067, 0.067, 0.067]);
    const v = rec.state.nodes.draw!.versions["1.1"]!;
    expect(v.prompt).toContain("Characters: Bheem (image 1); Dhanpat (image 2)");
    expect(v.references).toEqual([
      { label: "Bheem's look", ref: `sha256:${createHash("sha256").update("Bheem sheet").digest("hex")}` },
      { label: "Dhanpat's look", ref: `sha256:${createHash("sha256").update("Dhanpat sheet").digest("hex")}` },
    ]);
  });

  it("Replicate's hidden versions are recorded as the model name alone", async () => {
    const { s, rec, jobs } = start({ replicate: fakeReplicate({ version: "hidden" }) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.versions["1.1"]!.model).toBe("google/nano-banana-2");
  });

  it("settings per capability: model, params, field names and price; a step's own params win", async () => {
    const { s, rec, jobs, replicate } = start({
      models: { "image.generate": { model: "acme/painter", params: { resolution: "2K", aspect_ratio: "1:1" }, fields: { prompt: "text", images: "refs" }, price_usd: 0.5 } },
    });
    await settle(s, jobs, describeError);
    const c = replicate.creates()[0]!;
    expect(c.url).toBe("https://api.replicate.com/v1/models/acme/painter/predictions");
    const input = (c.body as { input: Record<string, unknown> }).input;
    expect(Object.keys(input).sort()).toEqual(["aspect_ratio", "refs", "resolution", "text"]);
    expect(input).toMatchObject({ resolution: "2K", aspect_ratio: "16:9" }); // the step's 16:9 beats the setting's 1:1
    expect(rec.state.nodes.draw!.versions["1.1"]!.costUsd).toBe(0.5);
  });

  it("a pinned version is asked for by version", async () => {
    const { s, jobs, replicate } = start({ models: { "image.generate": { model: `google/nano-banana-2:${VERSION}` } } });
    await settle(s, jobs, describeError);
    expect(replicate.creates()[0]).toMatchObject({ url: "https://api.replicate.com/v1/predictions", body: { version: VERSION } });
  });

  it("a look with words describes the character in the prompt; words alone draw without a sheet", async () => {
    const looks: Record<string, unknown> = {
      Bheem: { image: "sheets/Bheem.png", words: "a very tall bodybuilder with a red-and-white checked gamcha" },
      Dhanpat: { words: "a pot-bellied man in a white kurta and a gold watch" },
    };
    const { s, jobs, replicate } = start({ assets: { facet: (e: string) => ({ version: "v1", value: looks[e] }) } });
    await settle(s, jobs, describeError);
    const { input } = replicate.creates()[0]!.body as { input: { prompt: string; image_input: string[] } };
    expect(input.prompt).toBe(
      "Bheem leaps up screaming; Dhanpat tumbles into the mud. Characters: Bheem, a very tall bodybuilder with a red-and-white checked gamcha (image 1); Dhanpat, a pot-bellied man in a white kurta and a gold watch\n\nReference images: 1 = Bheem's look.",
    );
    expect(input.image_input).toHaveLength(1);
  });

  it("large reference images are uploaded once, then passed by URL", async () => {
    const { s, jobs, replicate } = start({ media: memoryMedia(true) });
    await settle(s, jobs, describeError);
    const uploads = replicate.calls.filter((c) => c.url.endsWith("/files"));
    expect(uploads).toHaveLength(1); // both sheets are the same bytes here: one upload
    expect((replicate.creates()[0]!.body as { input: { image_input: string[] } }).input.image_input).toEqual(["https://api.replicate.com/v1/files/f1", "https://api.replicate.com/v1/files/f1"]);
  });
});

describe("image.edit: the panel being edited goes first", () => {
  it("an edit sends the picked panel as image 1 and the note in the prompt, once", async () => {
    let picks = 0;
    const { s, rec, jobs, replicate, media } = start({ decide: () => (picks++ === 0 ? { action: "edit", selection: ["1.2"], note: "add Bheem's red gamcha" } : undefined) });
    await settle(s, jobs, describeError);
    const edit = replicate.creates()[3]!.body as { input: { prompt: string; image_input: string[] } };
    expect(edit.input.prompt).toBe("Keep everything exactly the same. Only change: add Bheem's red gamcha\n\nReference images: 1 = the image to edit.");
    const parent = rec.state.nodes.draw!.versions["1.2"]!.output.image as string;
    expect(edit.input.image_input[0]).toBe(`data:image/jpeg;base64,${Buffer.from(media.blobs.get(parent.slice(5))!).toString("base64")}`);
    expect(rec.state.nodes.draw!.versions["2.1"]).toMatchObject({ parents: ["1.2"], madeBy: "edit" });
  });
});

describe("crashes and failures", () => {
  it("a restart polls the predictions it already started instead of paying again", async () => {
    const replicate = fakeReplicate();
    const ledger = memoryLedger();
    const media = memoryMedia();
    const first = start({ replicate, ledger, media });
    first.s.run(); // the job starts in this process…
    await new Promise((r) => setTimeout(r, 10)); // …creates its predictions…
    expect(ledger.m.get("run1/draw#1")).toEqual(["p1", "p2", "p3"]); // …and the process dies here

    const jobs = new Jobs();
    const rep = replicateExecutors({ graphs: [shot], jobs, media, ledger, fetch: replicate.fetch, pollMs: 0, token: "r8_test" });
    const r2 = Recorder.resume(first.log, "run1");
    const s2 = new Scheduler(shot, r2, { produce: rep.produce, decide: () => undefined }, [shot], { assets: ASSETS });
    s2.recover();
    await settle(s2, jobs, describeError);
    expect(replicate.creates()).toHaveLength(3); // still three: nothing paid twice
    expect(Object.keys(r2.state.nodes.draw!.versions)).toEqual(["1.1", "1.2", "1.3"]);
    expect(replay(readRun(first.log, "run1"))).toEqual(r2.state);
  });

  it("a failed prediction fails the step with Replicate's reason", async () => {
    const { s, rec, jobs } = start({ replicate: fakeReplicate({ fail: (n) => (n === 2 ? "E005: flagged as sensitive" : undefined) }) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw).toMatchObject({ status: "failed", failure: "Replicate couldn't make the image: E005: flagged as sensitive" });
  });

  it("a bad token fails the step with what to fix", async () => {
    const { s, rec, jobs } = start({ replicate: fakeReplicate({ status: 401 }) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.draw!.failure).toBe("Replicate rejected the token. Check REPLICATE_API_TOKEN in .env");
  });

  it("no token: nothing starts, and the step can run once one is set", () => {
    const saved = process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_TOKEN;
    try {
      const { s, replicate } = start({ token: null });
      expect(() => s.run()).toThrow(MissingToken);
      expect(replicate.calls).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.REPLICATE_API_TOKEN = saved;
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

describe("video.from_image: a clip from the locked panel (D-58)", () => {
  it("the panel is the start frame, looks are words only, and the clip is kept with its measured length", async () => {
    const { s, rec, jobs, replicate, media } = start({ graph: clip, inputs: CLIP });
    await settle(s, jobs, describeError);
    expect(replicate.creates()).toHaveLength(1);
    const c = replicate.creates()[0]!;
    expect(c.url).toBe("https://api.replicate.com/v1/models/wan-video/wan-2.7-i2v/predictions");
    expect((c.body as { input: unknown }).input).toEqual({
      prompt: "Bheem leaps up screaming; Dhanpat tumbles into the mud. Camera static. With Bheem; Dhanpat",
      first_frame: `data:image/png;base64,${Buffer.from("Panel sheet").toString("base64")}`,
    });
    const v = rec.state.nodes.animate!.versions["1.1"]!;
    expect(v.output).toEqual({ clip: `blob:${createHash("sha256").update(mp4Of(5)).digest("hex")}`, seconds: 5 });
    expect(media.blobs.size).toBe(1);
    expect(v.costUsd).toBe(0.75); // 5 s at 1080p, $0.15 a second
    expect(v.references).toEqual([{ label: "inputs.panel", ref: `sha256:${createHash("sha256").update("Panel sheet").digest("hex")}` }]);
    expect(rec.state.status).toBe("completed");
  });

  it("priced by the clip's real length and resolution", async () => {
    const { s, rec, jobs } = start({ graph: clip, inputs: CLIP, replicate: fakeReplicate({ seconds: () => 4 }), models: { "video.from_image": { params: { resolution: "720p" } } } });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.animate!.versions["1.1"]).toMatchObject({ costUsd: 0.4, output: { seconds: 4 } });
  });

  it("a clip with no image to start from fails with what to add", async () => {
    const { s, rec, jobs, replicate } = start({ graph: clip, inputs: { ...CLIP, panel: "nowhere.png" } });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.animate!.failure).toBe("'animate' makes a clip from an image, and it received none. Add the panel to its uses, e.g. uses: [pick.selected]");
    expect(replicate.creates()).toEqual([]);
  });

  it("a restart polls the clip it already started instead of paying again", async () => {
    const replicate = fakeReplicate();
    const ledger = memoryLedger();
    const first = start({ graph: clip, inputs: CLIP, replicate, ledger });
    first.s.run();
    await new Promise((r) => setTimeout(r, 10));
    expect(ledger.m.get("run1/animate#1")).toEqual(["p1"]); // the process dies here

    const jobs = new Jobs();
    const rep = replicateExecutors({ graphs: [clip], jobs, media: first.media, ledger, fetch: replicate.fetch, pollMs: 0, token: "r8_test" });
    const r2 = Recorder.resume(first.log, "run1");
    const s2 = new Scheduler(clip, r2, { produce: rep.produce, decide: () => undefined }, [clip], { assets: ASSETS });
    s2.recover();
    await settle(s2, jobs, describeError);
    expect(replicate.creates()).toHaveLength(1);
    expect(r2.state.status).toBe("completed");
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
    uses: [item.hinglish, item.emotion, item.speaker@voice, item.speaker@speech]
    out: { audio: audio, seconds: number }
  - id: too_long
    kind: model
    capability: audio.speech
    refines: speak
    prompt: "{{item.hinglish}}"
    uses: [item.hinglish, item.emotion, item.speaker@voice]
    params: { prompt: "Speak about 20% faster than usual." }
    out: { audio: audio, seconds: number }
  - id: listen
    kind: screen
    review: listen
    show: speak.audio
    actions:
      - { id: approve, locks: true }
edges:
  - { from: speak, to: too_long, when: "result.seconds > 8" }
  - { from: speak, to: listen, when: "result.seconds <= 8" }
  - { from: too_long, to: listen }
  - { from: listen, to: END, when: "action == 'approve'" }
`);
const LINE = { item: { id: "L1", speaker: "Mitra", hinglish: "Arre beta, chai thandi ho jayegi.", emotion: "worried" } };
const VOICES: Assets = {
  facet: (entity, facet) =>
    facet === "voice" ? { version: "v1", value: { voice: "Charon", words: "warm and slow, a little hoarse" } } : { version: "v1", value: "Hinglish; calls everyone beta" },
};

describe("audio.speech: one voice line (D-58)", () => {
  const speech = (replicate: ReturnType<typeof fakeReplicate>) => replicate.creates().map((c) => (c.body as { input: Record<string, unknown> }).input);

  it("the prompt is what's said; the voice comes from the speaker's @voice; the rest says how", async () => {
    const replicate = fakeReplicate({ metrics: { token_input_count: 21, token_output_count: 121 } });
    const { s, rec, jobs } = start({ graph: voice, inputs: LINE, assets: VOICES, replicate, models: { "audio.speech": { params: { language_code: "hi-IN", voice: "Kore" } } } });
    await settle(s, jobs, describeError);
    expect(replicate.creates()[0]!.url).toBe("https://api.replicate.com/v1/models/google/gemini-3.1-flash-tts/predictions");
    expect(speech(replicate)[0]).toEqual({
      text: "Arre beta, chai thandi ho jayegi.",
      voice: "Charon", // the speaker's voice beats the default in the settings
      language_code: "hi-IN",
      prompt: "emotion: worried\nMitra's voice: warm and slow, a little hoarse\nMitra's speech: Hinglish; calls everyone beta",
    });
    const v = rec.state.nodes.speak!.versions["1.1"]!;
    expect(v.output.seconds).toBe(5);
    expect(v.costUsd).toBe(0.004882); // from Replicate's token counts: 21 in, 121 out
    expect(v.prompt).toBe("Say: Arre beta, chai thandi ho jayegi.\nHow: emotion: worried\n     Mitra's voice: warm and slow, a little hoarse\n     Mitra's speech: Hinglish; calls everyone beta\nVoice: Charon");
    expect(v.references).toEqual([{ label: "Mitra's voice", ref: "Charon" }]);
    expect(rec.state.nodes.listen!.status).toBe("awaiting_human");
  });

  it("a line over 8 seconds, measured from the audio, is redone faster: the step's style comes first", async () => {
    const replicate = fakeReplicate({ seconds: (n) => (n === 1 ? 9.4 : 6.2) });
    const { s, rec, jobs } = start({ graph: voice, inputs: LINE, assets: VOICES, replicate });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.speak!.versions["1.1"]!.output.seconds).toBe(9.4);
    expect(speech(replicate)[1]).toMatchObject({ prompt: "Speak about 20% faster than usual.\nemotion: worried\nMitra's voice: warm and slow, a little hoarse" });
    expect(rec.state.nodes.speak!.versions["2.1"]).toMatchObject({ madeBy: "too_long", output: { seconds: 6.2 } });
    expect(rec.state.nodes.listen!.status).toBe("awaiting_human");
  });

  it("a voice given as a name alone", async () => {
    const replicate = fakeReplicate();
    const { s, jobs } = start({ graph: voice, inputs: LINE, assets: { facet: (_e, f) => ({ version: "v1", value: f === "voice" ? "Puck" : "Hinglish" }) }, replicate });
    await settle(s, jobs, describeError);
    expect(speech(replicate)[0]).toMatchObject({ voice: "Puck", prompt: "emotion: worried\nMitra's speech: Hinglish" });
  });

  it("audio kriya can't measure fails a step that needs its length, saying why", async () => {
    const { s, rec, jobs } = start({ graph: voice, inputs: LINE, assets: VOICES, replicate: fakeReplicate({ bytes: new TextEncoder().encode("not a wav") }) });
    await settle(s, jobs, describeError);
    expect(rec.state.nodes.speak!.failure).toBe("'speak' needs the length of its audio (out: seconds), and kriya can't read it from this file; it reads WAV and MP4");
  });
});

describe("audio.music: a track", () => {
  it("the prompt goes to Lyria 2; a 30-second track costs $0.06", async () => {
    const music = recipe(`graph: music
level: part
inputs:
  mood: text
nodes:
  - id: score
    kind: model
    capability: audio.music
    prompt: "{{inputs.mood}}, Bollywood-style instrumental, no vocals"
    uses: [inputs.mood]
    out: { track: audio }
edges:
  - { from: score, to: END }
`);
    const replicate = fakeReplicate({ seconds: () => 30 });
    const { s, rec, jobs } = start({ graph: music, inputs: { mood: "comedy chase" }, replicate });
    await settle(s, jobs, describeError);
    const c = replicate.creates()[0]!;
    expect(c.url).toBe("https://api.replicate.com/v1/models/google/lyria-2/predictions");
    expect((c.body as { input: unknown }).input).toEqual({ prompt: "comedy chase, Bollywood-style instrumental, no vocals" });
    expect(rec.state.nodes.score!.versions["1.1"]).toMatchObject({ costUsd: 0.06, output: { track: expect.stringMatching(/^blob:/) } });
  });
});

describe("which steps Replicate runs", () => {
  it("only the capabilities it's given", () => {
    const rep = replicateExecutors({ graphs: [voice], jobs: new Jobs(), media: memoryMedia(), ledger: memoryLedger(), capabilities: ["image.generate", "image.edit"] });
    expect(rep.handles(shot.nodes[0]!)).toBe(true);
    expect(rep.handles(voice.nodes[0]!)).toBe(false);
  });
});

describe("durations from the file's own bytes", () => {
  it("WAV, MP4 (both header versions), and nothing for a format kriya doesn't read", () => {
    expect(durationOf(wavOf(4.84))).toBe(4.84);
    expect(durationOf(mp4Of(5))).toBe(5);
    expect(durationOf(mp4Of(10.5, 1))).toBe(10.5);
    expect(durationOf(new TextEncoder().encode("ID3 an mp3"))).toBeUndefined();
  });

  it("a streamed WAV that doesn't know its size runs to the end of the file", () => {
    const b = wavOf(2);
    new DataView(b.buffer).setUint32(40, 0xffffffff, true);
    expect(durationOf(b)).toBe(2);
  });
});
