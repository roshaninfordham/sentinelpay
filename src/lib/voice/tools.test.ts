import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Verdict } from "../types";

// Verification gates for the settlement-desk voice agent's tool path (docs/AGENTS.md, Agent 1). Every test drives the
// real client tool handler from createClientTools, whose fetch is routed into the real /api/governor/decide route, the
// governor and the engine. Whatever the LLM passes, only an explicit approve_payment carrying the responder token and the
// matching read-back can clear; every other shape of call ends frozen or leaves the payment held.

process.env.SENTINEL_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "sentinel-voice-tools-")), "test.db");
process.env.SENTINELPAY_TOKEN_PEPPER = "t".repeat(40);
process.env.DEMO_MODE = "cache";
process.env.DEMO_PACE_MS = "0";

const NEW_LAST4 = "9821"; // seeded pay_240k beneficiary

interface Sent { url: string; body: Record<string, unknown>; status: number }

async function openCall(opts: { token?: (real: string) => string; challengeId?: (real: string) => string } = {}) {
  const { reseed } = await import("../seed-data");
  const { getRuntime } = await import("../engine");
  const { runGate } = await import("../gate");
  const tokenRoute = await import("../../../app/api/voice/token/route");
  const decideRoute = await import("../../../app/api/governor/decide/route");
  const { createClientTools } = await import("./tools");
  await reseed();
  const rt = await getRuntime();
  await runGate("pay_240k");
  await rt.engine.advance("pay_240k");
  const res = await tokenRoute.GET(new Request("http://localhost/api/voice/token?paymentId=pay_240k"));
  assert.equal(res.status, 200);
  const session = (await res.json()) as { challengeId: string; responderToken: string; dynamicVariables: Record<string, string> };

  const sent: Sent[] = [];
  const decided: Array<[string, Verdict]> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, "/api/governor/decide");
    const response = await decideRoute.POST(new Request(`http://localhost${url}`, init));
    sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, status: response.status });
    return response;
  }) as typeof fetch;

  const tools = createClientTools({
    paymentId: "pay_240k",
    challengeId: opts.challengeId ? opts.challengeId(session.challengeId) : session.challengeId,
    responderToken: opts.token ? opts.token(session.responderToken) : session.responderToken,
    startedAt: Date.now(),
    transcript: () => "agent: Did your treasury team authorize this change?",
    onDecided: (tool, verdict) => void decided.push([tool, verdict]),
  });
  const state = async () => {
    const c = await rt.loadCase({ paymentId: "pay_240k" });
    return { state: c?.state, reason: c?.reason };
  };
  return { tools, sent, decided, state, session };
}

type Tools = Awaited<ReturnType<typeof openCall>>["tools"];
type AnyParams<T> = T extends (p: infer P) => unknown ? P | Record<string, unknown> | undefined : never;
const freeze = (t: Tools, p: AnyParams<Tools["freeze_payment"]>) => t.freeze_payment(p as never);
const approve = (t: Tools, p: AnyParams<Tools["approve_payment"]>) => t.approve_payment(p as never);

test("freeze_payment outcome 'denied' quarantines as VENDOR_DENIED_CHANGE and never sends the responder token", async () => {
  const call = await openCall();
  const reply = await freeze(call.tools, { outcome: "denied", reason: "controller says fraud" });
  assert.match(reply, /QUARANTINED/);
  assert.deepEqual(await call.state(), { state: "QUARANTINED", reason: "VENDOR_DENIED_CHANGE" });
  assert.equal(call.sent[0].body.verdict, "DENIED");
  assert.equal("responderToken" in call.sent[0].body, false);
  assert.equal("beneficiaryLast4ReadBack" in call.sent[0].body, false);
});

test("freeze_payment outcome 'inconclusive' quarantines as CHALLENGE_INCONCLUSIVE", async () => {
  const call = await openCall();
  await freeze(call.tools, { outcome: "inconclusive" });
  assert.deepEqual(await call.state(), { state: "QUARANTINED", reason: "CHALLENGE_INCONCLUSIVE" });
});

test("a malformed freeze_payment outcome still freezes, as INCONCLUSIVE (free text is never parsed)", async () => {
  const malformed: Array<AnyParams<Tools["freeze_payment"]>> = [
    { outcome: "DENIED" }, { outcome: "approve" }, { outcome: "authorized" }, { outcome: 1 }, { outcome: null }, {}, undefined,
    { reason: "vendor said no" },
  ];
  const call = await openCall();
  for (const params of malformed) await freeze(call.tools, params);
  assert.deepEqual(call.sent.map((s) => s.body.verdict), malformed.map(() => "INCONCLUSIVE"));
  assert.deepEqual(await call.state(), { state: "QUARANTINED", reason: "CHALLENGE_INCONCLUSIVE" });
});

test("approve_payment with the vendor's matching read-back clears (numerals or spoken digits)", async () => {
  for (const readBack of [NEW_LAST4, "nine eight two one", "9 8 2 1"]) {
    const call = await openCall();
    const reply = await approve(call.tools, { last4_read_back: readBack });
    assert.match(reply, /CLEARED/, readBack);
    assert.equal((await call.state()).state, "CLEARED", readBack);
    assert.equal(call.sent[0].body.beneficiaryLast4ReadBack, NEW_LAST4);
    assert.deepEqual(call.decided, [["approve_payment", "AUTHORIZED"]]);
  }
});

test("approve_payment with a wrong read-back freezes: the engine denies the mismatch", async () => {
  for (const readBack of ["5530", "4471", "0000"]) {
    const call = await openCall();
    await approve(call.tools, { last4_read_back: readBack });
    assert.deepEqual(await call.state(), { state: "QUARANTINED", reason: "VENDOR_DENIED_CHANGE" }, readBack);
  }
});

