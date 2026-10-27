/**
 * The Library on disk (Day 18): `library/` at the project root, one YAML file
 * per entity (a character, a place, a music track…), each facet a key:
 *
 *   name: Mitra
 *   kind: character
 *   look:  { image: sheets/mitra-sheet.png, words: a thin 60-year-old bald man… }
 *   voice: { voice: Charon, words: calm and dry }
 *   speech: Hinglish; calls everyone beta
 *
 * A facet is words, a file in the project (a sheet, a voice sample, a track),
 * or an object holding either. Its version hashes the value with every file
 * replaced by its bytes' hash, so redrawing a sheet in place, or changing a
 * voice, is a new version. Every version is kept in `.kriya` (history and
 * files), numbered v1, v2… in the order kriya first saw it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { suggest, type Assets } from "@kriya/engine";
import type { Store } from "@kriya/store";

/** Files a facet can name. */
export const MEDIA = /\.(png|jpe?g|webp|gif|wav|mp3|m4a|ogg|flac|mp4|mov)$/i;
const FACET = /^[a-z][a-z0-9_]*$/;

export type Entity = { name: string; kind?: string; file: string; facets: Record<string, unknown> };
export type Library = { entities: Map<string, Entity>; problems: string[] };

/** Reads `library/*.yaml`. `kinds` (from kriya.yaml) names each kind's facets; without it, any facet goes. */
export function loadLibrary(root: string, kinds: Record<string, string[]>): Library {
  const dir = join(root, "library");
  const entities = new Map<string, Entity>();
  const problems: string[] = [];
  if (!existsSync(dir)) return { entities, problems };
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const file = `library/${f}`;
    let raw: unknown;
    try {
      raw = parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      problems.push(`${file}: isn't valid YAML (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${file}: should be the entity's name, kind and facets, e.g. name: Mitra`);
      continue;
    }
    const { name, kind, ...facets } = raw as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) {
      problems.push(`${file}: needs a name, e.g. name: Mitra (the name recipes use, like item.speaker)`);
      continue;
    }
    const other = entities.get(name);
    if (other) {
      problems.push(`${file}: '${name}' is already in ${other.file}; each entity has one file`);
      continue;
    }
    if (kind !== undefined && typeof kind !== "string") problems.push(`${file}: kind should be a word, e.g. kind: character`);
    const known = typeof kind === "string" ? kinds[kind] : undefined;
    if (typeof kind === "string" && Object.keys(kinds).length && !known) {
      problems.push(`${file}: there's no kind '${kind}'${suggest(kind, Object.keys(kinds))} Kinds: ${Object.keys(kinds).join(", ")} (kinds: in kriya.yaml)`);
    }
    for (const facet of Object.keys(facets)) {
      if (!FACET.test(facet)) problems.push(`${file}: '${facet}' isn't a facet name; use lower_snake_case like look or voice`);
      else if (known && !known.includes(facet)) problems.push(`${file}: a ${kind} has no '${facet}'${suggest(facet, known)} A ${kind} has: ${known.join(", ")}`);
    }
    entities.set(name, { name, ...(typeof kind === "string" ? { kind } : {}), file, facets });
  }
  return { entities, problems };
}

/** A facet's version and the files it names, or `missing` for files that aren't in the project. */
type Resolved = { version: string; files: { path: string; hash: string }[] } | { missing: string[] };

/**
 * The Library as the engine sees it: the current version of each facet, and a
 * fake one for anything missing in fake mode. A facet naming a file that isn't
 * there counts as missing: the step waits for it instead of drawing a stranger.
 * The first time a version is seen it's kept: history in the database, files
 * in the blob store.
 */
export function libraryAssets(library: Library, root: string, store: Store | undefined, fake: boolean): Assets & { resolve(entity: string, facet: string): Resolved | undefined } {
  /** File hashes by path, size and modified time: a run with many shots doesn't rehash the same sheet. */
  const hashes = new Map<string, string>();
  const resolved = new Map<string, Resolved>();
  const fileHash = (file: string) => {
    const st = statSync(file);
    const k = `${file}|${st.size}|${st.mtimeMs}`;
    let h = hashes.get(k);
    if (!h) {
      const bytes = readFileSync(file);
      hashes.set(k, (h = createHash("sha256").update(bytes).digest("hex")));
      store?.blobs.put(bytes); // the version's file, kept even if the sheet is redrawn later
    }
    return h;
  };

  const resolveFacet = (entity: string, facet: string): Resolved | undefined => {
    const e = library.entities.get(entity);
    if (!e || !(facet in e.facets)) return undefined;
    const key = `${entity}.${facet}`;
    let r = resolved.get(key);
    if (r) return r;
    const files: { path: string; hash: string }[] = [];
    const missing: string[] = [];
    const swap = (v: unknown): unknown => {
      if (typeof v === "string" && MEDIA.test(v)) {
        const file = resolve(root, v);
        if (!file.startsWith(root + "/") || !existsSync(file)) {
          missing.push(v);
          return v;
        }
        const hash = fileHash(file);
        files.push({ path: relative(root, file), hash });
        return `sha256:${hash}`;
      }
      if (Array.isArray(v)) return v.map(swap);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, swap(x)]));
      return v;
    };
    const canonical = JSON.stringify(swap(e.facets[facet]) ?? null);
    r = missing.length ? { missing } : { version: createHash("sha256").update(canonical).digest("hex").slice(0, 12), files };
    if ("version" in r) store?.library.record(entity, facet, r.version, e.facets[facet]);
    resolved.set(key, r);
    return r;
  };

  return {
    resolve: resolveFacet,
    facet(entity, facet) {
      const r = resolveFacet(entity, facet);
      if (!r || "missing" in r) return fake ? { version: "fake", value: library.entities.get(entity)?.facets[facet] ?? `fake:${entity}.${facet}` } : undefined;
      return { version: r.version, value: library.entities.get(entity)!.facets[facet] };
    },
  };
}
