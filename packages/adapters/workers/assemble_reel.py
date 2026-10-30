"""kriya's assemble_reel worker: one vertical Reel from a manifest kriya writes.

The Mohalla Mitra Part 3 assembler (reel_assembler_part3.py), with everything
that was hardcoded for that episode read from the manifest instead:

  * each shot is a segment, timed to its voice lines (at least `min` seconds)
  * stills pan and zoom (alternating drift); clips play, then hold their last frame
  * `fit: whole` shows each wide panel or clip entire, across the middle, over a
    blurred copy of itself, or on black with `background: black` (the default,
    `pan`, fills the frame and crops the sides)
  * captions and the end card are drawn with Pillow and overlaid (no drawtext needed)
  * music sections follow each shot's cue and duck under the voices
  * a second copy is encoded to fit under `max_mb` for Instagram

Usage: python assemble_reel.py manifest.json   (prints one JSON line: the result)
Needs ffmpeg and ffprobe on PATH, and Pillow.
"""
import json
import os
import re
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print(json.dumps({"error": "this Python has no Pillow (pip install pillow); set tools.python in kriya.yaml to one that has it"}))
    sys.exit(2)

M = json.load(open(sys.argv[1]))
S = M["build"]
FONT = M["font"]
FIT = M.get("fit", "pan")

X = 0.7            # crossfade
H = X / 2
GAP = 0.35         # gap between lines in a shot
ENC = ["-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30"]
N = "setsar=1,fps=30,format=yuv420p"
W, HT = 1080, 1920


def ff(*a):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *a], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(json.dumps({"error": f"ffmpeg failed: {r.stderr.strip()[-300:]}"}))


def dur(f):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f],
                                capture_output=True, text=True).stdout)


# ---------------------------------------------------------------- voices
V = {}
for i, seg in enumerate(M["segments"]):
    for j, ln in enumerate(seg["lines"]):
        k = f"{i}_{j}"
        norm = f"{S}/v_{k}.wav"
        ff("-i", ln["audio"], "-af", "loudnorm=I=-15:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", norm)
        d = dur(norm)
        sd = subprocess.run(["ffmpeg", "-i", norm, "-af", "silencedetect=n=-40dB:d=0.25", "-f", "null", "-"],
                            capture_output=True, text=True).stderr
        ss = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", sd)]
        se = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sd)]
        s0 = se[0] if ss and ss[0] < 0.05 and se else 0
        e0 = ss[-1] if ss and ss[-1] > d - 1.0 else d
        V[k] = (norm, s0, e0, ln.get("caption") or "")

# ---------------------------------------------------- timing: each segment fits its lines
SEG = [f"s{i:02d}" for i in range(len(M["segments"]))] + ["end"]
place, segdur = [], {}
t = 0.0
for i, seg in enumerate(M["segments"]):
    cur = 0.3
    for j, _ in enumerate(seg["lines"]):
        norm, s0, e0, _cap = V[f"{i}_{j}"]
        place.append((f"{i}_{j}", t + cur - s0, t + cur, t + cur - s0 + e0))
        cur += (e0 - s0) + GAP
    segdur[SEG[i]] = max(seg.get("min", 4.0), cur + 0.4)
    t += segdur[SEG[i]]
segdur["end"] = M.get("end_seconds", 3.8)
TOTAL = t + segdur["end"]
start, acc = {}, 0.0
for n in SEG:
    start[n] = acc
    acc += segdur[n]
L = {n: segdur[n] + (H if i in (0, len(SEG) - 1) else X) for i, n in enumerate(SEG)}


def kf(points):
    expr = str(points[-1][1])
    for (t0, v0), (t1, v1) in reversed(list(zip(points, points[1:]))):
        d = max(t1 - t0, 0.01)
        expr = f"if(lt(t,{t1:.3f}),{v0}+({v1}-{v0})*(1-cos(PI*max(t-{t0:.3f},0)/{d:.3f}))/2,{expr})"
    return expr


# Behind a whole panel or clip: a copy of it filling the frame, blurred and darkened, or plain black.
BACKDROP = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920," + (
    "drawbox=t=fill:c=black" if M.get("background") == "black" else "boxblur=40:3,eq=brightness=-0.12")


def whole(src, name, i):
    """A still, entire: across the middle at full width, growing slowly to it, over its blurred self."""
    d, sd = L[name], segdur[name]
    z = f"({kf([(H, 0.94), (sd + H, 1.0)])})"
    w0, h0 = Image.open(src).size
    fc = (f"[0:v]split[a][b];[a]{BACKDROP}[bg];"
          f"[b]scale=w='trunc(1080*{z}/2)*2':h='trunc(1080*{z}*{h0 / w0:.5f}/2)*2':eval=frame:flags=bicubic[fg];"
          f"[bg][fg]overlay=x='(W-w)/2':y='(H-h)/2':eval=frame,{N}[v]")
    ff("-loop", "1", "-framerate", "30", "-t", f"{d:.3f}", "-i", src, "-filter_complex", fc, "-map", "[v]", *ENC, f"{S}/{name}.mp4")


