/**
 * A step's declared outputs (`out: { shots: list<shot>, hook: text }`) as a
 * JSON Schema, so a model's answer is checked against the recipe. Strict:
 * every field required, no extra fields. A `library.<kind>` field is one of the
 * names that kind has in the Library, so a model can't invent a place.
 */
import { libraryKind, type Graph } from "@kriya/engine";

type Schema = Record<string, unknown>;

const MEDIA = new Set(["image", "audio", "video", "file"]);

/** The names one kind has in the Library ("place" → ["Mitra's chai stall", "Reservoir"]). */
export type LibraryNames = (kind: string) => string[];

export function fieldsSchema(fields: Record<string, string>, types: Graph["types"], names?: LibraryNames): Schema {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, typeSchema(type, types, names)])),
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

function typeSchema(type: string, types: Graph["types"], names?: LibraryNames): Schema {
  const list = /^list<(.+)>$/.exec(type);
  if (list) return { type: "array", items: typeSchema(list[1]!, types, names) };
  const kind = libraryKind(type);
  if (kind) {
    const known = names?.(kind) ?? [];
    if (known.length === 0) throw new Error(`the Library has no ${kind} for this step to choose from; add one to library/ (kind: ${kind})`);
    return { type: "string", enum: known, description: `a ${kind} from the Library, named exactly` };
  }
  const named = types[type];
  if (named) return fieldsSchema(named.fields, types, names);
  switch (type) {
    case "text": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "json": return { type: "string", description: "JSON text" };
    default:
      if (MEDIA.has(type)) return { type: "string", description: `a reference to a ${type}` };
      throw new Error(`there's no type '${type}' to describe to the model`);
  }
}
