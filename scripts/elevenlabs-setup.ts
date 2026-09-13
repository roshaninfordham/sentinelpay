// Creates or updates the SentinelPay settlement-desk voice agent in ElevenLabs from the version-controlled config:
// first message, system prompt and settings from src/lib/voice/agent.config.md, client tools from TOOL_SCHEMA.
// Idempotent: with ELEVENLABS_AGENT_ID set it PATCHes that agent, and tool records are matched by name and PATCHed,
// so repeated runs never leave duplicate tools behind.
// Usage: pnpm voice:setup            (reads .env.local; writes ELEVENLABS_AGENT_ID back to it on create)
//        pnpm voice:setup --check    (reads the live agent and reports drift from this config; changes nothing)
// Field names follow the ElevenLabs OpenAPI document at https://api.elevenlabs.io/openapi.json.
import "./load-env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOOL_SCHEMA } from "../src/lib/voice/tools";

const API = "https://api.elevenlabs.io/v1/convai";
const root = path.join(__dirname, "..");
const CONFIG = path.join(root, "src/lib/voice/agent.config.md");
const ENV_LOCAL = path.join(root, ".env.local");

export const DYNAMIC_VARIABLES = {
  payer: "Acme Corp",
  amount: "$240,000",
  vendor: "Meridian Global Logistics LLC",
  oldLast4: "4471",
  request_domain: "meridian-global.co",
  callback_number: "(312) 555-0198",
  payment_id: "pay_240k",
};

export interface AgentSettings {
  llm: string;
  temperature: number;
  max_tokens: number;
  turn_timeout: number;
  silence_end_call_timeout: number;
  spelling_patience: "auto" | "off";
  turn_eagerness: "patient" | "normal" | "eager";
  max_duration_seconds: number;
  max_conversation_duration_message: string;
  tool_response_timeout_secs: number;
  end_call: boolean;
}

/** The fenced block that follows a "## <heading>" line in agent.config.md (an info string such as json is allowed). */
export function section(markdown: string, heading: string): string {
  const match = new RegExp(`## ${heading}[^\\n]*\\n(?:(?!\\n## )[\\s\\S])*?\`\`\`[a-z]*\\n([\\s\\S]*?)\\n\`\`\``).exec(markdown);
  if (!match) throw new Error(`agent.config.md has no fenced block under "## ${heading}"`);
  return match[1].trim();
}

export function loadAgentConfig(markdown = readFileSync(CONFIG, "utf8")) {
  const settings = JSON.parse(section(markdown, "Agent settings")) as AgentSettings;
  return { firstMessage: section(markdown, "First message"), prompt: section(markdown, "System prompt"), settings };
}

async function call<T>(apiKey: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url.replace(API, "")} -> ${res.status} ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function saveAgentId(agentId: string) {
  const current = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : "";
  const next = /^ELEVENLABS_AGENT_ID=.*$/m.test(current)
    ? current.replace(/^ELEVENLABS_AGENT_ID=.*$/m, `ELEVENLABS_AGENT_ID=${agentId}`)
    : `${current}${current.endsWith("\n") || !current ? "" : "\n"}ELEVENLABS_AGENT_ID=${agentId}\n`;
  writeFileSync(ENV_LOCAL, next, { mode: 0o600 });
}

/** Every client override off: a browser holding a conversation token can change nothing but dynamic variables. */
const LOCKED_OVERRIDES = {
  conversation_config_override: {
    agent: { first_message: false, language: false, max_conversation_duration_message: false, prompt: { prompt: false, llm: false, tool_ids: false, native_mcp_server_ids: false, knowledge_base: false } },
    conversation: { text_only: false, max_duration_seconds: false },
    tts: { model_id: false, voice_id: false, supported_voices: false, stability: false, speed: false, similarity_boost: false, pronunciation_dictionary_locators: false },
    asr: { keywords: false },
  },
  custom_llm_extra_body: false,
  enable_conversation_initiation_client_data_from_webhook: false,
};

export function agentBody(cfg: ReturnType<typeof loadAgentConfig>, toolIds: string[]) {
  const s = cfg.settings;
  return {
    name: "SentinelPay settlement desk",
    conversation_config: {
      turn: { turn_timeout: s.turn_timeout, silence_end_call_timeout: s.silence_end_call_timeout, spelling_patience: s.spelling_patience, turn_eagerness: s.turn_eagerness },
      conversation: { max_duration_seconds: s.max_duration_seconds },
      agent: {
        first_message: cfg.firstMessage,
        language: "en",
        max_conversation_duration_message: s.max_conversation_duration_message,
        prompt: {
          prompt: cfg.prompt,
          llm: process.env.ELEVENLABS_LLM ?? s.llm,
          temperature: s.temperature,
          max_tokens: s.max_tokens,
          tool_ids: toolIds,
          built_in_tools: { end_call: s.end_call ? { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } } : null },
        },
        dynamic_variables: { dynamic_variable_placeholders: DYNAMIC_VARIABLES },
      },
    },
    platform_settings: { auth: { enable_auth: true }, overrides: LOCKED_OVERRIDES },
  };
}

interface ToolRecord { id: string; tool_config: { name?: string; type?: string } }
interface LiveAgent {
  conversation_config: {
    turn?: Record<string, unknown>;
    conversation?: Record<string, unknown>;
    agent: { first_message?: string; prompt: { prompt?: string; llm?: string; temperature?: number; max_tokens?: number; tool_ids?: string[]; built_in_tools?: { end_call?: unknown } } };
  };
  platform_settings: { auth?: { enable_auth?: boolean }; overrides?: { conversation_config_override?: { agent?: { prompt?: { prompt?: boolean } } } } };
}

