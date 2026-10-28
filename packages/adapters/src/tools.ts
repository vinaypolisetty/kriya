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
 *   filling the tall frame and cropping the sides (`pan`, the default).
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

export const MEDIA_TOOLS = ["crop", "compress", "assemble_reel"] as const;

const WORKER = fileURLToPath(new URL("../workers/assemble_reel.py", import.meta.url));

export type ToolOptions = {
  jobs: Jobs;
  media: Media;
  /** Scratch space for the files ffmpeg works on, e.g. `.kriya/build`; each step gets its own folder. */
  build: string;
  /** The Python that runs `assemble_reel` (it needs Pillow). Default: python3. */
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
    const segments = (shots as { id?: string; lines?: { id?: string }[]; music?: string }[]).map((shot, i) => {
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
      return { ...(clip != null ? { clip: file(o, clip, `c${i}`) } : { image: file(o, panel, `p${i}`) }), lines: said, ...(shot.music ? { music: shot.music } : {}) };
    });
    const fit = arg(node, ctx, "fit") ?? "pan";
    if (fit !== "pan" && fit !== "whole") throw new ToolError(`'${node.id}' has fit: ${JSON.stringify(fit)}; use pan (fill the frame, crop the sides) or whole (show the whole picture)`);
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
      music: Object.fromEntries(Object.entries((music ?? {}) as Record<string, unknown>).map(([cue, v]) => [cue, file(o, v, `m_${cue.replace(/\W/g, "_")}`)])),
    };
    writeFileSync(join(o.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    const said = await run(o.python ?? "python3", [WORKER, join(o.dir, "manifest.json")]);
    const result = JSON.parse(said.trim().split("\n").at(-1)!) as { seconds: number; mb: number };
    return { [field]: o.media.write(readFileSync(manifest.out_ig)), ...extras(node, result) };
  },
};

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
