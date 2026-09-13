// Creates (or updates) the SentinelPay settlement-desk voice agent in ElevenLabs from the version-controlled
// config: first message and system prompt from src/lib/voice/agent.config.md, client tools from TOOL_SCHEMA.
// Usage: ELEVENLABS_API_KEY=... pnpm voice:setup   (reads .env.local; writes ELEVENLABS_AGENT_ID back to it)
import "./load-env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOOL_SCHEMA } from "../src/lib/voice/tools";

const API = "https://api.elevenlabs.io/v1/convai";
const root = path.join(__dirname, "..");
const CONFIG = path.join(root, "src/lib/voice/agent.config.md");
const ENV_LOCAL = path.join(root, ".env.local");

const DYNAMIC_VARIABLES = {
  payer: "Acme Corp",
  amount: "$240,000",
  vendor: "Meridian Global Logistics LLC",
  oldLast4: "4471",
  request_domain: "meridian-global.co",
  callback_number: "(312) 555-0198",
  payment_id: "pay_240k",
};

/** The fenced block that follows a "## <heading>" line in agent.config.md. */
function section(markdown: string, heading: string): string {
  const match = new RegExp(`## ${heading}\\s*\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\``).exec(markdown);
  if (!match) throw new Error(`agent.config.md has no fenced block under "## ${heading}"`);
  return match[1].trim();
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

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Set ELEVENLABS_API_KEY in .env.local");

  const markdown = readFileSync(CONFIG, "utf8");
  const firstMessage = section(markdown, "First message");
  const prompt = section(markdown, "System prompt");

  const toolIds: string[] = [];
  for (const tool of TOOL_SCHEMA) {
    const created = await call<{ id: string }>(apiKey, "POST", `${API}/tools`, {
      tool_config: { ...tool, response_timeout_secs: 30 },
    });
    toolIds.push(created.id);
    console.log(`tool     ${tool.name} -> ${created.id}`);
  }

  const agentBody = {
    name: "SentinelPay settlement desk",
    conversation_config: {
      agent: {
        first_message: firstMessage,
        language: "en",
        prompt: { prompt, llm: process.env.ELEVENLABS_LLM ?? "gpt-4o-mini", tool_ids: toolIds, temperature: 0 },
        dynamic_variables: { dynamic_variable_placeholders: DYNAMIC_VARIABLES },
      },
    },
    platform_settings: { auth: { enable_auth: true } },
  };

  const existing = process.env.ELEVENLABS_AGENT_ID;
  let agentId: string;
  if (existing) {
    await call(apiKey, "PATCH", `${API}/agents/${encodeURIComponent(existing)}`, agentBody);
    agentId = existing;
    console.log(`agent    updated ${agentId}`);
  } else {
    agentId = (await call<{ agent_id: string }>(apiKey, "POST", `${API}/agents/create`, agentBody)).agent_id;
    console.log(`agent    created ${agentId}`);
  }

  // Confirm the private agent mints conversation tokens, which is what /api/voice/token does per call.
  const token = await call<{ token?: string }>(apiKey, "GET", `${API}/conversation/token?agent_id=${encodeURIComponent(agentId)}`);
  console.log(`token    ${token.token ? "minted (single-use conversation token works)" : "MISSING"}`);

  saveAgentId(agentId);
  console.log("\nWrote ELEVENLABS_AGENT_ID to .env.local. For Vercel: vercel env add ELEVENLABS_AGENT_ID production");
}

main().catch((err) => {
  console.error(`voice:setup failed: ${(err as Error).message}`);
  process.exit(1);
});
