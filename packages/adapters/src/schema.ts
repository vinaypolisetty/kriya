/**
 * A step's declared outputs (`out: { shots: list<shot>, hook: text }`) as a
 * JSON Schema, so a model's answer is checked against the recipe. Strict:
 * every field required, no extra fields.
 */
import type { Graph } from "@kriya/engine";

type Schema = Record<string, unknown>;

const MEDIA = new Set(["image", "audio", "video", "file"]);

export function fieldsSchema(fields: Record<string, string>, types: Graph["types"]): Schema {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, typeSchema(type, types)])),
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

function typeSchema(type: string, types: Graph["types"]): Schema {
  const list = /^list<(.+)>$/.exec(type);
  if (list) return { type: "array", items: typeSchema(list[1]!, types) };
  const named = types[type];
  if (named) return fieldsSchema(named.fields, types);
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
