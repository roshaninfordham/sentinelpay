import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage } from "../../src/adapters/memory";
import { fixedClock, pendingChallenger, scriptedChallenger, seqIds } from "../../src/testing";
import type { Challenger } from "../../src/core/types";
import { AGENT, APPROVER, FP_KEY, MERIDIAN, OPERATOR, REGISTRY_PHONE, T0, clean, code, eventsOf, poisoned, setup, spyRail } from "./helpers";

const DENY_CHAIN = ["INTERCEPTED", "INVESTIGATION_STARTED", "FORENSICS", "CHALLENGE_STARTED", "CALL_RESULT", "FROZEN"];

test("gate match: CLEARED immediately, PAY with recheck, one CLEARED ledger entry", async () => {
  const { engine, storage } = setup();
  const v = await engine.verify(clean());
  assert.equal(v.state, "CLEARED");
  assert.equal(v.decision, "PAY");
  assert.equal(v.reason, "BENEFICIARY_MATCHES_VENDOR_MASTER");
  assert.equal(v.mayRelease, true);
  assert.equal(v.rail.status, "NOT_CONFIGURED");
  assert.equal(v.nextActions[0].type, "PAY");
  assert.deepEqual(await eventsOf(storage), ["CLEARED"]);
  assert.equal(v.proof.ledgerLength, 1);
});

test("full deny pipeline ends QUARANTINED with exactly the 6-event chain", async () => {
  const { engine, storage, starts, events } = setup();
  const v1 = await engine.verify(poisoned());
  assert.equal(v1.version, 1);
  assert.equal(v1.state, "PENDING_REVIEW");
  assert.equal(v1.decision, "WAIT");
  assert.equal(v1.reason, "UNDER_INVESTIGATION");
  assert.equal(v1.nextActions[0].type, "POLL");
  assert.equal(v1.requestedBy, AGENT.id);
  assert.deepEqual(v1.mismatches.map((m) => m.code), ["BENEFICIARY_CHANGED", "DOMAIN_MISMATCH"]);

  const v2 = await engine.advance("pay_240k");
  assert.equal(v2.state, "CHALLENGING");
  assert.equal(v2.reason, "AWAITING_OUT_OF_BAND_CONFIRMATION");
  assert.equal(v2.risk?.score, 90);
  assert.equal(v2.risk?.level, "CRITICAL");
  assert.deepEqual(v2.risk?.reasons, ["DOMAIN_YOUNG", "ENTITY_NOT_LINKED", "INVOICE_PHONE_MISMATCH"]);
  assert.equal(v2.challenge?.dialMasked, "(312) •••-0198");
  assert.deepEqual(v2.nextActions.map((a) => a.type), ["POLL", "AWAIT_OUT_OF_BAND", "DO_NOT_PAY"]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].callbackPhone, REGISTRY_PHONE);

  const v3 = await engine.resolveChallenge({ challengeId: starts[0].challengeId, verdict: "DENIED", evidence: { tool: "freeze_payment" } });
  assert.equal(v3.state, "QUARANTINED");
  assert.equal(v3.decision, "DO_NOT_PAY");
  assert.equal(v3.reason, "VENDOR_DENIED_CHANGE");
  assert.equal(v3.terminal, true);
  assert.deepEqual(await eventsOf(storage, "pay_240k"), DENY_CHAIN);
  assert.deepEqual(await engine.verifyLedger(), { ok: true, length: 6 });

  const receipt = await engine.receipt("pay_240k");
  assert.deepEqual(receipt.entries.map((e) => e.event), DENY_CHAIN);
  assert.equal(receipt.chain.ok, true);
  assert.equal(receipt.headHash, receipt.verification.proof.ledgerHeadHash);
  assert.equal(receipt.incidentId, "INC-PAY_240K");

  assert.deepEqual(events.filter((e) => e.type === "state").map((e) => e.type === "state" && `${e.from}>${e.to}`), [
    "RECEIVED>PENDING_REVIEW", "PENDING_REVIEW>INVESTIGATING", "INVESTIGATING>CHALLENGING", "CHALLENGING>QUARANTINED",
  ]);
});

