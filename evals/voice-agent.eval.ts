// LIVE adversarial evals for the settlement-desk voice agent (Agent 1), using ElevenLabs agent simulation:
// POST /v1/convai/agents/{agent_id}/simulate-conversation (in the ElevenLabs OpenAPI document; marked deprecated there in
// favour of /v1/convai/agent-testing/create + /v1/convai/agents/{agent_id}/run-tests, and still served).
// A simulated vendor persona talks to the real, deployed agent config; client tools are mocked by name, and the grader in
// voice-scenarios.ts asserts which decision tool was called with which arguments.
//
// Usage: tsx evals/voice-agent.eval.ts [--only id,id] [--turns 12]
// Needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID (read from .env.local). Each scenario is one simulation call.
// Writes evals/results/voice-agent.json (transcripts and grades; no keys) and exits 1 if any scenario fails.
import "../scripts/load-env";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DYNAMIC_VARIABLES } from "../scripts/elevenlabs-setup";
import { agentReply } from "../src/lib/voice/tools";
import { grade, SCENARIOS, type Grade, type Turn, type VoiceScenario } from "./voice-scenarios";

const API = "https://api.elevenlabs.io/v1/convai";
const RESULTS = path.join(__dirname, "results", "voice-agent.json");

interface SimTurn {
  role: "agent" | "user";
  message?: string | null;
  tool_calls?: Array<{ tool_name: string; params_as_json: string }> | null;
}
interface SimResponse {
  simulated_conversation: SimTurn[];
  analysis?: { call_successful?: string; transcript_summary?: string };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseParams(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return { _unparseable: json };
  }
}

export function toTurns(sim: SimResponse): Turn[] {
  return sim.simulated_conversation.map((t) => ({
    role: t.role,
    message: t.message ?? "",
    toolCalls: (t.tool_calls ?? []).map((c) => ({ tool: c.tool_name, params: parseParams(c.params_as_json) })),
  }));
}

async function simulate(apiKey: string, agentId: string, s: VoiceScenario, turns: number): Promise<SimResponse> {
  const body = {
    simulation_specification: {
      simulated_user_config: {
        first_message: "",
        language: "en",
        prompt: { prompt: s.persona, temperature: 0 },
      },
      dynamic_variables: DYNAMIC_VARIABLES,
      // Client tools run in the operator's browser, so the simulation mocks them. The result text matches what
      // submitDecision returns; the engine outcome itself is proven by the deterministic tests.
      tool_mock_config: {
        freeze_payment: { default_return_value: agentReply("freeze_payment", "QUARANTINED"), default_is_error: false },
        approve_payment: { default_return_value: agentReply("approve_payment", "CLEARED"), default_is_error: false },
      },
    },
    new_turns_limit: turns,
  };
  const res = await fetch(`${API}/agents/${encodeURIComponent(agentId)}/simulate-conversation`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`simulate-conversation ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as SimResponse;
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) throw new Error("Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env.local");
  const only = arg("only")?.split(",");
  const turns = Number(arg("turns") ?? 12);
  const selected = SCENARIOS.filter((s) => !only || only.includes(s.id));
  if (!selected.length) throw new Error(`no scenario matches --only ${only?.join(",")}`);

  const results: Array<{ id: string; title: string; grade: Grade; transcript: Turn[]; error?: string }> = [];
  for (const s of selected) {
    const started = Date.now();
    try {
      const transcript = toTurns(await simulate(apiKey, agentId, s, turns));
      const g = grade(s, transcript);
      results.push({ id: s.id, title: s.title, grade: g, transcript });
      console.log(`${g.pass ? "PASS" : "FAIL"}  ${s.id.padEnd(24)} ${g.decision}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      for (const f of g.failures) console.log(`      - ${f}`);
      if (process.argv.includes("--verbose") || !g.pass) {
        for (const t of transcript) {
          const tools = t.toolCalls.map((c) => ` [${c.tool} ${JSON.stringify(c.params)}]`).join("");
          console.log(`      ${t.role === "agent" ? "agent " : "vendor"}: ${t.message}${tools}`);
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      results.push({ id: s.id, title: s.title, grade: { pass: false, decision: "error", failures: [message] }, transcript: [], error: message });
      console.log(`ERROR ${s.id.padEnd(24)} ${message}`);
    }
  }

  // Merge by scenario id, so re-running one scenario after a prompt fix keeps the others' latest results.
  mkdirSync(path.dirname(RESULTS), { recursive: true });
  const previous = existsSync(RESULTS) ? ((JSON.parse(readFileSync(RESULTS, "utf8")) as { results?: typeof results }).results ?? []) : [];
  const ranAt = new Date().toISOString();
  const merged = SCENARIOS.map((s) => {
    const fresh = results.find((r) => r.id === s.id);
    return fresh ? { ...fresh, ranAt, turns } : previous.find((r) => r.id === s.id);
  }).filter(Boolean);
  writeFileSync(RESULTS, `${JSON.stringify({ agent: "SentinelPay settlement desk", endpoint: "POST /v1/convai/agents/{agent_id}/simulate-conversation", results: merged }, null, 2)}\n`);
  const passed = results.filter((r) => r.grade.pass).length;
  console.log(`\n${passed}/${results.length} scenarios passed. Transcripts: ${path.relative(process.cwd(), RESULTS)}`);
  process.exit(passed === results.length ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`voice eval failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
