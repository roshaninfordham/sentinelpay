import { toolDefinitions, type JSONSchema7 } from "./definitions";

export interface AnthropicTool { name: string; description: string; input_schema: JSONSchema7 }

/** Anthropic tool use accepts the original schemas unchanged (§5.3). */
export function toAnthropicTools(): AnthropicTool[] {
  return toolDefinitions.map((d) => ({ name: d.name, description: d.description, input_schema: structuredClone(d.inputSchema) }));
}