test("authorize with the token: CLEARED is committed before rail.release (spy rail), then RAIL_RELEASED", async () => {
  const storage = memoryStorage();
  const rail = spyRail(() => storage.ledger(), "9821");
  const s = setup({ storage, rail });
  await s.engine.verify(poisoned());
  await s.engine.advance("pay_240k");
  const { challengeId, responderToken } = s.starts[0];

  const v = await s.engine.resolveChallenge({ challengeId, verdict: "AUTHORIZED", responderToken, responder: APPROVER });
  assert.equal(rail.releases.length, 1);
  const [release] = rail.releases;
  assert.ok(release.ledgerAtRelease.includes("CLEARED"), "CLEARED must already be committed when release runs");
  assert.ok(!release.ledgerAtRelease.includes("RAIL_RELEASED"));
  assert.equal(release.idempotencyKey, "payfirewall-pay_240k");

  assert.equal(v.state, "CLEARED");
  assert.equal(v.decision, "PAY");
  assert.equal(v.reason, "RAIL_RELEASED");
  assert.deepEqual(v.rail, { status: "RELEASED", reference: "wire_1" });
  assert.equal(v.nextActions[0].type === "PAY" && v.nextActions[0].railReference, "wire_1");
  assert.deepEqual(await eventsOf(storage, "pay_240k"), [...DENY_CHAIN.slice(0, 5), "CLEARED", "RAIL_RELEASED"]);
  const callResult = (await storage.ledger()).find((e) => e.event === "CALL_RESULT")!.payload as Record<string, unknown>;
  assert.equal(callResult.authorizedWithToken, true);
  assert.equal(callResult.resolvedBy, APPROVER.id);
  assert.equal((await s.engine.verifyLedger()).ok, true);
});

test("rail release failure keeps PAY with RETRY; re-verify retries only the release with the same key", async () => {
  const storage = memoryStorage();
  const rail = spyRail(() => storage.ledger(), "4471");
  rail.failNextRelease();
  const s = setup({ storage, rail });
  const v1 = await s.engine.verify(clean());
  assert.equal(v1.decision, "PAY");
  assert.equal(v1.reason, "RAIL_RELEASE_FAILED");
  assert.equal(v1.rail.status, "FAILED");
  assert.equal(v1.rail.reference, undefined);
  assert.deepEqual(v1.nextActions.map((a) => a.type), ["RETRY", "ESCALATE_TO_HUMAN"]);

  const v2 = await s.engine.verify(clean());
  assert.deepEqual(v2.rail, { status: "RELEASED", reference: "wire_2" });
  assert.deepEqual(rail.releases.map((r) => r.idempotencyKey), ["payfirewall-pay_18k", "payfirewall-pay_18k"]);
  assert.deepEqual(await eventsOf(storage), ["CLEARED", "RAIL_ERROR", "RAIL_RELEASED"]);
});

test("retryRelease retries a failed rail release once with the same key, and is a no-op otherwise", async () => {
  const storage = memoryStorage();
  const rail = spyRail(() => storage.ledger(), "4471");
  rail.failNextRelease();
  const s = setup({ storage, rail });
  assert.equal((await s.engine.verify(clean())).rail.status, "FAILED");

  const retried = await s.engine.retryRelease("pay_18k");
  assert.deepEqual([retried.decision, retried.rail.status, retried.rail.reference], ["PAY", "RELEASED", "wire_2"]);
  assert.deepEqual(rail.releases.map((r) => r.idempotencyKey), ["payfirewall-pay_18k", "payfirewall-pay_18k"]);

  // Already released: nothing is sent again.
  await s.engine.retryRelease("pay_18k");
  assert.equal(rail.releases.length, 2);
  assert.deepEqual(await eventsOf(storage), ["CLEARED", "RAIL_ERROR", "RAIL_RELEASED"]);
});

