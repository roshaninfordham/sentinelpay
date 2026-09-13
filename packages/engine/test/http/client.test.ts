import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineError, type Verification } from "../../src/core/types";
import { createHandler, createHttpClient, SentinelPayHttpError } from "../../src/http";
import { callTool } from "../../src/tools";
import { AGENT, clean, poisoned, setup } from "../core/helpers";
import { BASE, authenticate } from "./helpers";

/** A client whose fetch goes straight into createHandler, recording every request it sends. */
function roundTrip(apiKey = "sk_agent") {
  const s = setup();
  const handler = createHandler(s.engine, { authenticate });
  const sent: Request[] = [];
  const client = createHttpClient({
    baseUrl: `${BASE}/`,
    apiKey,
    fetch: async (input, init) => {
      const req = new Request(input, init);
      sent.push(req.clone());
      return handler(req);
    },
  });
  return { ...s, client, sent };
}

test("createHttpClient round-trips verify, get, block and receipt through createHandler", async () => {
  const { client, engine, sent, starts } = roundTrip();
  const created = await client.verify(poisoned(), { idempotencyKey: "inv-2291" });
  assert.deepEqual([created.decision, created.requestedBy], ["WAIT", AGENT.id]);
  assert.equal(sent[0].method, "POST");
  assert.equal(new URL(sent[0].url).pathname, "/api/v1/verifications");
  assert.equal(sent[0].headers.get("authorization"), "Bearer sk_agent");
  assert.equal(sent[0].headers.get("idempotency-key"), "inv-2291");
  assert.deepEqual(await sent[0].json(), { payment: poisoned() });

  const same = await client.verify(poisoned(), { idempotencyKey: "inv-2291" });
  assert.equal(same.paymentId, created.paymentId);

  const polled = await client.get("pay_240k", { waitMs: 0, sinceVersion: created.version });
  assert.equal(polled.state, "CHALLENGING");
  assert.equal(new URL(sent.at(-1)!.url).search, `?waitMs=0&sinceVersion=${created.version}`);
  assert.ok(!JSON.stringify(polled).includes(starts[0].responderToken));

  const receipt = await client.receipt("pay_240k");
  assert.equal(receipt.verification.paymentId, "pay_240k");
  assert.equal(receipt.chain.ok, true);

  const blocked = await client.block("pay_240k", { reason: "suspected BEC" });
  assert.equal(blocked.decision, "DO_NOT_PAY");
  assert.deepEqual(await client.get("pay_240k"), await engine.get("pay_240k"));
});

test("HTTP errors come back as EngineError instances with code, status, path and nextActions", async () => {
  const { client } = roundTrip();
  await assert.rejects(client.get("pay_nope"), (e: unknown) => e instanceof EngineError && e.code === "NOT_FOUND" && e.httpStatus === 404);
  await assert.rejects(client.verify(clean({ vendorId: "v_ghost" })), (e: EngineError) => e.code === "VENDOR_UNKNOWN" && e.path === "/payment/vendorId");
  await assert.rejects(client.verify(clean({ amountCents: -5 })), (e: EngineError) => e.code === "INVALID_INPUT" && e.path === "/payment/amountCents");

  await client.verify(poisoned());
  await assert.rejects(client.verify(poisoned({ beneficiary: { accountLast4: "1234" } })), (e: EngineError) =>
    e.code === "IDEMPOTENCY_CONFLICT" && e.httpStatus === 409 && e.nextActions[0].type === "DO_NOT_PAY" && e.nextActions[1].type === "ESCALATE_TO_HUMAN");
});

test("401, non-JSON responses and network failures are SentinelPayHttpError and map to DO_NOT_PAY through callTool", async () => {
  const unauthorized = roundTrip("sk_revoked").client;
  await assert.rejects(unauthorized.get("pay_1"), (e: unknown) => e instanceof SentinelPayHttpError && e.status === 401 && e.code === "UNAUTHORIZED" && !e.retryable);

  const proxyError = createHttpClient({ baseUrl: BASE, apiKey: "k", fetch: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }) });
  await assert.rejects(proxyError.get("pay_1"), (e: SentinelPayHttpError) => e.status === 502 && e.retryable);
  const garbled = createHttpClient({ baseUrl: BASE, apiKey: "k", fetch: async () => new Response("not json", { status: 200 }) });
  await assert.rejects(garbled.get("pay_1"), (e: SentinelPayHttpError) => e.code === "INVALID_RESPONSE");
  const offline = createHttpClient({ baseUrl: BASE, apiKey: "k", fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(offline.verify(clean()), (e: SentinelPayHttpError) => e.code === "NETWORK_ERROR" && e.retryable);

  for (const api of [unauthorized, proxyError, offline]) {
    const r = await callTool(api, "verify_payment", { payment: clean() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.nextActions[0].type, "DO_NOT_PAY");
  }
});

test("callTool over the HTTP client returns the same envelope as callTool in-process", async () => {
  const remote = roundTrip();
  const local = setup();
  const viaHttp = await callTool(remote.client, "verify_payment", { payment: clean() });
  const inProcess = await callTool(local.engine, "verify_payment", { payment: clean() });
  assert.ok(viaHttp.ok && inProcess.ok);
  const strip = (v: Verification) => ({ ...v, proof: { ...v.proof, ledgerHeadHash: null } });
  assert.deepEqual(strip(viaHttp.result as Verification), strip(inProcess.result as Verification));

  const conflictRemote = await callTool(remote.client, "verify_payment", { payment: clean({ beneficiary: { accountLast4: "0000" } }) });
  const conflictLocal = await callTool(local.engine, "verify_payment", { payment: clean({ beneficiary: { accountLast4: "0000" } }) });
  assert.deepEqual(conflictRemote, conflictLocal);
});
