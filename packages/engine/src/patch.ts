/**
 * Patching a version by key (D-89): a new version of a step made from an
 * existing one plus a few edits, by item, never by asking a model to write the
 * whole thing again. "Add a shot after P3-05" adds one item; the other twelve
 * are copied as they are, so their hashes don't move and their work is kept
 * (D-35, D-45).
 *
 * Pure: an output and a list of edits in, the new output and one plain line per
 * edit out. Every edit is checked against the step's declared `out` types, so a
 * patch can't produce what the recipe wouldn't accept from a model. Items are
 * found by their key (the for-each step's `key`, `id` by default); a key is an
 * item's identity, so it's never edited in place: add a new item and remove the
 * old one (rule 4).
 */
import { z } from "zod";
import { libraryKind, type Graph } from "./spec.js";
import { suggest } from "./validate.js";

const Place = { after: z.string().min(1).optional(), before: z.string().min(1).optional() };

/** One edit to a version's output. `field` is one of the step's `out` fields. */
export const Edit = z.discriminatedUnion("op", [
  /** A new item in a list, after or before an existing one (the end if neither). */
  z.object({ op: z.literal("add"), field: z.string().min(1), item: z.unknown(), ...Place }).strict(),
  /** Some fields of one item, the rest kept. */
  z.object({ op: z.literal("update"), field: z.string().min(1), key: z.string().min(1), set: z.record(z.unknown()) }).strict(),
  z.object({ op: z.literal("remove"), field: z.string().min(1), key: z.string().min(1) }).strict(),
  /** One item to another place in its list. */
  z.object({ op: z.literal("move"), field: z.string().min(1), key: z.string().min(1), ...Place }).strict(),
  /** A field that isn't a list (a hook, a title), set whole. */
  z.object({ op: z.literal("set"), field: z.string().min(1), value: z.unknown() }).strict(),
]);
export type Edit = z.infer<typeof Edit>;

export type PatchShape = {
  /** The step's declared outputs: field → type. */
  out: Record<string, string>;
  /** The recipe's declared types, for list items. */
  types: Graph["types"];
  /** The field an item of this list is known by (`id`, or a for-each step's `key`). */
  keyOf: (field: string) => string;
  /** The names a Library kind has, when known, so `library.place` fields name real places. */
  names?: (kind: string) => string[];
};

/** Item keys follow the for-each rule (D-41): letters, digits, - and _. */
const ITEM_KEY = /^[A-Za-z0-9_-]+$/;

/** Applies the edits in order. Returns the new output and what each edit did, in words. Throws a plain message on the first edit that doesn't fit. */
export function applyEdits(output: Record<string, unknown>, edits: Edit[], shape: PatchShape): { output: Record<string, unknown>; did: string[] } {
  if (edits.length === 0) throw new Error("say what to change: a patch needs at least one edit");
  const next: Record<string, unknown> = { ...output };
  const did = edits.map((e, i) => {
    try {
      return applyOne(next, e, shape);
    } catch (err) {
      throw new Error(`edit ${i + 1} (${e.op} ${e.field}): ${(err as Error).message}`);
    }
  });
  return { output: next, did };
}

