import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage } from "../../src/adapters/memory";
import { humanApprovalChallenger } from "../../src/challengers/human-approval";
import type { PayFirewall, Storage } from "../../src/core/types";
import { openApiDocument } from "../../src/http";
import { pendingChallenger } from "../../src/testing";
import { toolDefinitions } from "../../src/tools";
import { AGENT, APPROVER, OPERATOR, clean, eventsOf, poisoned, poisonedProbes, setup } from "../core/helpers";
import { compile } from "../tools/helpers";
import { BASE, handlerFor } from "./helpers";

/** Engine with a WAIT case already challenged; returns the captured responder token. */
async function challenged(overrides: Parameters<typeof setup>[0] = {}) {
  const s = setup(overrides);
  const call = handlerFor(s.engine);
  const created = await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });
  assert.equal(created.status, 201);
  const opened = await s.engine.advance("pay_240k");
  assert.equal(opened.state, "CHALLENGING");
  return { ...s, call, challengeId: opened.challenge!.challengeId, token: s.starts.at(-1)!.responderToken };
}

const errorCode = (r: { json?: { error?: { code?: string } } }) => r.json?.error?.code;

test("every authenticated route answers 401 UNAUTHORIZED without a valid API key", async () => {
  const s = setup();
  const call = handlerFor(s.engine);
  const routes: Array<[string, string, unknown?]> = [
    ["POST", "/verifications", { payment: clean() }],
    ["GET", "/verifications/pay_18k"],
    ["POST", "/verifications/pay_18k/block", { reason: "fraud" }],
    ["GET", "/verifications/pay_18k/receipt"],
    ["GET", "/ledger/verify"],
    ["POST", "/challenges/chl_x/result", { verdict: "DENIED" }],
  ];
  for (const [method, path, body] of routes) {
    for (const key of [undefined, "sk_wrong"]) {
      const r = await call(method, path, { key, body });
      assert.equal(r.status, 401, `${method} ${path} key=${key}`);
      assert.equal(errorCode(r), "UNAUTHORIZED");
      assert.equal(r.json.error.nextActions[0].type, "DO_NOT_PAY");
      assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer/);
    }
  }
  assert.equal((await s.storage.ledger()).length, 0);
});

test("POST /verifications: 201 created, 200 existing, ETag, Location and Retry-After on WAIT", async () => {
  const s = setup();
  const call = handlerFor(s.engine);
  const created = await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });
  assert.equal(created.status, 201);
  assert.equal(created.json.decision, "WAIT");
  assert.equal(created.json.requestedBy, AGENT.id);
  assert.equal(created.headers.get("etag"), `"${created.json.version}"`);
  assert.equal(created.headers.get("retry-after"), "1");
  assert.equal(created.headers.get("location"), "/api/v1/verifications/pay_240k");
  assert.ok(compile(openApiDocument().components.schemas.Verification)(created.json).ok);

  const again = await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });
  assert.equal(again.status, 200);
  assert.equal(again.json.paymentId, "pay_240k");
  assert.equal(again.headers.get("location"), null);

  const paid = await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean() } });
  assert.equal(paid.status, 201);
  assert.equal(paid.json.decision, "PAY");
  assert.equal(paid.headers.get("retry-after"), null);
});

test("POST /verifications: 400 with JSON pointer, 404 VENDOR_UNKNOWN, 409 IDEMPOTENCY_CONFLICT, Idempotency-Key header", async () => {
  const s = setup();
  const call = handlerFor(s.engine);
  const bad = await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean({ amountCents: 0 }) } });
  assert.equal(bad.status, 400);
  assert.deepEqual([errorCode(bad), bad.json.error.path], ["INVALID_INPUT", "/payment/amountCents"]);

  for (const body of [{ payment: clean(), principal: OPERATOR }, { payment: { ...clean(), requestedBy: "human:ops" } }]) {
    const r = await call("POST", "/verifications", { key: "sk_agent", body });
    assert.equal(r.status, 400);
    assert.match(r.json.error.path, /(principal|requestedBy)$/);
  }
  const notJson = await call("POST", "/verifications", { key: "sk_agent", rawBody: "{nope" });
  assert.deepEqual([notJson.status, errorCode(notJson)], [400, "INVALID_INPUT"]);
  const nullMemo = await call("POST", "/verifications", { key: "sk_agent", body: { payment: { ...clean(), memo: null } } });
  assert.deepEqual([nullMemo.status, nullMemo.json.error.path], [400, "/payment/memo"]);

  const ghost = await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean({ vendorId: "v_ghost" }) } });
  assert.deepEqual([ghost.status, errorCode(ghost)], [404, "VENDOR_UNKNOWN"]);

  assert.equal((await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } })).status, 201);
  const swapped = await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned({ beneficiary: { accountLast4: "0002" } }) } });
  assert.deepEqual([swapped.status, errorCode(swapped)], [409, "IDEMPOTENCY_CONFLICT"]);
  assert.deepEqual(swapped.json.error.nextActions.map((a: { type: string }) => a.type), ["DO_NOT_PAY", "ESCALATE_TO_HUMAN"]);
  assert.ok((await eventsOf(s.storage, "pay_240k")).includes("IDEMPOTENCY_CONFLICT"));

  const keyed = await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean({ id: "pay_a" }) }, headers: { "Idempotency-Key": "inv-2291" } });
  assert.equal(keyed.status, 201);
  const reusedKey = await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean({ id: "pay_b" }) }, headers: { "Idempotency-Key": "inv-2291" } });
  assert.deepEqual([reusedKey.status, errorCode(reusedKey)], [409, "IDEMPOTENCY_CONFLICT"]);
  const tooLong = await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean({ id: "pay_c" }) }, headers: { "Idempotency-Key": "k".repeat(256) } });
  assert.deepEqual([tooLong.status, tooLong.json.error.path], [400, "/idempotencyKey"]);
});

