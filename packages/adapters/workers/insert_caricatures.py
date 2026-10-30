"""kriya's insert_caricatures worker: cut caricatures into a video at their moments.

The video plays up to each moment, then cuts away and comes back where it left off.
Each cut has a layout:

  * group      one caricature, full screen, a slow push in, for `hold` seconds
  * one_each   one caricature after another, full screen, `hold` seconds each
  * over_frame the frame at the moment, frozen, with each caricature popped over
               where its subject stands (white background keyed out), `hold` seconds

The caption goes along the bottom of the cut (the last card for one_each).
A cut with a flipbook then plays its drawings in order, full screen, `beat` seconds each, with no caption.
The video's sound pauses during a cut, so the result is longer by every cut's length.

Usage: python insert_caricatures.py manifest.json   (prints one JSON line: the result)
Needs ffmpeg and ffprobe on PATH, and Pillow.
"""
import json
import os
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    print(json.dumps({"error": "this Python has no Pillow (pip install pillow); set tools.python in kriya.yaml to one that has it"}))
    sys.exit(2)

M = json.load(open(sys.argv[1]))
S = M["build"]
HOLD = float(M["hold"])
BEAT = float(M.get("beat", 0.5))
POP = 0.15         # gap between caricatures popping in over the frame
PUSH = 0.08        # how far a full-screen caricature zooms in over its hold


def ff(*a):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *a], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(json.dumps({"error": f"ffmpeg failed: {r.stderr.strip()[-300:]}"}))


def probe(f):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
                          "-of", "json", f], capture_output=True, text=True).stdout
    j = json.loads(out)
    v = next((s for s in j["streams"] if s["codec_type"] == "video"), None)
    if not v:
        raise SystemExit(json.dumps({"error": "the video has no picture to cut into"}))
    n, d = v["r_frame_rate"].split("/")
    fps = round(float(n) / float(d or 1)) or 30
    return v["width"], v["height"], min(fps, 60), any(s["codec_type"] == "audio" for s in j["streams"]), float(j["format"]["duration"])


W, H, FPS, SOUND, LENGTH = probe(M["video"])
W, H = W - W % 2, H - H % 2
ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS)]
AUD = ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]


def font(size):
    if M["font"]:
        return ImageFont.truetype(M["font"], size)
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow before 10.1
        return ImageFont.load_default()


