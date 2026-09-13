import AjvModule from "ajv";
import type { JSONSchema7 } from "../../src/tools";

// ajv is CommonJS; under tsx's ESM interop the constructor may sit on `.default`.
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as typeof AjvModule;

export function compile(schema: JSONSchema7) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema as object);
  return (value: unknown) => {
    const ok = validate(value) as boolean;
    return { ok, errors: ok ? "" : ajv.errorsText(validate.errors) };
  };
}

/** Closes every object that declares properties, so an undocumented output field fails validation. */
export function closed(schema: JSONSchema7): JSONSchema7 {
  const out: JSONSchema7 = structuredClone(schema);
  const walk = (s: JSONSchema7) => {
    if (s.properties) {
      if (s.additionalProperties === undefined) s.additionalProperties = false;
      Object.values(s.properties).forEach(walk);
    }
    if (s.items) walk(s.items);
    s.anyOf?.forEach(walk);
  };
  walk(out);
  return out;
}

/** Visits every sub-schema with its JSON-pointer-like location. */
export function walkSchema(schema: JSONSchema7, visit: (s: JSONSchema7, at: string) => void, at = "#") {
  visit(schema, at);
  for (const [k, v] of Object.entries(schema.properties ?? {})) walkSchema(v, visit, `${at}/properties/${k}`);
  if (schema.items) walkSchema(schema.items, visit, `${at}/items`);
  schema.anyOf?.forEach((s, i) => walkSchema(s, visit, `${at}/anyOf/${i}`));
}
