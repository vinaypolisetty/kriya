/**
 * Local media tools (Day 19): `crop`, `compress` and `assemble_reel`, run on
 * this machine with ffmpeg as tool steps. They take a while, so each runs as a
 * job like a model call (D-53): the step waits on a ticket and `settle()`
 * delivers the result. Everything they make goes into the blob store.
 *
 * - `crop`: refines an image step; the region marked on the screen
 *   (`--region x,y,w,h`, in pixels, or fractions of the image when all are ≤ 1).
 * - `compress`: re-encodes a video to fit under `max_mb` (default 30).
 * - `assemble_reel`: the Mohalla Mitra Reel assembler (workers/assemble_reel.py):
 *   shots timed to their voice lines, pan and zoom on stills, clips held on
 *   their last frame, captions, an end card, music ducked under the voices.
 *   `fit: whole` shows each wide panel entire over a blurred copy, instead of
 *   filling the tall frame and cropping the sides (`pan`, the default);
 *   `background: black` puts it on black instead of the blurred copy;
 *   `leave_out: [shot ids]` drops those shots and their lines from the cut.
 * - `extract_frames`: small frames of a video every `every` seconds, with their
 *   times, for a vision step to look through (Claude sees frames, not video).
 * - `stills`: a full-size frame of the video at each item's `t`, added to the
 *   item as `frame` (the reference a caricature is drawn from).
 * - `attach`: copies values onto every item of a list (a for-each item sees
 *   only itself, so what it needs from outside rides along on it).
 * - `insert_caricatures`: cuts caricatures into a video at their moments
 *   (workers/insert_caricatures.py): full-screen one at a time, or popped over
 *   the frozen frame where each subject stands.
 *
 * A tool's args may name one of the step's `uses` to get its value
 * (`reel: assemble.reel`); anything else is passed as written.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Executors, Node, StepContext } from "@kriya/engine";
import { durationOf } from "./duration.js";
import { EXT } from "./files.js";
import type { Jobs } from "./jobs.js";
import type { Media } from "./replicate.js";

export const MEDIA_TOOLS = ["crop", "compress", "assemble_reel", "extract_frames", "stills", "attach", "insert_caricatures"] as const;

const WORKER = fileURLToPath(new URL("../workers/assemble_reel.py", import.meta.url));
const CUTAWAYS = fileURLToPath(new URL("../workers/insert_caricatures.py", import.meta.url));

/** The most frames `extract_frames` hands a vision step: past this the clip is too long to look through. */
const MAX_FRAMES = 120;

export type ToolOptions = {
  jobs: Jobs;
  media: Media;
  /** Scratch space for the files ffmpeg works on, e.g. `.kriya/build`; each step gets its own folder. */
  build: string;
  /** The Python that runs `assemble_reel` and `insert_caricatures` (they need Pillow). Default: python3. */
  python?: string;
  /** A .ttf for captions and the end card; `assemble_reel` needs one. */
  font?: string;
};

/** A tool that couldn't do its job, in plain words. */
export class ToolError extends Error {}

type ToolNode = Extract<Node, { kind: "tool" }>;