test("approve_payment with a missing or unusable read-back freezes (no read-back is a denial)", async () => {
  const unusable: Array<AnyParams<Tools["approve_payment"]>> = [
    {}, undefined, { last4_read_back: 9821 }, { last4_read_back: "98211" }, { last4_read_back: "982" },
    { last4_read_back: "it ends in 9821" }, { last4_read_back: "4471 no 9821" }, { last4_read_back: "" },
  ];
  for (const params of unusable) {
    const call = await openCall();
    await approve(call.tools, params);
    assert.equal("beneficiaryLast4ReadBack" in call.sent[0].body, false, JSON.stringify(params));
    assert.deepEqual(await call.state(), { state: "QUARANTINED", reason: "VENDOR_DENIED_CHANGE" }, JSON.stringify(params));
  }
});

test("approve_payment without the responder token is refused and never clears; the payment stays held", async () => {
  const call = await openCall({ token: () => "" });
  const reply = await approve(call.tools, { last4_read_back: NEW_LAST4 });
  assert.match(reply, /Governor rejected the decision/);
  assert.equal(call.sent[0].status, 403);
  assert.deepEqual(call.decided, []);
  assert.equal((await call.state()).state, "CHALLENGING");
  // Freezing is still possible after the refusal.
  await freeze(call.tools, { outcome: "inconclusive" });
  assert.equal((await call.state()).state, "QUARANTINED");
});

test("approve_payment with a wrong token or another challenge's id is refused with 401 and never clears", async () => {
  const wrongToken = await openCall({ token: (t) => `${t.slice(0, -1)}${t.endsWith("a") ? "b" : "a"}` });
  await approve(wrongToken.tools, { last4_read_back: NEW_LAST4 });
  assert.equal(wrongToken.sent[0].status, 401);
  assert.equal((await wrongToken.state()).state, "CHALLENGING");

  const wrongChallenge = await openCall({ challengeId: () => "chl_notthisone" });
  await approve(wrongChallenge.tools, { last4_read_back: NEW_LAST4 });
  assert.equal(wrongChallenge.sent[0].status, 401);
  assert.equal((await wrongChallenge.state()).state, "CHALLENGING");
});

test("approve_payment after freeze_payment cannot clear: the first decision is final", async () => {
  const call = await openCall();
  await freeze(call.tools, { outcome: "denied" });
  const reply = await approve(call.tools, { last4_read_back: NEW_LAST4 });
  assert.match(reply, /QUARANTINED/);
  assert.deepEqual(await call.state(), { state: "QUARANTINED", reason: "VENDOR_DENIED_CHANGE" });
});

test("a malformed decision body at the route is rejected with 400 and the payment stays held", async () => {
  const call = await openCall();
  const { POST } = await import("../../../app/api/governor/decide/route");
  for (const body of [{ paymentId: "pay_240k", verdict: "APPROVED" }, { paymentId: "pay_240k" }, { paymentId: "pay_240k", verdict: "DENIED", toolInvoked: "transfer_money" }]) {
    const res = await POST(new Request("http://localhost/api/governor/decide", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await call.state()).state, "CHALLENGING");
});

test("the agent is never given the new account digits or the responder token", async () => {
  const call = await openCall();
  const exposed = JSON.stringify(call.session.dynamicVariables);
  assert.equal(exposed.includes(NEW_LAST4), false);
  assert.equal(exposed.includes(call.session.responderToken), false);

  const { TOOL_SCHEMA } = await import("./tools");
  const { agentBody, loadAgentConfig, DYNAMIC_VARIABLES } = await import("../../../scripts/elevenlabs-setup");
  const cfg = loadAgentConfig();
  const body = agentBody(cfg, ["tool_a", "tool_b"]);
  const everythingTheAgentSees = JSON.stringify({ body, TOOL_SCHEMA, DYNAMIC_VARIABLES });
  assert.equal(everythingTheAgentSees.includes(NEW_LAST4), false);
  assert.doesNotMatch(everythingTheAgentSees, /responder_?token|newLast4|new_last4/i);
  assert.deepEqual(TOOL_SCHEMA.map((t) => t.name), ["freeze_payment", "approve_payment"]);
  assert.deepEqual([...TOOL_SCHEMA[0].parameters.properties.outcome.enum], ["denied", "inconclusive"]);
  assert.deepEqual(Object.keys(TOOL_SCHEMA[1].parameters.properties), ["last4_read_back"]);
  // A browser holding a conversation token cannot swap the prompt, first message, LLM or tools.
  const agentOverrides = body.platform_settings.overrides.conversation_config_override.agent;
  assert.equal(agentOverrides.first_message, false);
  assert.deepEqual(Object.values(agentOverrides.prompt), [false, false, false, false, false]);
  assert.equal(body.platform_settings.auth.enable_auth, true);
  assert.equal(body.conversation_config.agent.prompt.temperature, 0);
});

test("readBackDigits accepts exactly four spoken or written digits and nothing else", async () => {
  const { readBackDigits } = await import("./tools");
  const cases: Array<[unknown, string]> = [
    ["9821", "9821"], ["9 8 2 1", "9821"], ["98-21", "9821"], ["Nine, eight, two, one.", "9821"], ["oh one two three", "0123"],
    ["98211", ""], ["982", ""], ["ends in 9821", ""], ["nineteen eighty", ""], [9821, ""], [null, ""], ["9".repeat(80), ""],
  ];
  for (const [input, expected] of cases) assert.equal(readBackDigits(input), expected, JSON.stringify(input));
});