test("retryRelease never releases after beneficiary drift", async () => {
  const storage = memoryStorage();
  const rail = spyRail(() => storage.ledger(), "4471");
  const s = setup({ storage, rail });
  rail.setBeneficiary("4471");
  const read = rail.readBeneficiary!.bind(rail);
  let reads = 0;
  rail.readBeneficiary = async (p) => (++reads === 1 ? read(p) : { accountLast4: "0000" });
  const v = await s.engine.verify(clean());
  assert.deepEqual([v.decision, v.reason], ["DO_NOT_PAY", "RAIL_BENEFICIARY_DRIFT"]);
  const after = await s.engine.retryRelease("pay_18k");
  assert.deepEqual([after.decision, after.reason], ["DO_NOT_PAY", "RAIL_BENEFICIARY_DRIFT"]);
  assert.equal(rail.releases.length, 0);
});

test("scripted challenger resolves inside advance", async () => {
  const { engine, storage } = setup({ challengers: [scriptedChallenger("DENIED")] });
  await engine.verify(poisoned());
  const v = await engine.advance("pay_240k");
  assert.equal(v.state, "QUARANTINED");
  assert.equal(v.reason, "VENDOR_DENIED_CHANGE");
  assert.deepEqual(await eventsOf(storage), DENY_CHAIN);
});

test("verify with waitMs runs the pipeline inline up to the wait", async () => {
  const { engine } = setup({ challengers: [scriptedChallenger("INCONCLUSIVE")] });
  const v = await engine.verify(poisoned(), { waitMs: 2000 });
  assert.equal(v.state, "QUARANTINED");
  assert.equal(v.reason, "CHALLENGE_INCONCLUSIVE");
});

test("get long-polls until the version passes sinceVersion", async () => {
  const { engine, starts } = setup();
  await engine.verify(poisoned());
  const opened = await engine.advance("pay_240k");
  setTimeout(() => void engine.resolveChallenge({ challengeId: starts[0].challengeId, verdict: "DENIED" }), 50);
  const v = await engine.get("pay_240k", { waitMs: 3000, sinceVersion: opened.version });
  assert.equal(v.state, "QUARANTINED");
  assert.ok(v.version > opened.version);
});

test("block moves a non-terminal case to QUARANTINED and is a no-op on terminal cases", async () => {
  const { engine, storage } = setup();
  await engine.verify(poisoned());
  await engine.advance("pay_240k");
  const blocked = await engine.block("pay_240k", { reason: "looks like BEC" });
  assert.equal(blocked.state, "QUARANTINED");
  assert.equal(blocked.reason, "BLOCKED_BY_PRINCIPAL");
  assert.equal(blocked.challenge?.verdict, "DENIED");
  const call = (await storage.ledger()).find((e) => e.event === "CALL_RESULT")!.payload as Record<string, unknown>;
  assert.deepEqual([call.verdict, call.tool, call.reason, call.resolvedBy], ["DENIED", null, "BLOCKED_BY_PRINCIPAL", AGENT.id]);

  const again = await engine.block("pay_240k", { reason: "again" });
  assert.equal(again.version, blocked.version);
  const cleared = await engine.verify(clean());
  const noop = await engine.block("pay_18k", { reason: "too late" });
  assert.equal(noop.state, "CLEARED");
  assert.equal(noop.version, cleared.version);
});

test("terminal cases are immutable: late verdicts return the case unchanged", async () => {
  const { engine, starts } = setup();
  await engine.verify(poisoned());
  await engine.advance("pay_240k");
  const denied = await engine.resolveChallenge({ challengeId: starts[0].challengeId, verdict: "DENIED" });
  const late = await engine.resolveChallenge({ challengeId: starts[0].challengeId, verdict: "AUTHORIZED", responderToken: starts[0].responderToken });
  assert.equal(late.state, "QUARANTINED");
  assert.equal(late.version, denied.version);
  const replay = await engine.resolveChallenge({ challengeId: starts[0].challengeId, verdict: "DENIED" });
  assert.equal(replay.version, denied.version);
});