/** Differences between the live agent and this config, as human-readable lines. Empty means in sync. */
export function drift(live: LiveAgent, cfg: ReturnType<typeof loadAgentConfig>): string[] {
  const out: string[] = [];
  const a = live.conversation_config.agent;
  const s = cfg.settings;
  const eq = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) out.push(`${label}: live=${JSON.stringify(actual)?.slice(0, 80)} config=${JSON.stringify(expected)?.slice(0, 80)}`);
  };
  eq("first_message", a.first_message, cfg.firstMessage);
  eq("prompt", a.prompt.prompt, cfg.prompt);
  eq("llm", a.prompt.llm, process.env.ELEVENLABS_LLM ?? s.llm);
  eq("temperature", a.prompt.temperature, s.temperature);
  eq("max_tokens", a.prompt.max_tokens, s.max_tokens);
  eq("turn_timeout", live.conversation_config.turn?.turn_timeout, s.turn_timeout);
  eq("silence_end_call_timeout", live.conversation_config.turn?.silence_end_call_timeout, s.silence_end_call_timeout);
  eq("turn_eagerness", live.conversation_config.turn?.turn_eagerness, s.turn_eagerness);
  eq("max_duration_seconds", live.conversation_config.conversation?.max_duration_seconds, s.max_duration_seconds);
  eq("end_call enabled", Boolean(a.prompt.built_in_tools?.end_call), s.end_call);
  eq("auth.enable_auth", live.platform_settings.auth?.enable_auth, true);
  eq("override prompt allowed", live.platform_settings.overrides?.conversation_config_override?.agent?.prompt?.prompt ?? false, false);
  return out;
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Set ELEVENLABS_API_KEY in .env.local");
  const cfg = loadAgentConfig();
  const existing = process.env.ELEVENLABS_AGENT_ID;

  if (process.argv.includes("--check")) {
    if (!existing) throw new Error("--check needs ELEVENLABS_AGENT_ID");
    const live = await call<LiveAgent>(apiKey, "GET", `${API}/agents/${encodeURIComponent(existing)}`);
    const d = drift(live, cfg);
    console.log(d.length ? `drift (${d.length}):\n  ${d.join("\n  ")}` : "agent    in sync with agent.config.md");
    process.exit(d.length ? 1 : 0);
  }

  // Reuse tool records the agent already points at (matched by name), then any workspace record with the name, and
  // create only what is missing. Other tools in the workspace are never touched.
  const attached = new Set<string>();
  if (existing) {
    const live = await call<LiveAgent>(apiKey, "GET", `${API}/agents/${encodeURIComponent(existing)}`);
    for (const id of live.conversation_config.agent.prompt.tool_ids ?? []) attached.add(id);
  }
  const workspace = (await call<{ tools?: ToolRecord[] }>(apiKey, "GET", `${API}/tools`)).tools ?? [];
  const toolIds: string[] = [];
  for (const tool of TOOL_SCHEMA) {
    const tool_config = { ...tool, response_timeout_secs: cfg.settings.tool_response_timeout_secs };
    const sameName = workspace.filter((t) => t.tool_config.name === tool.name && t.tool_config.type === "client");
    const match = sameName.find((t) => attached.has(t.id)) ?? sameName[0];
    if (match) {
      await call(apiKey, "PATCH", `${API}/tools/${encodeURIComponent(match.id)}`, { tool_config });
      toolIds.push(match.id);
      console.log(`tool     ${tool.name} -> ${match.id} (updated)`);
    } else {
      const created = await call<{ id: string }>(apiKey, "POST", `${API}/tools`, { tool_config });
      toolIds.push(created.id);
      console.log(`tool     ${tool.name} -> ${created.id} (created)`);
    }
  }

  const body = agentBody(cfg, toolIds);
  let agentId: string;
  if (existing) {
    await call(apiKey, "PATCH", `${API}/agents/${encodeURIComponent(existing)}`, body);
    agentId = existing;
    console.log(`agent    updated ${agentId}`);
  } else {
    agentId = (await call<{ agent_id: string }>(apiKey, "POST", `${API}/agents/create`, body)).agent_id;
    console.log(`agent    created ${agentId}`);
    saveAgentId(agentId);
    console.log("         wrote ELEVENLABS_AGENT_ID to .env.local. For Vercel: vercel env add ELEVENLABS_AGENT_ID production");
  }

  // Read back what the API stored, so a silently ignored field shows up as drift instead of passing unnoticed.
  const live = await call<LiveAgent>(apiKey, "GET", `${API}/agents/${encodeURIComponent(agentId)}`);
  const d = drift(live, cfg);
  console.log(d.length ? `verify   DRIFT after update:\n  ${d.join("\n  ")}` : "verify   live agent matches agent.config.md");

  // Confirm the private agent mints conversation tokens, which is what /api/voice/token does per call.
  const token = await call<{ token?: string }>(apiKey, "GET", `${API}/conversation/token?agent_id=${encodeURIComponent(agentId)}`);
  console.log(`token    ${token.token ? "minted (single-use conversation token works)" : "MISSING"}`);
  if (d.length || !token.token) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`voice:setup failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