export function mediaTools(opts: ToolOptions): Pick<Executors, "produce"> & { handles(node: Node): boolean } {
  return {
    handles: (node) => node.kind === "tool" && (MEDIA_TOOLS as readonly string[]).includes(node.tool),

    produce(node, ctx) {
      if (node.kind !== "tool") throw new Error(`the media tools don't run ${node.kind} steps`);
      const key = ctx.idempotencyKey!;
      const ticket = `tool:${key}`;
      const dir = join(opts.build, createHash("sha256").update(key).digest("hex").slice(0, 16));
      opts.jobs.start(ticket, {
        kind: "outputs",
        run: async () => {
          rmSync(dir, { recursive: true, force: true }); // a rerun after a crash starts clean
          mkdirSync(dir, { recursive: true });
          try {
            const output = await TOOLS[node.tool as (typeof MEDIA_TOOLS)[number]](node, ctx, { ...opts, dir });
            return { outputs: [output], meta: [{ model: `local:${node.tool}`, cost_usd: 0 }] };
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      });
      return { ticket };
    },
  };
}

type Run = (node: ToolNode, ctx: StepContext, o: ToolOptions & { dir: string }) => Promise<Record<string, unknown>>;

const TOOLS: Record<(typeof MEDIA_TOOLS)[number], Run> = {
  async crop(node, ctx, o) {
    const field = outField(node, "image");
    const src = ctx.parent?.output[field];
    if (src === undefined) throw new ToolError(`'${node.id}' crops the version being refined; add refines: <the image step> to it`);
    const r = String(ctx.region ?? "").split(",").map(Number);
    if (r.length !== 4 || r.some((n) => !Number.isFinite(n) || n < 0) || r[2] === 0 || r[3] === 0) {
      throw new ToolError(`a crop needs a region: --region x,y,w,h (pixels, or fractions like 0.1,0,0.8,1), not '${String(ctx.region ?? "")}'`);
    }
    const [x, y, w, h] = r as [number, number, number, number];
    const frac = r.every((n) => n <= 1);
    const v = (n: number, side: "iw" | "ih") => (frac ? `${side}*${n}` : String(Math.round(n)));
    const input = file(o, src, "in");
    const out = join(o.dir, "out.png");
    await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-vf", `crop=${v(w, "iw")}:${v(h, "ih")}:${v(x, "iw")}:${v(y, "ih")}`, "-frames:v", "1", out]);
    return { [field]: o.media.write(readFileSync(out)) };
  },

  async compress(node, ctx, o) {
    const field = outField(node, "video");
    const src = arg(node, ctx, "video") ?? ctx.parent?.output[field];
    if (src === undefined) throw new ToolError(`'${node.id}' needs the video to compress: args: { video: <step>.<field> }, with that step in its uses`);
    const maxMb = Number(arg(node, ctx, "max_mb") ?? 30);
    const input = file(o, src, "in");
    const seconds = durationOf(readFileSync(input));
    if (!seconds) throw new ToolError(`'${node.id}' couldn't read how long the video is; it reads MP4`);
    const kbps = Math.max(300, Math.floor((maxMb * 8000 * 0.92) / seconds) - 128);
    const out = join(o.dir, "out.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-c:v", "libx264", "-preset", "slow", "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.25)}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
    const bytes = readFileSync(out);
    return { [field]: o.media.write(bytes), ...extras(node, { mb: round(bytes.length / 1e6), seconds }) };
  },

  async assemble_reel(node, ctx, o) {
    const field = outField(node, "video");
    if (!o.font) throw new ToolError("assemble_reel draws captions and needs a font: set tools: { font: fonts/Poppins-Bold.ttf } in kriya.yaml");
    const shots = arg(node, ctx, "shots");
    const lines = arg(node, ctx, "lines");
    const panels = arg(node, ctx, "panels");
    const clips = arg(node, ctx, "clips");
    const voices = arg(node, ctx, "voices");
    if (!Array.isArray(shots) || !Array.isArray(panels)) {
      throw new ToolError(`'${node.id}' needs args shots and panels (and usually lines, voices, clips, hook, music), each naming one of its uses, e.g. shots: shot_list.shots`);
    }
    const lineList = Array.isArray(lines) ? (lines as { id?: string }[]) : [];
    const leaveOut = arg(node, ctx, "leave_out") ?? [];
    if (!Array.isArray(leaveOut)) throw new ToolError(`'${node.id}' has leave_out: ${JSON.stringify(leaveOut)}; give a list of shot ids, e.g. leave_out: [P2-12]`);
    const segments = (shots as { id?: string; lines?: { id?: string }[]; music?: string }[]).flatMap((shot, i) => {
      if (shot.id != null && leaveOut.includes(shot.id)) return [];
      const clip = Array.isArray(clips) ? clips[i] : undefined;
      const panel = panels[i];
      if (panel == null && clip == null) throw new ToolError(`shot ${shot.id ?? i + 1} has no panel or clip to show`);
      const said = (shot.lines ?? []).flatMap((l) => {
        const at = lineList.findIndex((x) => x.id === l.id);
        const audio = at >= 0 && Array.isArray(voices) ? voices[at] : undefined;
        if (audio == null) return [];
        const full: Record<string, unknown> = { ...l, ...lineList[at] };
        return [{ audio: file(o, audio, `v${i}_${at}`), caption: String(full.caption_en ?? full.caption ?? "") }];
      });
      return [{ ...(clip != null ? { clip: file(o, clip, `c${i}`) } : { image: file(o, panel, `p${i}`) }), lines: said, ...(shot.music ? { music: shot.music } : {}) }];
    });
    const fit = arg(node, ctx, "fit") ?? "pan";
    if (fit !== "pan" && fit !== "whole") throw new ToolError(`'${node.id}' has fit: ${JSON.stringify(fit)}; use pan (fill the frame, crop the sides) or whole (show the whole picture)`);
    const background = arg(node, ctx, "background") ?? "blur";
    if (background !== "blur" && background !== "black") throw new ToolError(`'${node.id}' has background: ${JSON.stringify(background)}; use blur (a blurred copy of the picture) or black`);
    const music = arg(node, ctx, "music");
    const manifest = {
      build: o.dir,
      font: o.font,
      out: join(o.dir, "reel.mp4"),
      out_ig: join(o.dir, "reel-ig.mp4"),
      segments,
      hook: arg(node, ctx, "hook") ?? "",
      title: arg(node, ctx, "title") ?? "",
      max_mb: Number(arg(node, ctx, "max_mb") ?? 30),
      fit,
      background,
      captions: arg(node, ctx, "captions") !== false,
      music: Object.fromEntries(Object.entries((music ?? {}) as Record<string, unknown>).map(([cue, v]) => [cue, file(o, v, `m_${cue.replace(/\W/g, "_")}`)])),
    };
    writeFileSync(join(o.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    const said = await run(o.python ?? "python3", [WORKER, join(o.dir, "manifest.json")]);
    const result = JSON.parse(said.trim().split("\n").at(-1)!) as { seconds: number; mb: number };
    return { [field]: o.media.write(readFileSync(manifest.out_ig)), ...extras(node, result) };
  },

  async extract_frames(node, ctx, o) {
    const src = arg(node, ctx, "video");
    if (src === undefined) throw new ToolError(`'${node.id}' needs the video to look through: args: { video: inputs.video }, with it in its uses`);
    const every = Number(arg(node, ctx, "every") ?? 0.5);
    const width = Number(arg(node, ctx, "width") ?? 512);
    if (!(every > 0)) throw new ToolError(`every is how many seconds apart the frames are, e.g. every: 0.5, not '${String(arg(node, ctx, "every"))}'`);
    const input = file(o, src, "in");
    const seconds = durationOf(readFileSync(input));
    if (!seconds) throw new ToolError(`'${node.id}' couldn't read how long the video is; it reads MP4`);
    const count = Math.floor(seconds / every + 1e-9) + 1;
    if (count > MAX_FRAMES) {
      throw new ToolError(`this clip is ${Math.round(seconds)} s, which is ${count} frames at one every ${every} s; kriya looks at up to ${MAX_FRAMES}. Trim the clip, or set every: ${Math.ceil((seconds / (MAX_FRAMES - 1)) * 10) / 10}`);
    }
    const times = Array.from({ length: count }, (_, i) => round(i * every)).filter((t) => t < seconds);
    const frames: string[] = [];
    for (const [i, t] of times.entries()) {
      const out = join(o.dir, `f${i}.jpg`);
      await run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out]);
      frames.push(o.media.write(readFileSync(out)));
    }
    return { [listField(node, "image")]: frames, ...(node.out.times ? { times } : {}), ...extras(node, { seconds: round(seconds) }) };
  },

  async stills(node, ctx, o) {
    const src = arg(node, ctx, "video");
    const items = arg(node, ctx, "items");
    if (src === undefined || !Array.isArray(items)) throw new ToolError(`'${node.id}' needs args video and items (a list whose items each have a time t), each naming one of its uses`);
    const input = file(o, src, "in");
    const out: Record<string, unknown>[] = [];
    for (const [i, item] of (items as Record<string, unknown>[]).entries()) {
      const t = Number(item.t);
      if (!Number.isFinite(t) || t < 0) throw new ToolError(`item ${String(item.id ?? i + 1)} has no time t in seconds to take a frame at`);
      const still = join(o.dir, `s${i}.png`);
      await run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", input, "-frames:v", "1", still]);
      out.push({ ...item, frame: o.media.write(readFileSync(still)) });
    }
    return { [listField(node)]: out };
  },

  async attach(node, ctx) {
    const items = arg(node, ctx, "items");
    if (!Array.isArray(items)) throw new ToolError(`'${node.id}' needs args items (the list) and the values to copy onto each, e.g. args: { items: joke.drawings, frame: item.frame }`);
    const add = Object.fromEntries(Object.keys(node.args).filter((k) => k !== "items").map((k) => [k, arg(node, ctx, k)]));
    return { [listField(node)]: (items as Record<string, unknown>[]).map((item) => ({ ...item, ...add })) };
  },

  async insert_caricatures(node, ctx, o) {
    const field = outField(node, "video");
    const src = arg(node, ctx, "video");
    const moments = arg(node, ctx, "moments");
    const caricatures = arg(node, ctx, "caricatures");
    if (src === undefined || !Array.isArray(moments) || !Array.isArray(caricatures)) {
      throw new ToolError(`'${node.id}' needs args video, moments and caricatures (and usually layouts, subjects, captions), each naming one of its uses, e.g. caricatures: draw.caricatures`);
    }
    const column = (name: string) => {
      const v = arg(node, ctx, name);
      return Array.isArray(v) ? v : [];
    };
    const [layouts, subjects, captions] = [column("layouts"), column("subjects"), column("captions")];
    const cuts = (moments as { id?: string; t?: unknown; cast?: { id?: string; box?: unknown }[] }[]).map((m, i) => {
      const drawn = caricatures[i];
      const images = (Array.isArray(drawn) ? drawn : drawn == null ? [] : [drawn]).map((v, j) => file(o, v, `k${i}_${j}`));
      if (images.length === 0) throw new ToolError(`moment ${m.id ?? i + 1} has no caricature to cut to`);
      const who = Array.isArray(subjects[i]) ? (subjects[i] as unknown[]) : [];
      // Where each drawing goes when popped over the frame: the box of the first subject in it.
      const boxes = images.map((_, j) => {
        const first = [who[j]].flat()[0];
        return (m.cast ?? []).find((c) => c.id === first)?.box ?? null;
      });
      return { t: Number(m.t), layout: String(layouts[i] ?? "group"), images, boxes, caption: String(captions[i] ?? "") };
    });
    if (cuts.some((c) => !Number.isFinite(c.t))) throw new ToolError("every moment needs a time t in seconds");
    const manifest = { build: o.dir, video: file(o, src, "in"), font: o.font ?? null, hold: Number(arg(node, ctx, "hold") ?? 1.5), out: join(o.dir, "out.mp4"), cuts };
    writeFileSync(join(o.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    const said = await run(o.python ?? "python3", [CUTAWAYS, join(o.dir, "manifest.json")]);
    const result = JSON.parse(said.trim().split("\n").at(-1)!) as { seconds: number; mb: number };
    return { [field]: o.media.write(readFileSync(manifest.out)), ...extras(node, result) };
  },
};

/** The step's list output field, of `list<type>` if given: `out: { frames: list<image> }` → "frames". */
function listField(node: ToolNode, type?: string): string {
  const f = Object.entries(node.out).find(([, t]) => (type ? t === `list<${type}>` : t.startsWith("list<")))?.[0];
  if (!f) throw new ToolError(`'${node.id}' makes a list, so its out needs a list field, e.g. out: { ${type ? `frames: list<${type}>` : "items: list<item>"} }`);
  return f;
}

/** The step's output field of this type: `out: { reel: video }` → "reel". */
function outField(node: ToolNode, type: string): string {
  const f = Object.entries(node.out).find(([, t]) => t === type)?.[0];
  if (!f) throw new ToolError(`'${node.id}' makes a ${type}, so its out needs a ${type} field, e.g. out: { ${type}: ${type} }`);
  return f;
}

/** Number fields the step declares (`seconds`, `mb`), filled from what the tool measured. */
function extras(node: ToolNode, measured: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(measured).filter(([k]) => node.out[k] === "number"));
}

/** An arg's value: one of the step's uses if it names one, else as written. */
function arg(node: ToolNode, ctx: StepContext, name: string): unknown {
  const a = node.args[name];
  return typeof a === "string" && a in ctx.uses ? ctx.uses[a] : a;
}

/** A media value (`blob:…` or a project file) as a file ffmpeg can open, with the right extension. */
function file(o: ToolOptions & { dir: string }, value: unknown, name: string): string {
  const got = typeof value === "string" ? o.media.read(value) : undefined;
  if (!got || "url" in got) throw new ToolError(`there's no file kriya can read for ${JSON.stringify(value)}`);
  const path = join(o.dir, `${name}.${EXT[got.mime] ?? "bin"}`);
  writeFileSync(path, got.bytes);
  return path;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Runs a program; its output, or a plain error with the end of what it said. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => fail(new ToolError(`couldn't start ${cmd} (${(e as NodeJS.ErrnoException).code === "ENOENT" ? "it isn't installed or isn't on PATH" : e.message})`)));
    p.on("close", (code) => {
      if (code === 0) return ok(out);
      const said = `${out}\n${err}`.trim().split("\n").reverse().find((l) => l.startsWith("{"));
      const reason = said ? (JSON.parse(said) as { error?: string }).error : undefined;
      fail(new ToolError(reason ?? `${cmd} failed: ${err.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`));
    });
  });
}
