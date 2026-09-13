import assert from "node:assert/strict";
import { test } from "node:test";
import { mintConversationToken } from "../../src/adapters/elevenlabs";
import { stubFetch } from "./stub-fetch";

test("mintConversationToken: GET token endpoint with xi-api-key and agent_id", async () => {
  const { fetch, calls } = stubFetch(() => Response.json({ token: "conv_tok_1" }));
  assert.equal(await mintConversationToken({ apiKey: "xi_key", agentId: "agent 7", fetch }), "conv_tok_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent%207");
  assert.equal(calls[0].headers["xi-api-key"], "xi_key");
});

test("mintConversationToken rejects on non-2xx, a missing token, or missing credentials", async () => {
  const denied = stubFetch(() => Response.json({ detail: "unauthorized" }, { status: 401 }));
  await assert.rejects(mintConversationToken({ apiKey: "k", agentId: "a", fetch: denied.fetch }), /ElevenLabs token 401/);
  const empty = stubFetch(() => Response.json({}));
  await assert.rejects(mintConversationToken({ apiKey: "k", agentId: "a", fetch: empty.fetch }), /no token/);
  const unused = stubFetch(() => Response.json({ token: "x" }));
  await assert.rejects(mintConversationToken({ apiKey: "", agentId: "a", fetch: unused.fetch }), /requires apiKey/);
  assert.equal(unused.calls.length, 0);
});