test("challenger.poll resolves a pending challenge during get", async () => {
  let answer: { verdict: "DENIED" } | null = null;
  const polling: Challenger = { ...pendingChallenger(), poll: async () => answer };
  const { engine } = setup({ challengers: [polling] });
  await engine.verify(poisoned());
  assert.equal((await engine.advance("pay_240k")).state, "CHALLENGING");
  answer = { verdict: "DENIED" };
  const v = await engine.get("pay_240k");
  assert.equal(v.state, "QUARANTINED");
  assert.equal(v.challenge?.resolvedBy, "channel:scripted");
});

test("challenger.start failures are retried on advance, then fail closed as CHALLENGE_INCONCLUSIVE", async () => {
  let calls = 0;
  const flaky: Challenger = { ...pendingChallenger(), start: async () => { calls++; throw new Error("delivery failed"); } };
  const { engine, storage } = setup({ challengers: [flaky], ids: seqIds() });
  await engine.verify(poisoned());
  assert.equal((await engine.advance("pay_240k")).state, "CHALLENGING");
  assert.equal((await engine.advance("pay_240k")).state, "CHALLENGING");
  const v = await engine.advance("pay_240k");
  assert.equal(calls, 3);
  assert.equal(v.state, "QUARANTINED");
  assert.equal(v.reason, "CHALLENGE_INCONCLUSIVE");
  assert.equal(v.challenge?.challengeId, "chl_0001");
  assert.deepEqual((await eventsOf(storage)).slice(-2), ["CALL_RESULT", "FROZEN"]);
});

test("sweep advances pending cases and expires stale challenges", async () => {
  const { engine, clock, config } = setup();
  await engine.verify(poisoned());
  await engine.verify(poisoned({ id: "pay_other", beneficiary: { accountLast4: "7777" } }));
  assert.deepEqual(await engine.sweep(), { advanced: 2, expired: 0 });
  clock.advance(config.challengeTtlMs ?? 900_000);
  assert.deepEqual(await engine.sweep(), { advanced: 0, expired: 2 });
});

test("read scoping: another requester gets NOT_FOUND; an operator may read", async () => {
  const { engine } = setup();
  await engine.verify(poisoned());
  const stranger = { id: "agent:other", kind: "agent" as const, roles: ["requester" as const] };
  await assert.rejects(engine.get("pay_240k", { principal: stranger }), code("NOT_FOUND"));
  await assert.rejects(engine.receipt("pay_240k", { principal: stranger }), code("NOT_FOUND"));
  await assert.rejects(engine.get("pay_missing"), code("NOT_FOUND"));
  assert.equal((await engine.withPrincipal(OPERATOR).get("pay_240k")).paymentId, "pay_240k");
});

test("identical re-verify returns the same case with no new ledger entries", async () => {
  const { engine, storage } = setup();
  const v1 = await engine.verify(poisoned());
  const v2 = await engine.verify(poisoned());
  assert.equal(v2.version, v1.version);
  assert.deepEqual(await eventsOf(storage), ["INTERCEPTED"]);
});

test("unknown vendor gives VENDOR_UNKNOWN and creates no case", async () => {
  const { engine, storage } = setup();
  await assert.rejects(engine.verify(poisoned({ vendorId: "v_nobody" })), (e: { code?: string; httpStatus?: number }) => e.code === "VENDOR_UNKNOWN" && e.httpStatus === 404);
  assert.equal(await storage.load({ paymentId: "pay_240k" }), null);
  assert.deepEqual(await eventsOf(storage), []);
});

test("storage failure gives retryable 503 STORAGE_UNAVAILABLE with [DO_NOT_PAY, RETRY], never PAY", async () => {
  const broken = memoryStorage();
  broken.load = async () => { throw new Error("connection reset"); };
  const { engine } = setup({ storage: broken });
  await assert.rejects(engine.verify(clean()), (e: { code?: string; httpStatus?: number; retryable?: boolean; nextActions?: Array<{ type: string }> }) =>
    e.code === "STORAGE_UNAVAILABLE" && e.httpStatus === 503 && e.retryable === true &&
    JSON.stringify(e.nextActions?.map((a) => a.type)) === JSON.stringify(["DO_NOT_PAY", "RETRY"]));
});

