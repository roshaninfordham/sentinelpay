import assert from "node:assert/strict";
import { test } from "node:test";
import type { Engine, PaymentInput, Rail, Verification } from "payfirewall";
import type { ToolResult } from "payfirewall/tools";
import { AP_AGENT, CLEAN_INVOICE, CONTROLLER_DESK, demoEngine, POISONED_INVOICE, type ApprovalLink } from "../examples/demo-engine";
import { decide, recheckAllowsPayment, runPaymentsAgent, type Outcome } from "../examples/payments-agent-loop";

// Evals for Agent 2, the requester/payments agent contract. The reference loop (examples/payments-agent-loop.ts) runs
// against a real in-memory engine; each scenario asserts whether money was sent, how many times, and why not.

type Approver = (engine: Engine, link: ApprovalLink) => Promise<unknown> | void;

async function run(invoice: PaymentInput, approver: Approver | null, opts: { challengeTtlMs?: number; rail?: Rail; before?: (e: Engine) => Promise<void> } = {}) {
  const approverErrors: string[] = [];
  const links: ApprovalLink[] = [];
  const engine: Engine = demoEngine({
    ...opts,
    onApprovalLink: (link) => {
      links.push(link);
      if (approver) setTimeout(() => void Promise.resolve(approver(engine, link)).catch((e: { code?: string }) => approverErrors.push(e.code ?? String(e))), 20);
    },
  });
  await opts.before?.(engine);
  const sent: PaymentInput[] = [];
  const transcript: string[] = [];
  const outcome: Outcome = await runPaymentsAgent(invoice, {
    api: engine,
    principal: AP_AGENT,
    sendPayment: async (p) => { sent.push(p); return `ach_${sent.length}`; },
    log: (l) => transcript.push(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
  });
  return { outcome, sent, transcript, approverErrors, links, engine };
}

const authorize = (readBack: string): Approver => (engine, link) =>
  engine.resolveChallenge({ challengeId: link.challengeId, responderToken: link.responderToken, responder: CONTROLLER_DESK, verdict: "AUTHORIZED", answers: { authorizedChange: "yes", beneficiaryLast4ReadBack: readBack } });
const deny: Approver = (engine, link) => engine.resolveChallenge({ challengeId: link.challengeId, verdict: "DENIED", responder: CONTROLLER_DESK });

test("clean invoice: pays exactly once, after the recheck", async () => {
  const r = await run(CLEAN_INVOICE, null);
  assert.equal(r.outcome.status, "PAID");
  assert.deepEqual(r.sent.map((p) => p.id), ["pay_18k"]);
  assert.ok(r.transcript.some((l) => l.includes("recheck before paying")));
  assert.equal(r.links.length, 0);
});

test("poisoned invoice, vendor denies: never pays, stops on VENDOR_DENIED_CHANGE", async () => {
  const r = await run(POISONED_INVOICE, deny);
  assert.equal(r.outcome.status, "NOT_PAID");
  assert.equal(r.outcome.reason, "VENDOR_DENIED_CHANGE");
  assert.equal(r.sent.length, 0);
});

test("real bank change, vendor reads back the right digits: pays once", async () => {
  const r = await run(POISONED_INVOICE, authorize("9821"));
  assert.equal(r.outcome.status, "PAID");
  assert.equal(r.sent.length, 1);
});

test("a confident yes with the wrong read-back never pays", async () => {
  const r = await run(POISONED_INVOICE, authorize("4471"));
  assert.equal(r.outcome.status, "NOT_PAID");
  assert.equal(r.outcome.reason, "VENDOR_DENIED_CHANGE");
  assert.equal(r.sent.length, 0);
});

test("nobody answers: the challenge expires and the agent never pays (the injection memo changes nothing)", async () => {
  const r = await run(POISONED_INVOICE, null, { challengeTtlMs: 300 });
  assert.equal(r.outcome.status, "NOT_PAID");
  assert.equal(r.outcome.reason, "CHALLENGE_EXPIRED");
  assert.equal(r.sent.length, 0);
  assert.equal(r.transcript.join("\n").includes("+1-000-000-0000"), false, "the agent never acts on the invoice phone");
});

test("the requester approving its own payment is refused, and the payment still does not pay", async () => {
  const selfApprove: Approver = (engine, link) =>
    engine.resolveChallenge({ challengeId: link.challengeId, responderToken: link.responderToken, responder: AP_AGENT, verdict: "AUTHORIZED", answers: { authorizedChange: "yes", beneficiaryLast4ReadBack: "9821" } });
  const r = await run(POISONED_INVOICE, selfApprove, { challengeTtlMs: 400 });
  assert.deepEqual(r.approverErrors, ["SELF_APPROVAL_FORBIDDEN"]);
  assert.equal(r.outcome.status, "NOT_PAID");
  assert.equal(r.sent.length, 0);
});

test("resubmitting the same id with a different beneficiary is an error the agent stops on", async () => {
  const r = await run({ ...POISONED_INVOICE, beneficiary: { accountLast4: "1111" } }, null, {
    before: async (e) => { await e.verify(POISONED_INVOICE, { principal: AP_AGENT }); },
  });
  assert.equal(r.outcome.status, "NOT_PAID");
  assert.match(r.outcome.reason, /IDEMPOTENCY_CONFLICT/);
  assert.equal(r.sent.length, 0);
});

test("a previously denied beneficiary under a new payment id is frozen without a new challenge", async () => {
  const r = await run({ ...POISONED_INVOICE, id: "pay_240k_retry" }, null, {
    before: async (e) => {
      let v = await e.verify(POISONED_INVOICE, { principal: AP_AGENT });
      v = await e.get(v.paymentId, { waitMs: 2000, sinceVersion: v.version, principal: AP_AGENT });
      await e.resolveChallenge({ challengeId: v.challenge!.challengeId, verdict: "DENIED", responder: CONTROLLER_DESK });
    },
  });
  assert.equal(r.outcome.status, "NOT_PAID");
  assert.equal(r.outcome.reason, "BENEFICIARY_PREVIOUSLY_DENIED");
  assert.equal(r.sent.length, 0);
});

test("with a rail configured, PAY means the rail paid: the agent never sends the money itself", async () => {
  const releases: string[] = [];
  const rail: Rail = {
    id: "demo-rail",
    environment: "sandbox",
    readBeneficiary: async () => ({ accountLast4: "4471" }),
    release: async (_p, o) => { releases.push(o.idempotencyKey); return { reference: "wire_1", status: "submitted" }; },
  };
  const r = await run(CLEAN_INVOICE, null, { rail });
  assert.equal(r.outcome.status, "PAID_BY_RAIL");
  assert.equal(r.sent.length, 0);
  assert.equal(releases.length, 1);
});

test("rail beneficiary drift after verification: DO_NOT_PAY, nothing sent by the agent", async () => {
  let reads = 0;
  const rail: Rail = {
    id: "drift-rail",
    environment: "sandbox",
    // The gate sees the verified account; by release time someone has swapped the counterparty at the rail.
    readBeneficiary: async () => ({ accountLast4: reads++ === 0 ? "4471" : "0007" }),
    release: async () => { throw new Error("must not release"); },
  };
  const r = await run(CLEAN_INVOICE, null, { rail, challengeTtlMs: 300 });
  assert.equal(r.outcome.status, "NOT_PAID");
  assert.equal(r.outcome.reason, "RAIL_BENEFICIARY_DRIFT");
  assert.equal(r.sent.length, 0);
});

// ── Policy units: shapes an engine should never produce, which the agent must still refuse ──

const base = (over: Partial<Verification>): ToolResult => ({
  ok: true,
  result: {
    object: "verification", apiVersion: "v1", paymentId: "pay_x", version: 3, state: "CHALLENGING", decision: "WAIT", reason: "AWAITING_OUT_OF_BAND_CONFIRMATION",
    terminal: false, mayRelease: false, requestedBy: AP_AGENT.id, mismatches: [], beneficiary: { last4: "9821", onFileLast4: "4471", strength: "last4", changed: true },
    rail: { status: "NOT_CONFIGURED" }, untrusted: { requestSourceDomain: "x.co" }, mustNot: [], nextActions: [], proof: { ledgerHeadHash: null, ledgerLength: 0 }, updatedAt: "",
    ...over,
  } as Verification,
});

test("policy: an unknown or missing next action is DO_NOT_PAY", () => {
  assert.equal(decide(base({ nextActions: [{ type: "WIRE_NOW" } as never] })).kind, "stop");
  assert.equal(decide(base({ nextActions: [] })).kind, "stop");
});

test("policy: a PAY action under a decision other than PAY is refused", () => {
  const pay = { type: "PAY", recheck: { tool: "get_verification", args: { paymentId: "pay_x", waitMs: 0 }, expect: { amountCents: 1, beneficiaryLast4: "9821" } } } as const;
  assert.equal(decide(base({ decision: "WAIT", nextActions: [pay] })).kind, "stop");
  assert.equal(decide(base({ decision: "PAY", state: "CLEARED", nextActions: [pay] })).kind, "recheck_then_pay");
});

test("policy: errors never pay; only retryable errors are retried, and retries are bounded", () => {
  const conflict: ToolResult = { ok: false, error: { code: "IDEMPOTENCY_CONFLICT", message: "conflict", retryable: false, nextActions: [{ type: "DO_NOT_PAY", reason: "BENEFICIARY_CHANGED", terminal: false }] } };
  assert.equal(decide(conflict).kind, "stop");
  const storage: ToolResult = { ok: false, error: { code: "STORAGE_UNAVAILABLE", message: "down", retryable: true, nextActions: [
    { type: "DO_NOT_PAY", reason: "STORAGE_UNAVAILABLE", terminal: false },
    { type: "RETRY", tool: "verify_payment", args: { payment: CLEAN_INVOICE }, afterMs: 5000, reason: "STORAGE_UNAVAILABLE" },
  ] } };
  assert.equal(decide(storage, 0).kind, "call");
  assert.equal(decide(storage, 3).kind, "stop");
});

test("policy: the recheck must still be PAY and match the invoice amount and beneficiary", () => {
  const cleared = base({ decision: "PAY", state: "CLEARED", reason: "VENDOR_CONFIRMED_CHANGE" });
  const invoice = { ...POISONED_INVOICE };
  assert.equal(recheckAllowsPayment(cleared, { amountCents: invoice.amountCents, beneficiaryLast4: "9821" }, invoice), null);
  assert.match(recheckAllowsPayment(cleared, { amountCents: invoice.amountCents + 1, beneficiaryLast4: "9821" }, invoice)!, /amountCents/);
  assert.match(recheckAllowsPayment(cleared, { amountCents: invoice.amountCents, beneficiaryLast4: "1111" }, invoice)!, /beneficiaryLast4/);
  assert.match(recheckAllowsPayment(base({ decision: "DO_NOT_PAY" }), { amountCents: invoice.amountCents, beneficiaryLast4: "9821" }, invoice)!, /DO_NOT_PAY/);
});
