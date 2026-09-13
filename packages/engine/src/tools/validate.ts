import type { JSONSchema7, JSONSchemaType } from "./definitions";

// Dependency-free validator for the JSON Schema keywords the PayFirewall schemas use:
// type, properties, required, additionalProperties, items, anyOf, enum, const, pattern,
// minimum/maximum (with integer), minLength/maxLength. Returns the first failure with a JSON pointer.

export interface SchemaIssue { path: string; message: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const escapePointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

function typeMatches(t: JSONSchemaType, v: unknown): boolean {
  switch (t) {
    case "object": return isPlainObject(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
  }
}

const describeValue = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function validateSchema(schema: JSONSchema7, value: unknown, path = ""): SchemaIssue | null {
  const at = path || "/";
  const fail = (message: string, p = path): SchemaIssue => ({ path: p, message });

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) return fail(`${at} must be ${types.join(" or ")}, got ${describeValue(value)}`);
  }
  if (schema.const !== undefined && value !== schema.const) return fail(`${at} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value as never)) return fail(`${at} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);

  if (typeof value === "string") {
    // JSON Schema lengths count code points, not UTF-16 units.
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return fail(`${at} must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) return fail(`${at} must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) return fail(`${at} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return fail(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) return fail(`${at} must be <= ${schema.maximum}`);
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) return fail(`${key} is required`, `${path}/${escapePointer(key)}`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${escapePointer(key)}`;
      const propSchema = schema.properties?.[key];
      if (propSchema) {
        const issue = validateSchema(propSchema, child, childPath);
        if (issue) return issue;
      } else if (schema.additionalProperties === false) {
        return fail(`unexpected field ${key}`, childPath);
      } else if (isPlainObject(schema.additionalProperties)) {
        const issue = validateSchema(schema.additionalProperties, child, childPath);
        if (issue) return issue;
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const issue = validateSchema(schema.items, value[i], `${path}/${i}`);
      if (issue) return issue;
    }
  }

  if (schema.anyOf) {
    const issues = schema.anyOf.map((s) => validateSchema(s, value, path));
    if (issues.every(Boolean)) return fail(`${at} matches none of the allowed shapes`);
  }
  return null;
}

/** Drops null-valued object properties recursively. Strict function-calling sends null for "absent". */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== null) out[key] = stripNulls(child);
  }
  return out;
}