def still(src, name, i):
    """A still: scaled to fill the height, a slow zoom, drifting left or right (alternating)."""
    if FIT == "whole":
        return whole(src, name, i)
    d, sd = L[name], segdur[name]
    a, b = (0.4, 0.55) if i % 2 == 0 else (0.55, 0.4)
    xk = [(H, a), (sd + H, b)]
    zk = [(H, 1.04), (sd + H, 1.13)]
    z = f"({kf(zk)})"
    w0, h0 = Image.open(src).size
    ar = w0 / h0
    vf = (f"scale=w='trunc(iw*1920/ih*{z}/2)*2':h='trunc(1920*{z}/2)*2':eval=frame:flags=bicubic,"
          f"crop=1080:1920:x='max(0,(trunc({ar}*1920*{z}/2)*2-1080))*({kf(xk)})'"
          f":y='(trunc(1920*{z}/2)*2-1920)*0.5',{N}")
    ff("-loop", "1", "-framerate", "30", "-t", f"{d:.3f}", "-i", src, "-vf", vf, *ENC, f"{S}/{name}.mp4")


def clip(src, name):
    """A clip, muted, filling the frame (cropped, never stretched), holding its last frame."""
    if FIT == "whole":
        fc = (f"[0:v]tpad=stop_mode=clone:stop_duration=30,split[a][b];[a]{BACKDROP}[bg];"
              f"[b]scale=1080:-2:flags=lanczos[fg];[bg][fg]overlay=x='(W-w)/2':y='(H-h)/2',{N}[v]")
        return ff("-i", src, "-filter_complex", fc, "-map", "[v]", "-t", f"{L[name]:.3f}", *ENC, f"{S}/{name}.mp4")
    ff("-i", src, "-vf", f"tpad=stop_mode=clone:stop_duration=30,"
       f"scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,{N}",
       "-t", f"{L[name]:.3f}", *ENC, f"{S}/{name}.mp4")


for i, seg in enumerate(M["segments"]):
    if seg.get("clip"):
        clip(seg["clip"], SEG[i])
    else:
        still(seg["image"], SEG[i], i)