test("503 STORAGE_UNAVAILABLE is retryable and never PAY", async () => {
  const inner = memoryStorage();
  let down = false;
  const guard = <T>(fn: () => Promise<T>) => (down ? Promise.reject(new Error("disk on fire")) : fn());
  const storage: Storage = {
    load: (k) => guard(() => inner.load(k)), commit: (n, v, e) => guard(() => inner.commit(n, v, e)),
    ledger: (o) => guard(() => inner.ledger(o)), list: (f) => guard(() => inner.list(f)),
  };
  const s = setup({ storage });
  const call = handlerFor(s.engine);
  down = true;
  const r = await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean() } });
  assert.deepEqual([r.status, errorCode(r), r.json.error.retryable], [503, "STORAGE_UNAVAILABLE", true]);
  assert.deepEqual(r.json.error.nextActions.map((a: { type: string }) => a.type), ["DO_NOT_PAY", "RETRY"]);
  assert.ok(!r.text.includes("disk on fire"));
  const g = await call("GET", "/verifications/pay_18k", { key: "sk_agent" });
  assert.equal(g.status, 503);
});

test("GET /verifications/{id}: ETag, 304 on If-None-Match, Retry-After on WAIT, read scoping, query validation", async () => {
  const s = setup();
  const call = handlerFor(s.engine);
  await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });

  const first = await call("GET", "/verifications/pay_240k", { key: "sk_agent" });
  assert.equal(first.status, 200);
  assert.equal(first.json.state, "CHALLENGING", "GET advances pending steps lazily");
  const etag = first.headers.get("etag")!;
  assert.equal(etag, `"${first.json.version}"`);
  assert.equal(first.headers.get("retry-after"), "5");

  const notModified = await call("GET", "/verifications/pay_240k", { key: "sk_agent", headers: { "If-None-Match": etag } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.text, "");
  assert.equal(notModified.headers.get("etag"), etag);
  assert.equal(notModified.headers.get("retry-after"), "5");
  assert.equal((await call("GET", "/verifications/pay_240k", { key: "sk_agent", headers: { "If-None-Match": `W/${etag}, "999"` } })).status, 304);

  await s.engine.block("pay_240k", { reason: "stop" });
  const changed = await call("GET", "/verifications/pay_240k", { key: "sk_agent", headers: { "If-None-Match": etag } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.decision, "DO_NOT_PAY");
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal(changed.headers.get("retry-after"), null);

  assert.deepEqual([(await call("GET", "/verifications/pay_240k", { key: "sk_other" })).status], [404]);
  assert.equal((await call("GET", "/verifications/pay_240k", { key: "sk_ops" })).status, 200);
  assert.equal((await call("GET", "/verifications/pay_nope", { key: "sk_agent" })).status, 404);

  for (const [query, path] of [["?waitMs=abc", "/waitMs"], ["?waitMs=25001", "/waitMs"], ["?sinceVersion=-1", "/sinceVersion"]]) {
    const r = await call("GET", `/verifications/pay_240k${query}`, { key: "sk_agent" });
    assert.deepEqual([r.status, r.json.error.path], [400, path], query);
  }
  const badId = await call("GET", `/verifications/${encodeURIComponent("bad|id")}`, { key: "sk_agent" });
  assert.deepEqual([badId.status, badId.json.error.path], [400, "/paymentId"]);
});