def caption(img, text):
    """The caption in white with a black outline, wrapped, along the bottom."""
    if not text:
        return img
    d = ImageDraw.Draw(img)
    size = max(18, H // 14)
    f = font(size)
    words, lines, line = text.split(), [], ""
    for w in words:
        trial = f"{line} {w}".strip()
        if d.textlength(trial, font=f) > W * 0.9 and line:
            lines.append(line)
            line = w
        else:
            line = trial
    lines.append(line)
    y = H - int(size * 1.3) * len(lines) - H // 20
    for ln in lines:
        x = (W - d.textlength(ln, font=f)) / 2
        d.text((x, y), ln, font=f, fill="white", stroke_width=max(2, size // 12), stroke_fill="black")
        y += int(size * 1.3)
    return img


def fit(img, w, h):
    """The image scaled to fit inside w x h, keeping its shape."""
    r = min(w / img.width, h / img.height)
    return img.resize((max(1, int(img.width * r)), max(1, int(img.height * r))), Image.LANCZOS)


def card(path, backdrop):
    """A caricature full screen, over a blurred, darkened copy of the frame."""
    bg = backdrop.copy().filter(ImageFilter.GaussianBlur(radius=max(W, H) // 40))
    bg = Image.blend(bg, Image.new("RGB", bg.size, "black"), 0.45)
    k = fit(Image.open(path).convert("RGB"), int(W * 0.94), int(H * 0.82))
    bg.paste(k, ((W - k.width) // 2, (H - k.height) // 2 - H // 30))
    return bg


def cutout(path):
    """A caricature drawn on white, with the white made see-through."""
    img = Image.open(path).convert("RGBA")
    mask = img.convert("L").point(lambda p: 0 if p > 235 else 255)
    img.putalpha(mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1)))
    return img


def clip_of_still(img, seconds, name, push=False):
    """A still as a clip of `seconds`, at the video's size and rate, silent if the video has sound."""
    png = f"{S}/{name}.png"
    img.save(png)
    out = f"{S}/{name}.mp4"
    frames = max(1, round(seconds * FPS))
    vf = (f"scale={W * 2}:{H * 2},zoompan=z='1+{PUSH}*on/{frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={frames}:s={W}x{H}:fps={FPS}"
          if push else f"scale={W}:{H},fps={FPS}")
    args = ["-loop", "1", "-framerate", str(FPS), "-i", png]
    if SOUND:
        args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    ff(*args, "-t", f"{seconds:.3f}", "-vf", f"{vf},setsar=1,format=yuv420p", *ENC, *(AUD if SOUND else []), "-shortest", out)
    return out


def piece(start, end, name):
    """The video from start to end, encoded like every other piece so they join without a re-encode."""
    out = f"{S}/{name}.mp4"
    ff("-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", M["video"], "-vf", f"scale={W}:{H},fps={FPS},setsar=1,format=yuv420p",
       *ENC, *(AUD if SOUND else ["-an"]), out)
    return out


def frame_at(t):
    png = f"{S}/frame_{t:.3f}.png"
    ff("-ss", f"{min(t, max(0, LENGTH - 0.05)):.3f}", "-i", M["video"], "-frames:v", "1", "-vf", f"scale={W}:{H}", png)
    return Image.open(png).convert("RGB")


def cut(i, c):
    """The clips for one cutaway."""
    frame = frame_at(c["t"])
    if c["layout"] == "over_frame":
        out, shown = [], frame.copy()
        for j, (path, box) in enumerate(zip(c["images"], c["boxes"])):
            k = cutout(path)
            if box:  # x, y, w, h as fractions of the frame: grow it a bit, the caricature's head is bigger
                bx, by, bw, bh = box["x"] * W, box["y"] * H, box["w"] * W * 1.3, box["h"] * H * 1.3
            else:    # no box: side by side along the bottom
                n = len(c["images"])
                bx, by, bw, bh = W * j / n, H * 0.35, W / n, H * 0.6
            k = fit(k, int(max(bw, W * 0.15)), int(max(bh, H * 0.25)))
            cx, cy = bx + box["w"] * W / 2 if box else bx + bw / 2, by + box["h"] * H / 2 if box else by + bh / 2
            shown.paste(k, (int(cx - k.width / 2), int(cy - k.height / 2)), k)
            last = j == len(c["images"]) - 1
            seconds = HOLD - POP * j if last else POP
            out.append(clip_of_still(caption(shown.copy(), c["caption"]) if last else shown.copy(), seconds, f"c{i}_{j}"))
        return out
    images = c["images"] if c["layout"] == "one_each" else c["images"][:1]
    return [clip_of_still(caption(card(p, frame), c["caption"]) if j == len(images) - 1 else card(p, frame), HOLD, f"c{i}_{j}", push=True)
            for j, p in enumerate(images)]


def flipbook(i, c):
    """The clips for one cut's flipbook, after its caricature."""
    frame = frame_at(c["t"])
    return [clip_of_still(card(p, frame), BEAT, f"book{i}_{j}") for j, p in enumerate(c.get("flipbook", []))]


cuts = sorted(M["cuts"], key=lambda c: c["t"])
parts, at = [], 0.0
for i, c in enumerate(cuts):
    t = min(max(c["t"], 0.0), LENGTH)
    if t - at > 1 / FPS:
        parts.append(piece(at, t, f"p{i}"))
    parts += cut(i, c) + flipbook(i, c)
    at = t
if LENGTH - at > 1 / FPS:
    parts.append(piece(at, LENGTH, "p_end"))

with open(f"{S}/parts.txt", "w") as f:
    f.writelines(f"file '{p}'\n" for p in parts)
ff("-f", "concat", "-safe", "0", "-i", f"{S}/parts.txt", "-c", "copy", "-movflags", "+faststart", M["out"])

seconds = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", M["out"]],
                               capture_output=True, text=True).stdout)
print(json.dumps({"seconds": round(seconds, 2), "mb": round(os.path.getsize(M["out"]) / 1e6, 2)}))
