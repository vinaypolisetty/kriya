import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteEventLog } from "@kriya/store";
import { loadText, Recorder, Scheduler, type Executors, type Graph } from "@kriya/engine";
import { describeError, durationOf, Jobs, mediaTools, settle, sniff, type Media } from "../src/index.js";

/** Real media made with ffmpeg: tools are tested on real files, not stand-ins. */
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const PYTHON = process.env.KRIYA_TEST_PYTHON ?? "python3";
const hasPillow = spawnSync(PYTHON, ["-c", "import PIL"]).status === 0;
const FONT = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"].find(existsSync);

function make(name: string, ...args: string[]): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "kriya-media-"));
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args, join(dir, name)]);
  return readFileSync(join(dir, name));
}

/** Media in memory, by `blob:<sha256>`, typed by its bytes. */
function memoryMedia(): Media & { put(bytes: Uint8Array): string; get(v: string): Uint8Array } {
  const blobs = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array) => {
    const h = createHash("sha256").update(bytes).digest("hex");
    blobs.set(h, bytes);
    return `blob:${h}`;
  };
  return {
    put,
    get: (v) => blobs.get(v.slice(5))!,
    read(v) {
      const b = v.startsWith("blob:") ? blobs.get(v.slice(5)) : undefined;
      return b ? { bytes: b, mime: sniff(b) } : undefined;
    },
    write: put,
  };
}

/** Width and height of a PNG, from its header. */
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
};

const probe = (bytes: Uint8Array) => {
  const dir = mkdtempSync(join(tmpdir(), "kriya-probe-"));
  const f = join(dir, "x.mp4");
  writeFileSync(f, bytes);
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", f]).toString()).streams as { codec_type: string; width?: number; height?: number }[];
};

function run(graph: Graph, media: ReturnType<typeof memoryMedia>, produce: Record<string, () => Record<string, unknown>[]>, decide: (screen: string, visit: number) => unknown, inputs: Record<string, unknown> = {}) {
  const jobs = new Jobs();
  const tools = mediaTools({ jobs, media, build: mkdtempSync(join(tmpdir(), "kriya-build-")), python: PYTHON, ...(FONT ? { font: FONT } : {}) });
  const visits: Record<string, number> = {};
  const exec: Executors = {
    produce: (node, ctx) => (tools.handles(node) ? tools.produce(node, ctx) : produce[node.id]!()),
    decide: (node) => decide(node.id, (visits[node.id] = (visits[node.id] ?? 0) + 1)) as never,
  };
  const rec = Recorder.start(new SqliteEventLog(openDatabase(":memory:")), "run1");
  const s = new Scheduler(graph, rec, exec, [graph]);
  s.start("a".repeat(64), inputs);
  return { rec, done: settle(s, jobs, describeError) };
}

const recipe = (text: string) => {
  const r = loadText(text);
  expect(r.problems).toEqual([]);
  return r.graphs[0]!;
};

const cropShot = recipe(`graph: shot
level: shot
nodes:
  - id: draw
    kind: model
    capability: image.generate
    out: { image: image }
  - id: pick
    kind: screen
    review: pick_one
    show: draw.image
    actions:
      - { id: lock, needs: [selection], locks: true }
      - { id: crop, needs: [selection, region] }
  - id: crop
    kind: tool
    tool: crop
    refines: draw
    out: { image: image }
edges:
  - { from: draw, to: pick }
  - { from: pick, to: crop, when: "action == 'crop'" }
  - { from: crop, to: pick, max_loops: 2 }
  - { from: pick, to: END, when: "action == 'lock'" }
`);

