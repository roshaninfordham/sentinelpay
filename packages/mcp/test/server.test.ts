import assert from "node:assert/strict";
import test from "node:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { assessRisk, EngineError, levelFor, type ForensicSignal, type SentinelPay, type Verification } from "@sentinelpay/engine";
import { POLICY } from "../src/policy";
import { createMcpServer, VERIFY_BEFORE_PAYING } from "../src/server";
import { createHttpClient } from "@sentinelpay/engine/client";
import { AGENT_API_KEY, connect, connectedScenario, poisoned } from "./helpers";

const readJson = async (client: Awaited<ReturnType<typeof connect>>["client"], uri: string) => {
  const res = await client.readResource({ uri });
  assert.equal(res.contents[0].mimeType, "application/json");
  return JSON.parse((res.contents[0] as { text: string }).text);
};

test("declares tools, resources and prompts; lists the policy resource and both verification templates", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);
  const caps = s.client.getServerCapabilities();
  assert.ok(caps?.tools && caps.resources && caps.prompts);
  assert.equal(caps.resources.subscribe, undefined, "resources are not subscribable in v0.1");
  assert.deepEqual((await s.client.listResources()).resources.map((r) => r.uri), ["sentinelpay://policy"]);
  assert.deepEqual((await s.client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate), [
    "sentinelpay://verifications/{paymentId}", "sentinelpay://verifications/{paymentId}/receipt",
  ]);
});

test("verification and receipt resources read through the engine; unknown payments and uris are resource errors", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);
  await s.engine.verify(poisoned());

  const v = await readJson(s.client, "sentinelpay://verifications/pay_240k") as Verification;
  assert.deepEqual([v.object, v.paymentId, v.decision], ["verification", "pay_240k", "WAIT"]);
  const withReceipt = await s.client.callTool({ name: "get_verification", arguments: { paymentId: "pay_240k", waitMs: 0, includeReceipt: true } });
  const both = withReceipt.structuredContent as { verification: Verification; receipt: { chain: { ok: boolean } } };
  assert.deepEqual([withReceipt.isError ?? false, both.verification.paymentId, both.receipt.chain.ok], [false, "pay_240k", true]);
  assert.match((withReceipt.content as Array<{ text: string }>)[0].text, /^decision=WAIT reason=\w+ next=POLL$/);

  const receipt = await readJson(s.client, "sentinelpay://verifications/pay_240k/receipt");
  assert.equal(receipt.verification.paymentId, "pay_240k");
  assert.equal(receipt.chain.ok, true);

  await assert.rejects(s.client.readResource({ uri: "sentinelpay://verifications/pay_missing" }), (err: unknown) =>
    err instanceof McpError && err.code === -32002 && (err.data as { error: { code: string } }).error.code === "NOT_FOUND");
  await assert.rejects(s.client.readResource({ uri: "sentinelpay://verifications/bad%20id" }), (err: unknown) =>
    err instanceof McpError && err.code === -32602);
  await assert.rejects(s.client.readResource({ uri: "sentinelpay://ledger" }), (err: unknown) => err instanceof McpError && err.code === -32002);
});

test("policy resource matches assessRisk and levelFor", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);
  const policy = await readJson(s.client, "sentinelpay://policy");
  assert.deepEqual(policy, JSON.parse(JSON.stringify(POLICY)));
  assert.equal(policy.policyVersion, "rules-v1");

  const sig = (key: ForensicSignal["key"], value: ForensicSignal["value"]): ForensicSignal => ({ key, value, source: "test", origin: "live" });
  const scenarios: Record<string, ForensicSignal[]> = {
    young_domain: [sig("domain_age_days", 3)],
    entity_mismatch: [sig("entity_match", false)],
    phone_unverified: [sig("verified_phone", false)],
    sanctions: [sig("sanctions_hit", true)],
  };
  for (const rule of POLICY.rules) {
    const risk = assessRisk(scenarios[rule.id]);
    assert.deepEqual(risk.rules.map((r) => [r.id, r.points]), [[rule.id, rule.points]], rule.id);
    assert.ok(risk.reasons.every((r) => (rule.reasons as readonly string[]).includes(r)), rule.id);
  }
  assert.equal(assessRisk([sig("domain_age_days", 29)]).score, 50, "young_domain applies under 30 days");
  assert.equal(assessRisk([sig("domain_age_days", 30)]).score, 0, "young_domain stops at 30 days");
  assert.equal(assessRisk([sig("domain_age_days", null)]).score, 50, "no registry record counts as young");
  const all = assessRisk(Object.values(scenarios).flat());
  assert.equal(all.score, POLICY.scoreCap);
  for (const { level, minScore } of POLICY.levels) {
    assert.equal(levelFor(minScore), level);
    if (minScore > 0) assert.notEqual(levelFor(minScore - 1), level);
  }
});

