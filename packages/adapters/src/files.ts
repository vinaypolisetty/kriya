/** What kind of file some bytes are, from their first bytes: images, audio and video kriya handles. */
export function sniff(b: Uint8Array): string {
  const at = (i: number, s: string) => [...s].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (at(4, "ftyp")) return "video/mp4";
  if (at(0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (at(0, "OggS")) return "audio/ogg";
  if (at(0, "fLaC")) return "audio/flac";
  return "application/octet-stream";
}

/** The usual file extension for a type from `sniff`. */
export const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/flac": "flac", "video/mp4": "mp4",
};

/** A file's type from its extension, for media read from the project. */
export const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", mov: "video/quicktime",
};