describe.skipIf(!hasFfmpeg)("media tools on real files (Day 19)", () => {
  it("crop: the region marked on the screen, in fractions or pixels, becomes the panel's next version", async () => {
    for (const [region, size] of [["0.25,0,0.5,1", [160, 180]], ["10,20,100,50", [100, 50]]] as const) {
      const media = memoryMedia();
      const panel = media.put(make("p.png", "-f", "lavfi", "-i", "testsrc=size=320x180", "-frames:v", "1"));
      const { rec, done } = run(cropShot, media, { draw: () => [{ image: panel }] }, (_s, n) => (n === 1 ? { action: "crop", selection: ["1.1"], region } : undefined));
      await done;
      const cropped = rec.state.nodes.draw!.versions["2.1"]!;
      expect(cropped).toMatchObject({ parents: ["1.1"], madeBy: "crop", model: "local:crop", costUsd: 0 });
      expect(pngSize(media.get(cropped.output.image as string))).toEqual(size);
    }
  });

  it("crop: a region that isn't one fails the step, saying what it needs", async () => {
    const media = memoryMedia();
    const panel = media.put(make("p.png", "-f", "lavfi", "-i", "testsrc=size=320x180", "-frames:v", "1"));
    const { rec, done } = run(cropShot, media, { draw: () => [{ image: panel }] }, (_s, n) => (n === 1 ? { action: "crop", selection: ["1.1"], region: "left half" } : undefined));
    await done;
    expect(rec.state.nodes.crop!.failure).toBe("a crop needs a region: --region x,y,w,h (pixels, or fractions like 0.1,0,0.8,1), not 'left half'");
  });

  it("compress: a video re-encoded under max_mb, with its size and length", async () => {
    const g = recipe(`graph: c
level: part
nodes:
  - id: render
    kind: model
    capability: video.make
    trust: always
    out: { reel: video }
  - id: squeeze
    kind: tool
    tool: compress
    uses: [render.reel]
    args: { video: render.reel, max_mb: 0.2 }
    out: { reel: video, mb: number, seconds: number }
edges:
  - { from: render, to: squeeze }
  - { from: squeeze, to: END }
`);
    const media = memoryMedia();
    const big = media.put(make("v.mp4", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "3", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p"));
    const { rec, done } = run(g, media, { render: () => [{ reel: big }] }, () => undefined);
    await done;
    const out = Object.values(rec.state.nodes.squeeze!.versions)[0]!.output as { reel: string; mb: number; seconds: number };
    expect(media.get(out.reel).length).toBeLessThan(0.2 * 1e6 * 1.1);
    expect(out.mb).toBeLessThan(0.22);
    expect(out.seconds).toBe(3);
    expect(media.get(big).length).toBeGreaterThan(media.get(out.reel).length);
  });

  it.skipIf(!hasPillow || !FONT)("assemble_reel: a vertical Reel from panels, a clip, voice lines and music, under max_mb", async () => {
    const g = recipe(`graph: part
level: part
inputs:
  shots: json
  lines: json
  panels: json
  clips: json
  voices: json
  music: json
nodes:
  - id: assemble
    kind: tool
    tool: assemble_reel
    uses: [inputs.shots, inputs.lines, inputs.panels, inputs.clips, inputs.voices, inputs.music]
    args: { shots: inputs.shots, lines: inputs.lines, panels: inputs.panels, clips: inputs.clips, voices: inputs.voices, music: inputs.music, hook: "Who will close the valve?", title: MOHALLA MITRA, max_mb: 5 }
    out: { reel: video, seconds: number }
edges:
  - { from: assemble, to: END }
`);
    const media = memoryMedia();
    const still = media.put(make("s.png", "-f", "lavfi", "-i", "testsrc=size=1280x720", "-frames:v", "1"));
    const clip = media.put(make("c.mp4", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "2", "-pix_fmt", "yuv420p"));
    const line = (s: number) => media.put(make("l.wav", "-f", "lavfi", "-i", `sine=frequency=440:duration=${s}`, "-ar", "24000", "-ac", "1"));
    const music = media.put(make("m.wav", "-f", "lavfi", "-i", "sine=frequency=220:duration=10"));
    const lines = [{ id: "L1", caption_en: "Water! Water's here!" }, { id: "L2", caption_en: "Impossible!" }];
    const { rec, done } = run(g, media, {}, () => undefined, {
      shots: [{ id: "S1", lines: [{ id: "L1" }], music: "main" }, { id: "S2", lines: [{ id: "L2" }], music: "chase" }],
      lines,
      panels: [still, still],
      clips: [null, clip],
      voices: [line(1.5), line(2)],
      music: { main: music, chase: music },
    });
    await done;
    const a = rec.state.nodes.assemble!;
    expect(a.failure).toBeUndefined();
    const out = Object.values(a.versions)[0]!.output as { reel: string; seconds: number };
    const reel = media.get(out.reel);
    expect(probe(reel)).toEqual([expect.objectContaining({ codec_type: "video", width: 1080, height: 1920 }), expect.objectContaining({ codec_type: "audio" })]);
    expect(out.seconds).toBeGreaterThan(4 + 4 + 3); // two shots of at least 4 s, then the end card
    expect(durationOf(reel)).toBeCloseTo(out.seconds, 0);
    expect(reel.length).toBeLessThan(5e6);
  }, 120_000);

  it.skipIf(!hasPillow || !FONT)("assemble_reel draft: voices per shot, a short plain ending, no Instagram copy", async () => {
    const g = recipe(`graph: part
level: part
inputs:
  shots: json
  panels: json
  voices: json
nodes:
  - id: cut
    kind: tool
    tool: assemble_reel
    uses: [inputs.shots, inputs.panels, inputs.voices]
    args: { shots: inputs.shots, panels: inputs.panels, voices: inputs.voices, title: MOHALLA MITRA, draft: true }
    out: { reel: video, seconds: number }
edges:
  - { from: cut, to: END }
`);
    const media = memoryMedia();
    const still = media.put(make("s.png", "-f", "lavfi", "-i", "testsrc=size=1280x720", "-frames:v", "1"));
    const line = (s: number) => media.put(make("l.wav", "-f", "lavfi", "-i", `sine=frequency=440:duration=${s}`, "-ar", "24000", "-ac", "1"));
    const { rec, done } = run(g, media, {}, () => undefined, {
      shots: [{ id: "S1", lines: [{ id: "L1" }, { id: "L2" }] }, { id: "S2", lines: [] }, { id: "S3", lines: [{ id: "L1" }] }],
      panels: [still, still, still],
      voices: [[line(3), line(3)], [], [line(5)]],
    });
    await done;
    const a = rec.state.nodes.cut!;
    expect(a.failure).toBeUndefined();
    const out = Object.values(a.versions)[0]!.output as { reel: string; seconds: number };
    // S1 holds both its lines (over 6 s) and S3 its one (over 5 s), which only happens if each shot found its own voices.
    expect(out.seconds).toBeGreaterThan(6.3 + 4 + 5.3 + 1.5);
    expect(out.seconds).toBeLessThan(6.3 + 4 + 5.3 + 1.5 + 2);
  }, 120_000);

  it("extract_frames: a frame every half second, with its time; a clip too long to look through fails plainly", async () => {
    const g = recipe(`graph: f
level: clip
inputs: { video: video }
nodes:
  - id: frames
    kind: tool
    tool: extract_frames
    uses: [inputs.video]
    args: { video: inputs.video, every: 0.5, width: 160 }
    out: { frames: list<image>, times: list<number>, seconds: number }
edges:
  - { from: frames, to: END }
`);
    const media = memoryMedia();
    const video = media.put(make("v.mp4", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-pix_fmt", "yuv420p"));
    const { rec, done } = run(g, media, {}, () => undefined, { video });
    await done;
    const out = Object.values(rec.state.nodes.frames!.versions)[0]!.output as { frames: string[]; times: number[]; seconds: number };
    expect(out.times).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
    expect(out.frames).toHaveLength(6);
    expect(sniff(media.get(out.frames[0]!))).toBe("image/jpeg");
    expect(out.seconds).toBeCloseTo(3, 1);

    const long = recipe(JSON.stringify({ ...g, nodes: [{ ...g.nodes[0], args: { video: "inputs.video", every: 0.01 } }] }));
    const again = run(long, media, {}, () => undefined, { video });
    await again.done;
    expect(again.rec.state.nodes.frames!.failure).toMatch(/^this clip is 3 s, which is 301 frames at one every 0.01 s; kriya looks at up to 120\. Trim the clip, or set every: /);
  });

  it("stills and attach: each moment gets a full-size frame, and each drawing carries its moment's frame", async () => {
    const g = recipe(`graph: s
level: clip
inputs: { video: video, moments: json, drawings: json }
nodes:
  - id: stills
    kind: tool
    tool: stills
    uses: [inputs.video, inputs.moments]
    args: { video: inputs.video, items: inputs.moments }
    out: { moments: list<json> }
  - id: with_frame
    kind: tool
    tool: attach
    uses: [inputs.drawings, stills.moments]
    args: { items: inputs.drawings, frame: stills.moments, hold: 2 }
    out: { drawings: list<json> }
edges:
  - { from: stills, to: with_frame }
  - { from: with_frame, to: END }
`);
    const media = memoryMedia();
    const video = media.put(make("v.mp4", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "2", "-pix_fmt", "yuv420p"));
    const { rec, done } = run(g, media, {}, () => undefined, { video, moments: [{ id: "m1", t: 0.4 }, { id: "m2", t: 1.6 }], drawings: [{ id: "d1" }, { id: "d2" }] });
    await done;
    expect(rec.state.nodes.stills!.failure).toBeUndefined();
    const moments = Object.values(rec.state.nodes.stills!.versions)[0]!.output.moments as { id: string; frame: string }[];
    expect(moments.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(pngSize(media.get(moments[0]!.frame))).toEqual([320, 180]);
    const drawings = Object.values(rec.state.nodes.with_frame!.versions)[0]!.output.drawings as Record<string, unknown>[];
    expect(drawings).toEqual([{ id: "d1", frame: moments, hold: 2 }, { id: "d2", frame: moments, hold: 2 }]);
  });
});

describe.skipIf(!hasFfmpeg || !hasPillow)("insert_caricatures (workers/insert_caricatures.py)", () => {
  it("cuts away at each moment in its layout, sound paused, the video longer by every cut", async () => {
    const g = recipe(`graph: c
level: clip
inputs: { video: video, moments: json, layouts: json, caricatures: json, subjects: json, captions: json }
nodes:
  - id: cut
    kind: tool
    tool: insert_caricatures
    uses: [inputs.video, inputs.moments, inputs.layouts, inputs.caricatures, inputs.subjects, inputs.captions]
    args: { video: inputs.video, moments: inputs.moments, layouts: inputs.layouts, caricatures: inputs.caricatures, subjects: inputs.subjects, captions: inputs.captions, hold: 1 }
    out: { video: video, seconds: number }
edges:
  - { from: cut, to: END }
`);
    const media = memoryMedia();
    const video = media.put(make("v.mp4", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-pix_fmt", "yuv420p", "-shortest"));
    const toon = media.put(make("k.png", "-f", "lavfi", "-i", "color=c=white:size=400x400,drawbox=x=100:y=100:w=200:h=200:color=red:t=fill", "-frames:v", "1"));
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.6 };
    const { rec, done } = run(g, media, {}, () => undefined, {
      video,
      moments: [{ id: "m1", t: 1, cast: [{ id: "man", box }] }, { id: "m2", t: 2, cast: [] }, { id: "m3", t: 3, cast: [{ id: "man", box }, { id: "dog", box }] }],
      layouts: ["group", "one_each", "over_frame"],
      caricatures: [[toon], [toon, toon], [toon, toon]],
      subjects: [[["man"]], [["man"], ["dog"]], [["man"], ["dog"]]],
      captions: ["Gravity: 1, Ravi: 0", "", "The dog planned this"],
    });
    await done;
    const c = rec.state.nodes.cut!;
    expect(c.failure).toBeUndefined();
    const out = Object.values(c.versions)[0]!.output as { video: string; seconds: number };
    const cut = media.get(out.video);
    expect(probe(cut)).toEqual([expect.objectContaining({ codec_type: "video", width: 640, height: 360 }), expect.objectContaining({ codec_type: "audio" })]);
    expect(out.seconds).toBeCloseTo(4 + 1 + 2 + 1, 0); // group: one hold; one_each: one per drawing; over_frame: one hold
  }, 120_000);

  it("plays a moment's flipbook after its caricature, and leaves a moment without one alone", async () => {
    const g = recipe(`graph: c
level: clip
inputs: { video: video, moments: json, caricatures: json, flipbooks: json }
nodes:
  - id: cut
    kind: tool
    tool: insert_caricatures
    uses: [inputs.video, inputs.moments, inputs.caricatures, inputs.flipbooks]
    args: { video: inputs.video, moments: inputs.moments, caricatures: inputs.caricatures, flipbooks: inputs.flipbooks, hold: 1, beat: 0.5 }
    out: { video: video, seconds: number }
edges:
  - { from: cut, to: END }
`);
    const media = memoryMedia();
    const video = media.put(make("fv.mp4", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-pix_fmt", "yuv420p", "-shortest"));
    const toon = media.put(make("fk.png", "-f", "lavfi", "-i", "color=c=white:size=400x400", "-frames:v", "1"));
    const { rec, done } = run(g, media, {}, () => undefined, {
      video,
      moments: [{ id: "m1", t: 1 }, { id: "m2", t: 2 }],
      caricatures: [[toon], [toon]],
      flipbooks: [[toon, toon, toon], []],
    });
    await done;
    const c = rec.state.nodes.cut!;
    expect(c.failure).toBeUndefined();
    const out = Object.values(c.versions)[0]!.output as { seconds: number };
    expect(out.seconds).toBeCloseTo(3 + 1 + 1 + 3 * 0.5, 0); // two holds, and three pages on the first moment only
  }, 120_000);
});

describe("first", () => {
  const g = () => recipe(`graph: c
level: clip
inputs: { list: json }
nodes:
  - id: lead
    kind: tool
    tool: first
    uses: [inputs.list]
    args: { list: inputs.list }
    out: { image: image }
edges:
  - { from: lead, to: END }
`);

  it("takes the first entry of a list", async () => {
    const { rec, done } = run(g(), memoryMedia(), {}, () => undefined, { list: ["blob:a", "blob:b"] });
    await done;
    expect(Object.values(rec.state.nodes.lead!.versions)[0]!.output).toEqual({ image: "blob:a" });
  });

  it("says so when the list is empty", async () => {
    const { rec, done } = run(g(), memoryMedia(), {}, () => undefined, { list: [] });
    await done;
    expect(rec.state.nodes.lead!.failure).toMatch(/empty list/);
  });
});
