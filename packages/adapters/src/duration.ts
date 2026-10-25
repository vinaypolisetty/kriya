/**
 * How long a clip or a voice line is, read from its own bytes: WAV (the TTS
 * and music models) and MP4 (the clip models). Recipes route on it
 * (`result.seconds > 8`), so it's measured, never taken from the request.
 */

/** Seconds, to the hundredth, or undefined if the format isn't one kriya reads. */
export function durationOf(b: Uint8Array): number | undefined {
  const s = wav(b) ?? mp4(b);
  return s === undefined || !Number.isFinite(s) ? undefined : Math.round(s * 100) / 100;
}

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

function wav(b: Uint8Array): number | undefined {
  if (b.length < 12 || tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE") return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let byteRate: number | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const size = v.getUint32(at + 4, true);
    if (tag(b, at) === "fmt " && at + 16 <= b.length) byteRate = v.getUint32(at + 16, true);
    // A streamed WAV may say 0 or 0xFFFFFFFF for its data size: the data then runs to the end.
    if (tag(b, at) === "data") return byteRate ? Math.min(size, b.length - at - 8) / byteRate : undefined;
    at += 8 + size + (size % 2);
  }
  return undefined;
}

function mp4(b: Uint8Array): number | undefined {
  if (b.length < 12 || tag(b, 4) !== "ftyp") return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  /** The boxes between `from` and `to`, as [type, body start, end]. */
  const boxes = function* (from: number, to: number): Generator<[string, number, number]> {
    for (let at = from; at + 8 <= to; ) {
      let size = v.getUint32(at);
      let head = 8;
      if (size === 1) {
        size = Number(v.getBigUint64(at + 8));
        head = 16;
      } else if (size === 0) size = to - at;
      if (size < head) return;
      yield [tag(b, at + 4), at + head, Math.min(at + size, to)];
      at += size;
    }
  };
  for (const [type, start, end] of boxes(0, b.length)) {
    if (type !== "moov") continue;
    for (const [inner, body] of boxes(start, end)) {
      if (inner !== "mvhd") continue;
      return v.getUint8(body) === 1
        ? Number(v.getBigUint64(body + 24)) / v.getUint32(body + 20)
        : v.getUint32(body + 16) / v.getUint32(body + 12);
    }
  }
  return undefined;
}
