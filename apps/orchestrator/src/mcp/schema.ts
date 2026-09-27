/**
 * MCP tools describe their arguments in full JSON Schema; Gemini function declarations accept only a subset and reject
 * the whole request on any unknown keyword. Because every tool of an agent is sent on every model call, one bad schema
 * would break the agent, so schemas are rewritten to the accepted subset and tools that cannot be rewritten are
 * skipped (and listed in the status panel).
 *
 * Probed against the Gemini API (2026-09-22): accepted `anyOf`/`oneOf`/`allOf`, `format`, `default`, empty and
 * free-form objects; rejected `$defs`/`$ref`, `const`, `exclusiveMinimum`, `examples`, `not` and non-string `enum`.
 */

type Json = Record<string, unknown>;

export type SchemaResult = { ok: true; schema: Json } | { ok: false; reason: string };

class Unsupported extends Error {}

/** Keys Gemini's function-declaration Schema understands. Everything else is dropped. */
const KEEP = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "anyOf",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "default",
]);
const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const MAX_DEPTH = 16;
const MAX_DESCRIPTION = 1_000;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

type Context = { defs: Json; refStack: string[]; depth: number; path: string };

function withNote(node: Json, note: string): void {
  const base = typeof node.description === "string" ? node.description : "";
  node.description = base ? `${base} (${note})` : note;
}

function resolveRef(ref: string, ctx: Context): Json {
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) throw new Unsupported(`unsupported $ref "${ref}" at ${ctx.path || "root"}`);
  if (ctx.refStack.includes(ref)) throw new Unsupported(`recursive $ref "${ref}"`);
  const target = ctx.defs[decodeURIComponent(match[2]!)];
  if (!isObject(target)) throw new Unsupported(`$ref "${ref}" points nowhere`);
  return target;
}

function mergeAllOf(parts: unknown[], ctx: Context): Json {
  const merged: Json = {};
  for (const part of parts) {
    if (!isObject(part)) continue;
    const node = typeof part.$ref === "string" ? resolveRef(part.$ref, ctx) : part;
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isObject(value)) merged.properties = { ...(isObject(merged.properties) ? merged.properties : {}), ...value };
      else if (key === "required" && Array.isArray(value)) merged.required = [...new Set([...(Array.isArray(merged.required) ? merged.required : []), ...value])];
      else if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

function convert(input: unknown, ctx: Context): Json {
  if (ctx.depth > MAX_DEPTH) throw new Unsupported("schema is nested too deeply");
  if (input === true || (isObject(input) && Object.keys(input).length === 0)) return { type: "string", description: "Any value, as text." };
  if (!isObject(input)) throw new Unsupported(`invalid schema at ${ctx.path || "root"}`);

  let node: Json = input;
  let refStack = ctx.refStack;
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const target = resolveRef(ref, ctx);
    const { $ref: _ignored, ...siblings } = node;
    node = { ...target, ...siblings };
    refStack = [...refStack, ref];
  }
  if (Array.isArray(node.allOf)) {
    const { allOf, ...rest } = node;
    node = { ...mergeAllOf(allOf, { ...ctx, refStack }), ...rest };
  }
  const child = (value: unknown, segment: string): Json => convert(value, { ...ctx, refStack, depth: ctx.depth + 1, path: `${ctx.path}${segment}` });

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) if (KEEP.has(key)) out[key] = value;

  // Unions: oneOf behaves like anyOf for argument generation.
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
  if (union) {
    const variants = union.map((variant, index) => child(variant, `.anyOf[${index}]`));
    if (variants.length === 0) throw new Unsupported(`empty anyOf at ${ctx.path || "root"}`);
    out.anyOf = variants;
    delete out.type;
  }

  // Type arrays: [T, "null"] is left for the Google converter (it becomes nullable); wider unions become anyOf.
  if (Array.isArray(node.type)) {
    const types = node.type.filter((type): type is string => typeof type === "string" && TYPES.has(type));
    const nonNull = types.filter((type) => type !== "null");
    if (nonNull.length === 0) throw new Unsupported(`null-only type at ${ctx.path || "root"}`);
    if (nonNull.length === 1) out.type = types.includes("null") ? [nonNull[0], "null"] : nonNull[0];
    else {
      delete out.type;
      out.anyOf = [...nonNull.map((type) => ({ type })), ...(types.includes("null") ? [{ type: "null" }] : [])];
    }
  } else if (typeof node.type === "string" && !TYPES.has(node.type)) {
    throw new Unsupported(`unknown type "${node.type}" at ${ctx.path || "root"}`);
  }

  if ("const" in node) {
    if (typeof node.const === "string") out.enum = [node.const];
    else withNote(out, `must be ${JSON.stringify(node.const)}`);
  }
  if (Array.isArray(out.enum) && !out.enum.every((value) => typeof value === "string")) {
    withNote(out, `allowed values: ${out.enum.map((value) => JSON.stringify(value)).join(", ")}`);
    delete out.enum;
  }
  if (typeof node.exclusiveMinimum === "number") {
    out.minimum = node.exclusiveMinimum;
    withNote(out, `greater than ${node.exclusiveMinimum}`);
  }
  if (typeof node.exclusiveMaximum === "number") {
    out.maximum = node.exclusiveMaximum;
    withNote(out, `less than ${node.exclusiveMaximum}`);
  }
  if (typeof out.description === "string" && out.description.length > MAX_DESCRIPTION) out.description = `${out.description.slice(0, MAX_DESCRIPTION - 1)}…`;

  if (isObject(node.properties)) {
    const properties: Json = {};
    for (const [name, value] of Object.entries(node.properties)) properties[name] = child(value, `.${name}`);
    out.properties = properties;
    if (Array.isArray(node.required)) out.required = node.required.filter((name): name is string => typeof name === "string" && name in properties);
    if (out.type === undefined && !out.anyOf) out.type = "object";
  } else {
    delete out.required;
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) throw new Unsupported(`tuple arrays are not supported at ${ctx.path || "root"}`);
    out.items = child(node.items, "[]");
  } else if (out.type === "array") {
    out.items = { type: "string" };
  }
  return out;
}

export function toGeminiSchema(input: unknown): SchemaResult {
  // A missing or empty schema means "no arguments".
  const root = isObject(input) && Object.keys(input).length > 0 ? input : { type: "object", properties: {} };
  const defs = { ...(isObject(root.definitions) ? root.definitions : {}), ...(isObject(root.$defs) ? root.$defs : {}) };
  try {
    const schema = convert(root, { defs, refStack: [], depth: 0, path: "" });
    if (schema.type !== "object") return { ok: false, reason: "arguments must be an object" };
    if (!isObject(schema.properties)) schema.properties = {};
    return { ok: true, schema };
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message };
    throw error;
  }
}