test("POST /verifications/{id}/block and GET /verifications/{id}/receipt", async () => {
  const s = setup();
  const call = handlerFor(s.engine);
  await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });

  const short = await call("POST", "/verifications/pay_240k/block", { key: "sk_agent", body: { reason: "no" } });
  assert.deepEqual([short.status, short.json.error.path], [400, "/reason"]);
  const extra = await call("POST", "/verifications/pay_240k/block", { key: "sk_agent", body: { reason: "fraud", resolvedBy: "human:ops" } });
  assert.deepEqual([extra.status, extra.json.error.path], [400, "/resolvedBy"]);
  assert.equal((await call("POST", "/verifications/pay_ghost/block", { key: "sk_agent", body: { reason: "fraud" } })).status, 404);

  // Block is open to any authenticated principal, but a non-owner gets the same 404 as for a missing case.
  const blocked = await call("POST", "/verifications/pay_240k/block", { key: "sk_other", body: { reason: "suspected BEC" } });
  assert.deepEqual([blocked.status, errorCode(blocked)], [404, "NOT_FOUND"]);
  assert.ok(!blocked.text.includes("meridian-global.co"));
  const owned = await call("GET", "/verifications/pay_240k", { key: "sk_agent" });
  assert.deepEqual([owned.json.decision, owned.json.reason, owned.json.challenge], ["DO_NOT_PAY", "BLOCKED_BY_PRINCIPAL", undefined]);

  const receipt = await call("GET", "/verifications/pay_240k/receipt", { key: "sk_agent" });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json.verification.reason, "BLOCKED_BY_PRINCIPAL");
  assert.equal(receipt.json.chain.ok, true);
  assert.ok(compile(openApiDocument().components.schemas.Receipt)(receipt.json).ok);
  assert.equal((await call("GET", "/verifications/pay_240k/receipt", { key: "sk_other" })).status, 404);

  const ledger = await call("GET", "/ledger/verify", { key: "sk_other" });
  assert.equal(ledger.status, 200);
  assert.equal(ledger.json.ok, true);
  assert.equal(ledger.json.length, (await s.storage.ledger()).length);
});

test("result route: token-only AUTHORIZED clears; the requester's API key can never authorize", async () => {
  const s = await challenged();
  const apiKey = await s.call("POST", `/challenges/${s.challengeId}/result`, { key: "sk_agent", body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([apiKey.status, errorCode(apiKey)], [403, "RESPONDER_TOKEN_REQUIRED"]);
  const operatorKey = await s.call("POST", `/challenges/${s.challengeId}/result`, { key: "sk_ops", body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([operatorKey.status, errorCode(operatorKey)], [403, "RESPONDER_TOKEN_REQUIRED"]);
  const none = await s.call("POST", `/challenges/${s.challengeId}/result`, { body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([none.status, errorCode(none)], [403, "RESPONDER_TOKEN_REQUIRED"]);
  assert.ok(!(await eventsOf(s.storage)).includes("RESPONDER_TOKEN_REJECTED"), "API-key attempts do not burn token attempts");

  const inBody = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "AUTHORIZED", responderToken: s.token } });
  assert.deepEqual([inBody.status, errorCode(inBody)], [400, "INVALID_INPUT"]);
  const identity = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "AUTHORIZED", resolvedBy: APPROVER.id } });
  assert.deepEqual([identity.status, identity.json.error.path], [400, "/resolvedBy"]);

  const ok = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "AUTHORIZED", answers: { authorizedChange: "yes" } } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.state, ok.json.decision, ok.json.reason], ["CLEARED", "PAY", "VENDOR_CONFIRMED_CHANGE"]);
  assert.equal(ok.json.challenge.resolvedBy, "channel:scripted");
  const replay = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([replay.status, replay.json.version], [200, ok.json.version]);
});