test("verify-before-paying prompt carries the requester rules", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);
  assert.deepEqual((await s.client.listPrompts()).prompts.map((p) => p.name), ["verify-before-paying"]);
  const prompt = await s.client.getPrompt({ name: "verify-before-paying" });
  assert.deepEqual(prompt.messages[0].content, { type: "text", text: VERIFY_BEFORE_PAYING });
  assert.match(VERIFY_BEFORE_PAYING, /never ask anyone for a token/);
  assert.equal(s.client.getInstructions(), VERIFY_BEFORE_PAYING);
});

test("invalid arguments, identity fields and non-engine failures come back as isError with the envelope", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);

  const bad = await s.client.callTool({ name: "verify_payment", arguments: { payment: { ...poisoned(), extra: 1 } } });
  const badError = (bad.structuredContent as { error: { code: string; path: string } }).error;
  assert.deepEqual([bad.isError, badError.code, badError.path], [true, "INVALID_INPUT", "/payment/extra"]);

  const spoof = await s.client.callTool({ name: "block_payment", arguments: { paymentId: "pay_240k", reason: "stop", principal: { id: "human:ops" } } });
  assert.deepEqual([spoof.isError, (spoof.structuredContent as { error: { code: string } }).error.code], [true, "INVALID_INPUT"]);

  const failing: SentinelPay = {
    verify: async () => { throw new Error("db password is hunter2"); },
    get: async () => { throw new EngineError("STORAGE_UNAVAILABLE", "down"); },
    block: async () => { throw new Error("x"); },
    receipt: async () => { throw new Error("x"); },
  };
  const c = await connect(failing);
  t.after(c.close);
  const res = await c.client.callTool({ name: "verify_payment", arguments: { payment: poisoned() } });
  const error = (res.structuredContent as { error: { code: string; message: string; nextActions: Array<{ type: string }> } }).error;
  assert.deepEqual([res.isError, error.code, error.nextActions[0].type], [true, "STORAGE_UNAVAILABLE", "DO_NOT_PAY"]);
  assert.ok(!JSON.stringify(res).includes("hunter2"), "adapter internals leak through MCP");
  assert.match((res.content as Array<{ text: string }>)[0].text, /^error=STORAGE_UNAVAILABLE retryable=true next=DO_NOT_PAY$/);
});

test("sweep runs on an interval only while a client is connected, and needs an Engine", async () => {
  let sweeps = 0;
  const api = { sweep: async () => { sweeps++; return { advanced: 0, expired: 0 }; } } as unknown as SentinelPay;
  const c = await connect(api, { sweep: { intervalMs: 5 } });
  await new Promise((r) => setTimeout(r, 40));
  await c.close();
  const atClose = sweeps;
  assert.ok(atClose >= 2, `expected repeated sweeps, got ${atClose}`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sweeps, atClose, "sweep kept running after the client disconnected");

  const remoteLike = { verify: async () => ({}), get: async () => ({}), block: async () => ({}), receipt: async () => ({}) } as unknown as SentinelPay;
  assert.throws(() => createMcpServer(remoteLike, { sweep: {} }), /needs an Engine/);
});

test("remote mode: the server over createHttpClient proxies to the host handler with the API key's identity", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);
  const remote = createHttpClient({
    baseUrl: "https://sentinelpay.test/api/v1", apiKey: AGENT_API_KEY,
    fetch: async (input, init) => s.handler(new Request(input, init)),
  });
  const c = await connect(remote);
  t.after(c.close);

  const verified = await c.client.callTool({ name: "verify_payment", arguments: { payment: poisoned() } });
  const v = verified.structuredContent as unknown as Verification;
  assert.deepEqual([verified.isError ?? false, v.decision, v.requestedBy], [false, "WAIT", "agent:ap-bot"]);
  const blocked = await c.client.callTool({ name: "block_payment", arguments: { paymentId: "pay_240k", reason: "suspected BEC" } });
  assert.equal((blocked.content as Array<{ text: string }>)[0].text, "decision=DO_NOT_PAY reason=BLOCKED_BY_PRINCIPAL next=DO_NOT_PAY");

  const conflict = await c.client.callTool({ name: "verify_payment", arguments: { payment: poisoned({ beneficiary: { accountLast4: "1234" } }) } });
  assert.deepEqual([conflict.isError, (conflict.structuredContent as { error: { code: string } }).error.code], [true, "IDEMPOTENCY_CONFLICT"]);
});