# ---------------------------------------------------------------- text as PNG
def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=font) <= maxw or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def caption_png(text, path, size=74, maxw=840, stroke=7):
    font = ImageFont.truetype(FONT, size)
    img = Image.new("RGBA", (W, HT), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lines = wrap(d, text, font, maxw)
    lh = int(size * 1.28)
    y = 1800 - lh * len(lines)         # captions sit at the bottom of frame (house style)
    cx = 80 + maxw / 2                 # left margin 80, right margin 160: away from Instagram's icons
    for ln in lines:
        d.text((cx, y), ln, font=font, fill=(255, 255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0, 255), anchor="ma")
        y += lh
    img.save(path)


caps = []
for i, (k, at, sp, end) in enumerate(place):
    if V[k][3] and M.get("captions", True):
        p = f"{S}/cap{i:02d}.png"
        caption_png(V[k][3], p)
        caps.append((p, max(0, sp - 0.05), end + 0.3))

# end card over the darkened last frame: the hook, wrapped, then the series title
ff("-sseof", "-0.15", "-i", f"{S}/{SEG[-2]}.mp4", "-frames:v", "1", f"{S}/last.png")
card = Image.new("RGBA", (W, HT), (0, 0, 0, 0))
dc = ImageDraw.Draw(card)
f1, f3 = ImageFont.truetype(FONT, 76), ImageFont.truetype(FONT, 52)
lines = wrap(dc, M.get("hook") or "", f1, 900)
# A long hook starts higher, and the title always sits under its last line (a six-line hook ran over it, Oct 26).
y = min(HT * 0.36, HT * 0.5 - len(lines) * 76 * 1.25 / 2)
for ln in lines:
    dc.text((W / 2, y), ln, font=f1, fill=(255, 201, 60, 255), stroke_width=6, stroke_fill=(0, 0, 0, 255), anchor="ma")
    y += 76 * 1.25
if M.get("title"):
    dc.text((W / 2, max(HT * 0.625, y + 48)), M["title"], font=f3, fill=(255, 255, 255, 255), stroke_width=6, stroke_fill=(0, 0, 0, 255), anchor="ma")
card.save(f"{S}/card.png")
ff("-loop", "1", "-framerate", "30", "-t", f"{L['end']:.3f}", "-i", f"{S}/last.png", "-i", f"{S}/card.png",
   "-filter_complex", f"[0:v]eq=brightness=-0.38:saturation=0.55[bg];[bg][1:v]overlay=0:0,{N}[v]",
   "-map", "[v]", *ENC, f"{S}/end.mp4")

# ---------------------------------------------------------------- video chain
inp, fc, prev = [], [], "0:v"
for n in SEG:
    inp += ["-i", f"{S}/{n}.mp4"]
for i in range(1, len(SEG)):
    fc.append(f"[{prev}][{i}:v]xfade=transition=fade:duration={X}:offset={start[SEG[i]] - H:.3f}[x{i}]")
    prev = f"x{i}"
for j, (p, a, b) in enumerate(caps):
    inp += ["-i", p]
    fc.append(f"[{prev}][{len(SEG) + j}:v]overlay=0:0:enable='between(t,{a:.2f},{b:.2f})'[o{j}]")
    prev = f"o{j}"
fc.append(f"[{prev}]fade=in:st=0:d=1.0,fade=out:st={TOTAL - 1.5:.2f}:d=1.5[v]")
ff(*inp, "-filter_complex", ";".join(fc), "-map", "[v]", *ENC, f"{S}/video.mp4")

# ---------------------------------------------------------------- audio: voices over ducked music
vin, af = [], []
for i, (k, at, sp, end) in enumerate(place):
    vin += ["-i", V[k][0]]
    ms = max(0, int(at * 1000))
    af.append(f"[{i}]adelay={ms}|{ms}[a{i}]")
nv = len(place)
if nv:
    af.append("".join(f"[a{i}]" for i in range(nv)) + f"amix=inputs={nv}:normalize=0,apad,atrim=0:{TOTAL:.3f}[voice]")
else:
    vin += ["-f", "lavfi", "-t", f"{TOTAL:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
    af.append(f"[0]atrim=0:{TOTAL:.3f}[voice]")
    nv = 1

music = M.get("music") or {}
sections, cue = [], None
for i, seg in enumerate(M["segments"]):
    cue = seg.get("music") or cue or (next(iter(music)) if music else None)
    if cue not in music:
        continue
    n = SEG[i]
    if sections and sections[-1][0] == cue and abs(sections[-1][2] - start[n]) < 1e-6:
        sections[-1][2] = start[n] + segdur[n]
    else:
        sections.append([cue, start[n], start[n] + segdur[n]])
if sections:
    sections[-1][2] += segdur["end"]  # the last cue plays under the end card
mix = []
for j, (c, a, b) in enumerate(sections):
    idx = nv + j
    vin += ["-stream_loop", "-1", "-i", music[c]]
    s0 = max(0, a - 0.6)
    ln = (b + 0.6) - s0
    fin = 2.0 if j == 0 else 1.2
    af.append(f"[{idx}]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{ln:.3f},volume={M.get('music_gain_db', -9.5)}dB,"
              f"afade=t=in:d={fin},afade=t=out:st={ln - 1.2:.3f}:d=1.2,adelay={int(s0 * 1000)}|{int(s0 * 1000)}[m{j}]")
    mix.append(f"[m{j}]")
if mix:
    af.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0,apad,atrim=0:{TOTAL:.3f}[bed]")
    af.append("[voice]asplit=2[sc][vo]")
    af.append("[bed][sc]sidechaincompress=threshold=0.015:ratio=10:attack=25:release=600[duck]")
    af.append(f"[duck][vo]amix=inputs=2:normalize=0,alimiter=limit=0.95,atrim=0:{TOTAL:.3f},afade=t=out:st={TOTAL - 2:.2f}:d=2[aout]")
else:
    af.append(f"[voice]alimiter=limit=0.95,atrim=0:{TOTAL:.3f},afade=t=out:st={TOTAL - 2:.2f}:d=2[aout]")
ff(*vin, "-i", f"{S}/video.mp4", "-filter_complex", ";".join(af), "-map", f"{nv + len(sections)}:v", "-map", "[aout]",
   "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", M["out"])

# ---------------------------------------------------------------- instagram copy, under max_mb
target_kbps = int(M.get("max_mb", 30) * 8000 * 0.92 / TOTAL) - 160
vk = max(600, min(2400, target_kbps))
ff("-i", M["out"], "-c:v", "libx264", "-preset", "slow", "-b:v", f"{vk}k", "-maxrate", f"{int(vk * 1.25)}k",
   "-bufsize", f"{vk * 2}k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", M["out_ig"])

print(json.dumps({"seconds": round(dur(M["out_ig"]), 2), "mb": round(os.path.getsize(M["out_ig"]) / 1e6, 2),
                  "sections": [[c, round(a, 1), round(b, 1)] for c, a, b in sections]}))