test("result route: bad tokens give 401 and are logged; unknown challenges look the same", async () => {
  const s = await challenged();
  const wrong = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: "not-the-token", body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([wrong.status, errorCode(wrong)], [401, "RESPONDER_TOKEN_INVALID"]);
  assert.ok((await eventsOf(s.storage)).includes("RESPONDER_TOKEN_REJECTED"));
  const unknown = await s.call("POST", "/challenges/chl_does_not_exist/result", { bearer: s.token, body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([unknown.status, errorCode(unknown)], [401, "RESPONDER_TOKEN_INVALID"]);
  assert.equal(unknown.json.error.message, wrong.json.error.message);
});

test("result route: an approver session is the responder; the requester's own session is SELF_APPROVAL_FORBIDDEN", async () => {
  const s = await challenged();
  const self = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, cookie: "session=agent", body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([self.status, errorCode(self)], [403, "SELF_APPROVAL_FORBIDDEN"]);
  assert.ok((await eventsOf(s.storage)).includes("RESPONDER_TOKEN_REJECTED"));
  assert.equal((await s.engine.get("pay_240k")).state, "CHALLENGING");

  const approved = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, cookie: "session=approver", body: { verdict: "AUTHORIZED" } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.challenge.resolvedBy, APPROVER.id);
});

test("result route: requireApproverSession refuses token-only AUTHORIZED with 403", async () => {
  const starts: Array<{ responderToken: string }> = [];
  const s = setup({ challengers: [pendingChallenger((r) => starts.push(r), { requireApproverSession: true })] });
  const call = handlerFor(s.engine);
  await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });
  const { challenge } = await s.engine.advance("pay_240k");
  const r = await call("POST", `/challenges/${challenge!.challengeId}/result`, { bearer: starts[0].responderToken, body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([r.status, errorCode(r)], [403, "RESPONDER_TOKEN_REQUIRED"]);
});

test("result route: DENIED/INCONCLUSIVE need an API key and move toward safety", async () => {
  const s = await challenged();
  const anonymous = await s.call("POST", `/challenges/${s.challengeId}/result`, { body: { verdict: "DENIED" } });
  assert.equal(anonymous.status, 401);
  const tokenOnly = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "DENIED" } });
  assert.equal(tokenOnly.status, 401);
  const badVerdict = await s.call("POST", `/challenges/${s.challengeId}/result`, { key: "sk_agent", body: { verdict: "APPROVED" } });
  assert.deepEqual([badVerdict.status, badVerdict.json.error.path], [400, "/verdict"]);

  const denied = await s.call("POST", `/challenges/${s.challengeId}/result`, {
    key: "sk_other", body: { verdict: "DENIED", answers: { authorizedChange: "no" }, evidence: { transcript: "controller: we changed nothing", tool: null } },
  });
  assert.equal(denied.status, 200);
  assert.deepEqual([denied.json.decision, denied.json.reason, denied.json.challenge.resolvedBy], ["DO_NOT_PAY", "VENDOR_DENIED_CHANGE", "agent:other-bot"]);
  const late = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([late.status, late.json.decision], [200, "DO_NOT_PAY"], "a late AUTHORIZED sees the terminal case unchanged");
  const missing = await s.call("POST", "/challenges/chl_missing/result", { key: "sk_agent", body: { verdict: "INCONCLUSIVE" } });
  assert.deepEqual([missing.status, errorCode(missing)], [404, "NOT_FOUND"]);
});

test("result route: 409 when fixture data blocks a production clear, 410 after expiry", async () => {
  const links: string[] = [];
  const prod = setup({
    environment: "production", allowTestChallengers: undefined, probes: poisonedProbes("fixture"),
    challengers: [humanApprovalChallenger({ approvalBaseUrl: "https://app.example/approve", deliver: async (m) => { links.push(m.url); } })],
  });
  const call = handlerFor(prod.engine);
  await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });
  const { challenge } = await prod.engine.advance("pay_240k");
  const token = links[0].split("#t=")[1];
  const blocked = await call("POST", `/challenges/${challenge!.challengeId}/result`, {
    bearer: token, cookie: "session=approver", body: { verdict: "AUTHORIZED", answers: { beneficiaryLast4ReadBack: "9821" } },
  });
  assert.deepEqual([blocked.status, errorCode(blocked)], [409, "INVALID_TRANSITION"]);

  const s = await challenged();
  s.clock.advance(900_000);
  const expired = await s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "AUTHORIZED" } });
  assert.deepEqual([expired.status, errorCode(expired)], [410, "CHALLENGE_EXPIRED"]);
  assert.equal((await s.engine.get("pay_240k")).reason, "CHALLENGE_EXPIRED");
});

test("an api without the responder ingress serves 404 for the result and ledger routes", async () => {
  const s = setup();
  const requesterOnly: PayFirewall = {
    verify: (p, o) => s.engine.verify(p, o), get: (id, o) => s.engine.get(id, o),
    block: (id, o) => s.engine.block(id, o), receipt: (id, o) => s.engine.receipt(id, o),
  };
  const call = handlerFor(requesterOnly);
  assert.equal((await call("POST", "/verifications", { key: "sk_agent", body: { payment: clean() } })).status, 201);
  assert.equal((await call("POST", "/challenges/chl_x/result", { bearer: "t", body: { verdict: "AUTHORIZED" } })).status, 404);
  assert.equal((await call("GET", "/ledger/verify", { key: "sk_agent" })).status, 404);
});

