import { toolDefinitions, type JSONSchema7, type JSONSchemaType } from "./definitions";

/**
 * Keywords removed by the strict transform and restated in `description` (§5.3). OpenAI Structured Outputs
 * rejects `default` and the string length keywords. Numeric bounds and `pattern` are moved to text as well:
 * restating a supported keyword costs nothing, while keeping an unsupported one fails every strict call.
 * callTool re-validates all of them server-side.
 */
export const STRICT_UNSUPPORTED_KEYWORDS = ["default", "minimum", "maximum", "minLength", "maxLength", "pattern"] as const;

const LABELS: Record<(typeof STRICT_UNSUPPORTED_KEYWORDS)[number], string> = {
  default: "default",
  minimum: "min",
  maximum: "max",
  minLength: "min length",
  maxLength: "max length",
  pattern: "pattern",
};

export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: JSONSchema7; strict: true };
}

function nullable(schema: JSONSchema7): JSONSchema7 {
  const out = { ...schema };
  const types: JSONSchemaType[] = out.type === undefined ? [] : Array.isArray(out.type) ? [...out.type] : [out.type];
  if (types.length && !types.includes("null")) out.type = [...types, "null"];
  if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
}

/** Applies the strict transform to a copy; the shared definitions are never mutated. */
export function toStrictSchema(schema: JSONSchema7): JSONSchema7 {
  const out: JSONSchema7 = structuredClone(schema);

  const notes: string[] = [];
  for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) {
    if (out[keyword] === undefined) continue;
    notes.push(`${LABELS[keyword]} ${JSON.stringify(out[keyword])}`);
    delete out[keyword];
  }
  if (notes.length) out.description = [out.description, `(${notes.join("; ")})`].filter(Boolean).join(" ");

  if (out.items) out.items = toStrictSchema(out.items);
  if (out.anyOf) out.anyOf = out.anyOf.map(toStrictSchema);

  if (out.type === "object" || out.properties) {
    const required = new Set(out.required ?? []);
    const properties: Record<string, JSONSchema7> = {};
    for (const [key, child] of Object.entries(out.properties ?? {})) {
      const strict = toStrictSchema(child);
      properties[key] = required.has(key) ? strict : nullable(strict);
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

export function toOpenAITools(): OpenAITool[] {
  return toolDefinitions.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: toStrictSchema(d.inputSchema), strict: true },
  }));
}