test("accountNumber is fingerprinted, never stored, and a matching fingerprint clears", async () => {
  const { fingerprintAccount } = await import("../../src/core/hash");
  const key = "fingerprint-key-for-tests-0123456789";
  const vendor = { ...MERIDIAN, knownAccountFingerprint: await fingerprintAccount(key, "021000021", "000000004471") };
  const clock = fixedClock(T0);
  const storage = memoryStorage();
  const { engine } = setup({ storage, clock: clock.now, secrets: { tokenPepper: "p".repeat(32), fingerprintKey: key }, vendors: { get: async () => vendor } });
  const v = await engine.verify(clean({ beneficiary: { accountLast4: "4471", accountNumber: "000000004471", routingNumber: "021000021" } }));
  assert.equal(v.state, "CLEARED");
  assert.equal(v.beneficiary.strength, "fingerprint");
  assert.ok(!JSON.stringify(await storage.load({ paymentId: "pay_18k" })).includes("000000004471"));
  assert.ok(!JSON.stringify(await storage.ledger()).includes("000000004471"));
});

test("RETRY nextAction args re-verify as-is when the payment carried accountNumber (DX-1)", async () => {
  const storage = memoryStorage();
  const rail = spyRail(() => storage.ledger(), "4471");
  delete (rail as Partial<typeof rail>).readBeneficiary; // the caller's beneficiary is what gets verified
  rail.failNextRelease();
  const s = setup({ storage, rail, secrets: { tokenPepper: "p".repeat(32), fingerprintKey: FP_KEY } });
  const beneficiary = { accountLast4: "4471", accountNumber: "0000004471", routingNumber: "021000021" };
  const v1 = await s.engine.verify(clean({ beneficiary }));
  assert.deepEqual([v1.decision, v1.reason], ["PAY", "RAIL_RELEASE_FAILED"]);
  const retry = v1.nextActions[0];
  assert.ok(retry.type === "RETRY");
  assert.equal("accountNumber" in retry.args.payment.beneficiary, false);

  const v2 = await s.engine.verify(retry.args.payment);
  assert.deepEqual([v2.decision, v2.reason, v2.rail.reference], ["PAY", "RAIL_RELEASED", "wire_2"]);
  assert.ok(!(await eventsOf(storage)).includes("IDEMPOTENCY_CONFLICT"));

  // A different full account with the same last 4 is still a changed request.
  await assert.rejects(s.engine.verify(clean({ beneficiary: { ...beneficiary, accountNumber: "9999994471" } })), code("IDEMPOTENCY_CONFLICT"));
});

test("RETRY nextAction args re-verify as-is when the rail overrode the claimed last4", async () => {
  const storage = memoryStorage();
  const rail = spyRail(() => storage.ledger(), "9821");
  const s = setup({ storage, rail });
  await s.engine.verify(poisoned({ beneficiary: { accountLast4: "4471" } }));
  await s.engine.advance("pay_240k");
  rail.failNextRelease();
  const { challengeId, responderToken } = s.starts[0];
  const v1 = await s.engine.resolveChallenge({ challengeId, verdict: "AUTHORIZED", responderToken, responder: APPROVER });
  assert.deepEqual([v1.decision, v1.reason], ["PAY", "RAIL_RELEASE_FAILED"]);
  const retry = v1.nextActions[0];
  assert.ok(retry.type === "RETRY");
  const v2 = await s.engine.verify(retry.args.payment);
  assert.deepEqual([v2.decision, v2.reason], ["PAY", "RAIL_RELEASED"]);
  // The originally submitted request is still the same request, too.
  assert.equal((await s.engine.verify(poisoned({ beneficiary: { accountLast4: "4471" } }))).version, v2.version);
});
