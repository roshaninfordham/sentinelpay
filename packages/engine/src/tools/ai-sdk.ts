import type { Principal, SentinelPay } from "../core/types";
import { callTool, type ToolResult } from "./call";
import { toolDefinitions, type JSONSchema7, type ToolName } from "./definitions";
import { stripNulls, validateSchema } from "./validate";

// The AI SDK recognizes a schema by these registry symbols (what `jsonSchema()` from "ai" produces),
// so the tools work with `generateText({ tools })` without this package importing "ai" at runtime.
const SCHEMA_SYMBOL = Symbol.for("vercel.ai.schema");
const VALIDATOR_SYMBOL = Symbol.for("vercel.ai.validator");

export interface AiSdkSchema {
  readonly [SCHEMA_SYMBOL]: true;
  readonly [VALIDATOR_SYMBOL]: true;
  readonly jsonSchema: JSONSchema7;
  validate(value: unknown): { success: true; value: unknown } | { success: false; error: Error };
}

/** Structurally compatible with an AI SDK `Tool`: `{ description, inputSchema, execute }`. */
export interface AiSdkTool {
  description: string;
  inputSchema: AiSdkSchema;
  execute(args: unknown): Promise<ToolResult>;
}

function schemaFor(jsonSchema: JSONSchema7): AiSdkSchema {
  return {
    [SCHEMA_SYMBOL]: true,
    [VALIDATOR_SYMBOL]: true,
    jsonSchema: structuredClone(jsonSchema),
    validate(value) {
      const normalized = stripNulls(value);
      const issue = validateSchema(jsonSchema, normalized);
      return issue ? { success: false, error: new Error(`${issue.path || "/"}: ${issue.message}`) } : { success: true, value: normalized };
    },
  };
}

export function toAiSdkTools(api: SentinelPay, ctx: { principal?: Principal } = {}): Record<ToolName, AiSdkTool> {
  const entries = toolDefinitions.map((d) => [d.name, {
    description: d.description,
    inputSchema: schemaFor(d.inputSchema),
    execute: (args: unknown) => callTool(api, d.name, args, ctx),
  }] as const);
  return Object.fromEntries(entries) as Record<ToolName, AiSdkTool>;
}