test("public routes: /tools is the requester toolset only, /openapi.json is OpenAPI 3.1, /health; unknown routes 404", async () => {
  const s = setup();
  let authCalls = 0;
  const call = handlerFor(s.engine, {
    authenticate: async () => { authCalls++; return null; },
    health: () => ({ environment: "test", storage: "memory", rail: "none", probes: [{ id: "rdap", origin: "live" }], challengers: [{ channel: "scripted", assurance: "test" }] }),
  });

  const tools = await call("GET", "/tools");
  assert.equal(tools.status, 200);
  assert.deepEqual(tools.json, JSON.parse(JSON.stringify(toolDefinitions)));
  assert.ok(!/challenges|\/result|AUTHORIZED|responderToken/.test(tools.text), "/tools exposes the responder route");

  const openapi = await call("GET", "/openapi.json");
  assert.equal(openapi.status, 200);
  assert.equal(openapi.json.openapi, "3.1.0");
  assert.deepEqual(Object.keys(openapi.json.paths).sort(), [
    "/challenges/{challengeId}/result", "/health", "/ledger/verify", "/openapi.json", "/tools",
    "/verifications", "/verifications/{paymentId}", "/verifications/{paymentId}/block", "/verifications/{paymentId}/receipt",
  ]);
  assert.deepEqual(openapi.json.components.schemas.Verification, JSON.parse(JSON.stringify(toolDefinitions[0].outputSchema)));
  assert.deepEqual(openapi.json.components.schemas.VerifyPaymentRequest, JSON.parse(JSON.stringify(toolDefinitions[0].inputSchema)));
  for (const [name, schema] of Object.entries(openapi.json.components.schemas)) assert.doesNotThrow(() => compile(schema as never), name);

  const health = await call("GET", "/health");
  assert.deepEqual([health.status, health.json.environment, health.json.challengers[0].channel], [200, "test", "scripted"]);
  assert.equal(authCalls, 0, "public routes never authenticate");

  assert.equal((await handlerFor(s.engine)("GET", "/health")).json.environment, "unknown");
  assert.equal((await call("GET", "/nope")).status, 404);
  assert.equal((await call("DELETE", "/verifications/pay_1")).status, 404);
  const outside = await handlerFor(s.engine)("GET", "/../../other");
  assert.equal(outside.status, 404);
});

test("basePath is configurable and schedule receives a background advance for WAIT", async () => {
  const s = setup();
  const scheduled: Array<Promise<unknown>> = [];
  const call = handlerFor(s.engine, { basePath: "/v1/", schedule: (w) => { scheduled.push(w); } });
  const wrongBase = await call("POST", "/verifications", { key: "sk_agent", body: { payment: poisoned() } });
  assert.equal(wrongBase.status, 404, `${BASE} is not under /v1`);

  const { createHandler } = await import("../../src/http");
  const handler = createHandler(s.engine, { basePath: "/v1/", authenticate: async () => AGENT, schedule: (w) => { scheduled.push(w); } });
  const res = await handler(new Request("https://x.test/v1/verifications", { method: "POST", body: JSON.stringify({ payment: poisoned() }) }));
  assert.equal(res.status, 201);
  assert.equal(scheduled.length, 1);
  await Promise.all(scheduled);
  assert.equal((await s.engine.get("pay_240k", { principal: AGENT })).state, "CHALLENGING");

  await handler(new Request("https://x.test/v1/verifications", { method: "POST", body: JSON.stringify({ payment: clean() }) }));
  assert.equal(scheduled.length, 1, "PAY is not scheduled");
});

test("the responder token appears in no HTTP response", async () => {
  const s = await challenged();
  const texts: string[] = [];
  const record = async (p: ReturnType<typeof s.call>) => texts.push((await p).text);
  await record(s.call("GET", "/verifications/pay_240k", { key: "sk_agent" }));
  await record(s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: `${s.token}x`, body: { verdict: "AUTHORIZED" } }));
  await record(s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, cookie: "session=agent", body: { verdict: "AUTHORIZED" } }));
  await record(s.call("POST", `/challenges/${s.challengeId}/result`, { bearer: s.token, body: { verdict: "AUTHORIZED" } }));
  await record(s.call("GET", "/verifications/pay_240k/receipt", { key: "sk_agent" }));
  await record(s.call("GET", "/openapi.json"));
  assert.ok(texts.join("").length > 1000);
  assert.ok(!texts.join("").includes(s.token));
});
