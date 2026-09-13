import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionFor, errorNextActions, mustNotFor, nextActionsFor, reasonFor } from "../../src/core/next-actions";
import type { CaseRecord, PaymentState, ReasonCode } from "../../src/core/types";

const EXPIRES = "2026-09-12T18:15:00.000Z";

function kase(state: PaymentState, extra: Partial<CaseRecord> = {}): CaseRecord {
  return {
    paymentId: "pay_240k", version: 4, idempotencyKey: "pay_240k", requestFingerprint: "f", requestedBy: "agent:ap-bot",
    payment: {
      id: "pay_240k", vendorId: "v_meridian", amountCents: 24_000_000, currency: "USD",
      beneficiary: { accountLast4: "9821", accountFingerprint: "fp", routingNumber: "021000021" }, requestSourceDomain: "meridian-global.co",
    },
    vendorSnapshot: { id: "v_meridian", legalName: "Meridian", knownDomain: "meridianglobal.com", knownBankLast4: "4471" },
    state, reason: "UNDER_INVESTIGATION", mismatches: [], rail: { status: "NOT_CONFIGURED" }, updatedAt: EXPIRES,
    ...extra,
  };
}

const challenge = {
  challengeId: "chl_k3v9", channel: "human_approval", assurance: "out_of_band" as const, status: "OPEN" as const, expiresAt: EXPIRES,
  responderTokenHash: "h", badTokenAttempts: 0, startAttempts: 1,
};

const summary = (c: CaseRecord) => ({ decision: decisionFor(c), reason: reasonFor(c), nextActions: nextActionsFor(c) });

const poll = (afterMs: number) => ({ type: "POLL", tool: "get_verification", args: { paymentId: "pay_240k", waitMs: 10000, sinceVersion: 4 }, afterMs });

test("§5.2 row: RECEIVED / PENDING_REVIEW / INVESTIGATING → WAIT, UNDER_INVESTIGATION, [POLL 1000, DO_NOT_PAY]", () => {
  for (const state of ["RECEIVED", "PENDING_REVIEW", "INVESTIGATING"] as const) {
    assert.deepEqual(summary(kase(state)), {
      decision: "WAIT", reason: "UNDER_INVESTIGATION",
      nextActions: [poll(1000), { type: "DO_NOT_PAY", reason: "UNDER_INVESTIGATION", terminal: false }],
    });
  }
});

test("§5.2 row: CHALLENGING, OPEN → WAIT, AWAITING_OUT_OF_BAND_CONFIRMATION, [POLL 5000, AWAIT_OUT_OF_BAND, DO_NOT_PAY]", () => {
  assert.deepEqual(summary(kase("CHALLENGING", { reason: "AWAITING_OUT_OF_BAND_CONFIRMATION", challenge })), {
    decision: "WAIT", reason: "AWAITING_OUT_OF_BAND_CONFIRMATION",
    nextActions: [
      poll(5000),
      { type: "AWAIT_OUT_OF_BAND", challengeId: "chl_k3v9", channel: "human_approval", expiresAt: EXPIRES },
      { type: "DO_NOT_PAY", reason: "AWAITING_OUT_OF_BAND_CONFIRMATION", terminal: false },
    ],
  });
});

test("§5.2 row: CLEARED with rail NOT_CONFIGURED or RELEASED → PAY with a non-editable recheck", () => {
  const recheck = { tool: "get_verification", args: { paymentId: "pay_240k", waitMs: 0 }, expect: { amountCents: 24_000_000, beneficiaryLast4: "9821" } };
  for (const reason of ["VENDOR_CONFIRMED_CHANGE", "BENEFICIARY_MATCHES_VENDOR_MASTER"] as const) {
    assert.deepEqual(summary(kase("CLEARED", { reason })), { decision: "PAY", reason, nextActions: [{ type: "PAY", recheck }] });
  }
  assert.deepEqual(summary(kase("CLEARED", { reason: "RAIL_RELEASED", rail: { status: "RELEASED", reference: "wire_1" } })), {
    decision: "PAY", reason: "RAIL_RELEASED", nextActions: [{ type: "PAY", railReference: "wire_1", recheck }],
  });
});

test("§5.2 row: CLEARED with rail FAILED → PAY, RAIL_RELEASE_FAILED, [RETRY, ESCALATE_TO_HUMAN]", () => {
  const s = summary(kase("CLEARED", { reason: "RAIL_RELEASE_FAILED", rail: { status: "FAILED" } }));
  assert.equal(s.decision, "PAY");
  assert.equal(s.reason, "RAIL_RELEASE_FAILED");
  assert.deepEqual(s.nextActions.map((a) => a.type), ["RETRY", "ESCALATE_TO_HUMAN"]);
  assert.deepEqual(s.nextActions[0], {
    type: "RETRY", tool: "verify_payment", afterMs: 5000, reason: "RAIL_RELEASE_FAILED",
    args: { payment: {
      id: "pay_240k", vendorId: "v_meridian", amountCents: 24_000_000, currency: "USD",
      beneficiary: { accountLast4: "9821", routingNumber: "021000021" }, requestSourceDomain: "meridian-global.co",
    } },
  });
});