function applyOne(out: Record<string, unknown>, e: Edit, shape: PatchShape): string {
  const type = shape.out[e.field];
  if (!type) throw new Error(`this step makes no '${e.field}'${suggest(e.field, Object.keys(shape.out)) || `; it makes ${Object.keys(shape.out).join(", ")}`}`);
  const inner = /^list<(.+)>$/.exec(type)?.[1];
  if (e.op === "set") {
    if (inner) throw new Error(`'${e.field}' is a list; add, update, remove or move its items instead`);
    fits(e.value, type, shape, e.field);
    out[e.field] = e.value;
    return `set ${e.field}`;
  }
  if (!inner) throw new Error(`'${e.field}' isn't a list; set it whole instead`);
  const list = out[e.field];
  if (!Array.isArray(list)) throw new Error(`the version has no list in '${e.field}' to change`);
  const keyField = shape.keyOf(e.field);
  const keys = list.map((x) => keyOf(x, keyField));
  const at = (k: string) => {
    const i = keys.indexOf(k);
    if (i < 0) throw new Error(`there's no '${k}' in ${e.field}${suggest(k, keys.filter((x): x is string => x !== undefined)) || ""}`);
    return i;
  };
  const place = (p: { after?: string | undefined; before?: string | undefined }, without: number) => {
    if (p.after && p.before) throw new Error("say after or before, not both");
    const rest = keys.filter((_, i) => i !== without);
    const find = (k: string) => {
      const i = rest.indexOf(k);
      if (i < 0) throw new Error(`there's no '${k}' in ${e.field} to put it next to${suggest(k, rest.filter((x): x is string => x !== undefined)) || ""}`);
      return i;
    };
    return p.after ? find(p.after) + 1 : p.before ? find(p.before) : rest.length;
  };
  const items = [...list];
  switch (e.op) {
    case "add": {
      fits(e.item, inner, shape, `the new ${e.field} item`);
      const k = keyOf(e.item, keyField);
      if (k === undefined) throw new Error(`the new item needs a '${keyField}'`);
      if (!ITEM_KEY.test(k)) throw new Error(`'${k}' can only use letters, digits, - and _`);
      if (keys.includes(k)) throw new Error(`${e.field} already has '${k}'; give the new item its own ${keyField}`);
      items.splice(place(e, -1), 0, e.item);
      out[e.field] = items;
      return `added ${k}${e.after ? ` after ${e.after}` : e.before ? ` before ${e.before}` : ""}`;
    }
    case "update": {
      const i = at(e.key);
      const item = items[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`'${e.key}' is a plain value; remove it and add the new one`);
      const fields = shape.types[inner]?.fields ?? {};
      const names = Object.keys(e.set);
      if (names.length === 0) throw new Error(`say which fields of '${e.key}' to change`);
      for (const f of names) {
        if (f === keyField) throw new Error(`'${keyField}' is what ${e.key} is known by and stays as it is; to rename it, add a new item and remove this one`);
        const t = fields[f];
        if (!t) throw new Error(`a ${inner} has no '${f}'${suggest(f, Object.keys(fields)) || ""}`);
        fits(e.set[f], t, shape, `${e.key}'s ${f}`);
      }
      items[i] = { ...(item as Record<string, unknown>), ...e.set };
      out[e.field] = items;
      return `changed ${e.key}'s ${names.join(", ")}`;
    }
    case "remove": {
      items.splice(at(e.key), 1);
      out[e.field] = items;
      return `removed ${e.key}`;
    }
    case "move": {
      const i = at(e.key);
      const [item] = items.splice(i, 1);
      items.splice(place(e, i), 0, item);
      out[e.field] = items;
      return `moved ${e.key}${e.after ? ` after ${e.after}` : e.before ? ` before ${e.before}` : " to the end"}`;
    }
  }
}

/** An item's key: its key field, or the item itself in a list of plain names (D-74). */
function keyOf(item: unknown, field: string): string | undefined {
  if (typeof item === "string" || typeof item === "number") return String(item);
  const k = item && typeof item === "object" ? (item as Record<string, unknown>)[field] : undefined;
  return typeof k === "string" || typeof k === "number" ? String(k) : undefined;
}

/** Throws a plain message if a value isn't what its declared type allows. */
function fits(value: unknown, type: string, shape: PatchShape, where: string): void {
  const list = /^list<(.+)>$/.exec(type);
  if (list) {
    if (!Array.isArray(value)) throw new Error(`${where} should be a list`);
    value.forEach((v, i) => fits(v, list[1]!, shape, `${where} ${i + 1}`));
    return;
  }
  const kind = libraryKind(type);
  if (kind) {
    if (typeof value !== "string") throw new Error(`${where} should name a ${kind} from the Library`);
    const known = shape.names?.(kind);
    if (known?.length && !known.includes(value)) throw new Error(`the Library has no ${kind} '${value}'${suggest(value, known) || `; it has ${known.join(", ")}`}`);
    return;
  }
  const named = shape.types[type];
  if (named) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} should be a ${type} (${Object.keys(named.fields).join(", ")})`);
    const v = value as Record<string, unknown>;
    for (const f of Object.keys(v)) if (!named.fields[f]) throw new Error(`a ${type} has no '${f}'${suggest(f, Object.keys(named.fields)) || ""}`);
    for (const [f, t] of Object.entries(named.fields)) {
      if (!(f in v)) throw new Error(`${where} is missing '${f}'`);
      fits(v[f], t, shape, `${where}'s ${f}`);
    }
    return;
  }
  const ok = type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "boolean" ? typeof value === "boolean" : typeof value === "string";
  if (!ok) throw new Error(`${where} should be ${type === "number" ? "a number" : type === "boolean" ? "true or false" : type === "text" ? "text" : `a ${type}`}`);
}
