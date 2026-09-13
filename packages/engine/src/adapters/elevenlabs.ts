// Server-only helper for a browser voice challenger: mints a single-use ElevenLabs conversation token,
// so the API key never reaches the browser.

export const ELEVENLABS_TOKEN_URL = "https://api.elevenlabs.io/v1/convai/conversation/token";
const TIMEOUT_MS = 8_000;

export async function mintConversationToken(opts: { apiKey: string; agentId: string; fetch?: typeof fetch }): Promise<string> {
  if (!opts.apiKey || !opts.agentId) throw new Error("mintConversationToken requires apiKey and agentId");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(`${ELEVENLABS_TOKEN_URL}?agent_id=${encodeURIComponent(opts.agentId)}`, {
    headers: { "xi-api-key": opts.apiKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ElevenLabs token ${res.status}`);
  const { token } = (await res.json()) as { token?: unknown };
  if (typeof token !== "string" || !token) throw new Error("ElevenLabs token response has no token");
  return token;
}