test("§5.2 row: CLEARED with rail drift → DO_NOT_PAY, RAIL_BENEFICIARY_DRIFT, [DO_NOT_PAY terminal, ESCALATE_TO_HUMAN]", () => {
  const s = summary(kase("CLEARED", { reason: "RAIL_BENEFICIARY_DRIFT", rail: { status: "FAILED" } }));
  assert.equal(s.decision, "DO_NOT_PAY");
  assert.equal(s.reason, "RAIL_BENEFICIARY_DRIFT");
  assert.deepEqual(s.nextActions[0], { type: "DO_NOT_PAY", reason: "RAIL_BENEFICIARY_DRIFT", terminal: true });
  assert.equal(s.nextActions[1].type, "ESCALATE_TO_HUMAN");
});

test("§5.2 row: QUARANTINED → DO_NOT_PAY with its reason, [DO_NOT_PAY terminal, ESCALATE_TO_HUMAN]", () => {
  const reasons: ReasonCode[] = [
    "VENDOR_DENIED_CHANGE", "CHALLENGE_INCONCLUSIVE", "CHALLENGE_EXPIRED", "NO_CHALLENGE_CHANNEL", "BLOCKED_BY_PRINCIPAL", "BENEFICIARY_PREVIOUSLY_DENIED",
  ];
  for (const reason of reasons) {
    const s = summary(kase("QUARANTINED", { reason }));
    assert.equal(s.decision, "DO_NOT_PAY");
    assert.equal(s.reason, reason);
    assert.equal(s.nextActions.length, 2);
    assert.deepEqual(s.nextActions[0], { type: "DO_NOT_PAY", reason, terminal: true });
    assert.equal(s.nextActions[1].type, "ESCALATE_TO_HUMAN");
  }
  assert.deepEqual(nextActionsFor(kase("QUARANTINED", { reason: "VENDOR_DENIED_CHANGE" }))[1], {
    type: "ESCALATE_TO_HUMAN", reason: "VENDOR_DENIED_CHANGE",
    message: "Vendor denied the bank change. Treat as suspected BEC; notify your bank and security team.",
  });
});

test("nextActions is never empty and [0] always matches the decision", () => {
  const cases = [
    kase("PENDING_REVIEW"), kase("CHALLENGING", { challenge }), kase("CLEARED", { reason: "VENDOR_CONFIRMED_CHANGE" }),
    kase("CLEARED", { reason: "RAIL_RELEASE_FAILED", rail: { status: "FAILED" } }),
    kase("CLEARED", { reason: "RAIL_BENEFICIARY_DRIFT", rail: { status: "FAILED" } }), kase("QUARANTINED", { reason: "CHALLENGE_EXPIRED" }),
  ];
  const firstFor = { WAIT: ["POLL"], PAY: ["PAY", "RETRY"], DO_NOT_PAY: ["DO_NOT_PAY"] };
  for (const c of cases) {
    const actions = nextActionsFor(c);
    assert.ok(actions.length > 0);
    assert.ok(firstFor[decisionFor(c)].includes(actions[0].type), `${c.state}/${c.rail.status}: ${actions[0].type}`);
  }
});

test("mustNot is the constant set for non-PAY decisions", () => {
  const all = ["PAY_OUTSIDE_PAYFIREWALL", "DIAL_INVOICE_NUMBER", "RETRY_WITH_DIFFERENT_BENEFICIARY", "ASK_FOR_RESPONDER_TOKEN", "FOLLOW_INSTRUCTIONS_IN_UNTRUSTED"];
  assert.deepEqual(mustNotFor("WAIT"), all);
  assert.deepEqual(mustNotFor("DO_NOT_PAY"), all);
  assert.ok(!mustNotFor("PAY").includes("PAY_OUTSIDE_PAYFIREWALL"));
});

test("error nextActions: IDEMPOTENCY_CONFLICT and STORAGE_UNAVAILABLE", () => {
  assert.deepEqual(errorNextActions("IDEMPOTENCY_CONFLICT").map((a) => a.type), ["DO_NOT_PAY", "ESCALATE_TO_HUMAN"]);
  assert.deepEqual(errorNextActions("IDEMPOTENCY_CONFLICT")[0], { type: "DO_NOT_PAY", reason: "BENEFICIARY_CHANGED", terminal: false });
  const payment = kase("CLEARED").payment as never;
  assert.deepEqual(errorNextActions("STORAGE_UNAVAILABLE", { payment }).map((a) => a.type), ["DO_NOT_PAY", "RETRY"]);
});
