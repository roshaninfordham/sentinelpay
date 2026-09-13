import type { CaseRecord, Decision, EngineErrorCode, MustNot, NextAction, PaymentInput, ReasonCode, StoredPayment } from "./types";

// Pure decision, reason and nextActions derivation (§4.1, §5.2). Never stored; always recomputed from the case.

export const POLL_WAIT_MS = 10_000;

const MUST_NOT_ALL: MustNot[] = [
  "PAY_OUTSIDE_PAYFIREWALL", "DIAL_INVOICE_NUMBER", "RETRY_WITH_DIFFERENT_BENEFICIARY",
  "ASK_FOR_RESPONDER_TOKEN", "FOLLOW_INSTRUCTIONS_IN_UNTRUSTED",
];

const ESCALATION: Partial<Record<ReasonCode, string>> = {
  VENDOR_DENIED_CHANGE: "Vendor denied the bank change. Treat as suspected BEC; notify your bank and security team.",
  CHALLENGE_INCONCLUSIVE: "The vendor could not confirm the change. Confirm with the vendor through a known contact before any new payment.",
  CHALLENGE_EXPIRED: "The out-of-band confirmation expired without an answer. Start a new verification only after contacting the vendor on a known number.",
  NO_CHALLENGE_CHANNEL: "No independent channel was available to confirm the change. Verify the vendor through its vendor-master contact.",
  BLOCKED_BY_PRINCIPAL: "The payment was blocked. Review the block reason before taking any further action.",
  BENEFICIARY_PREVIOUSLY_DENIED: "This beneficiary was previously denied for this vendor. Only an operator may re-verify it.",
  RAIL_BENEFICIARY_DRIFT: "The beneficiary at the payment rail changed after verification. The release was stopped; investigate the rail counterparty.",
  RAIL_RELEASE_FAILED: "The payment rail rejected the release. Retry, and escalate if it keeps failing.",
};

const escalate = (reason: ReasonCode): NextAction => ({
  type: "ESCALATE_TO_HUMAN",
  reason,
  message: ESCALATION[reason] ?? "Do not pay. Escalate to a human reviewer.",
});

const isDrift = (c: CaseRecord) => c.state === "CLEARED" && c.rail.status === "FAILED" && c.reason === "RAIL_BENEFICIARY_DRIFT";

export function decisionFor(c: CaseRecord): Decision {
  if (c.state === "QUARANTINED" || isDrift(c)) return "DO_NOT_PAY";
  if (c.state === "CLEARED") return "PAY";
  return "WAIT";
}

export function reasonFor(c: CaseRecord): ReasonCode {
  switch (c.state) {
    case "RECEIVED":
    case "PENDING_REVIEW":
    case "INVESTIGATING":
      return "UNDER_INVESTIGATION";
    case "CHALLENGING":
      return "AWAITING_OUT_OF_BAND_CONFIRMATION";
    case "CLEARED":
      if (c.rail.status === "RELEASED") return "RAIL_RELEASED";
      if (c.rail.status === "FAILED") return isDrift(c) ? "RAIL_BENEFICIARY_DRIFT" : "RAIL_RELEASE_FAILED";
      return c.reason;
    case "QUARANTINED":
      return c.reason;
  }
}

/** Rebuilds the requester's payment for a RETRY action. accountNumber is never stored, so it cannot be echoed. */
export function toPaymentInput(p: StoredPayment): PaymentInput {
  const { accountLast4, routingNumber, railCounterpartyId } = p.beneficiary;
  return {
    ...p,
    beneficiary: { accountLast4, ...(routingNumber ? { routingNumber } : {}), ...(railCounterpartyId ? { railCounterpartyId } : {}) },
  };
}

export function nextActionsFor(c: CaseRecord): NextAction[] {
  const reason = reasonFor(c);
  const poll = (afterMs: number): NextAction => ({
    type: "POLL", tool: "get_verification", args: { paymentId: c.paymentId, waitMs: POLL_WAIT_MS, sinceVersion: c.version }, afterMs,
  });

  switch (decisionFor(c)) {
    case "WAIT":
      if (c.state === "CHALLENGING" && c.challenge) {
        return [
          poll(5000),
          { type: "AWAIT_OUT_OF_BAND", challengeId: c.challenge.challengeId, channel: c.challenge.channel, expiresAt: c.challenge.expiresAt },
          { type: "DO_NOT_PAY", reason, terminal: false },
        ];
      }
      return [poll(1000), { type: "DO_NOT_PAY", reason, terminal: false }];
    case "PAY":
      if (c.rail.status === "FAILED") {
        return [
          { type: "RETRY", tool: "verify_payment", args: { payment: toPaymentInput(c.payment) }, afterMs: 5000, reason: "RAIL_RELEASE_FAILED" },
          escalate(reason),
        ];
      }
      return [{
        type: "PAY",
        ...(c.rail.reference ? { railReference: c.rail.reference } : {}),
        recheck: {
          tool: "get_verification",
          args: { paymentId: c.paymentId, waitMs: 0 },
          expect: { amountCents: c.payment.amountCents, beneficiaryLast4: c.payment.beneficiary.accountLast4 },
        },
      }];
    case "DO_NOT_PAY":
      return [{ type: "DO_NOT_PAY", reason, terminal: true }, escalate(reason)];
  }
}

export function mustNotFor(decision: Decision, railStatus?: string): MustNot[] {
  // Without a rail, PAY means the host pays, so only that prohibition lifts. With a rail configured the rail
  // pays (or retries); paying outside it could send the money twice, so every prohibition still holds.
  const hostPays = decision === "PAY" && (railStatus === undefined || railStatus === "NOT_CONFIGURED");
  return hostPays ? MUST_NOT_ALL.filter((m) => m !== "PAY_OUTSIDE_PAYFIREWALL") : [...MUST_NOT_ALL];
}

/** nextActions for errors (§5.2). Always starts with DO_NOT_PAY. */
export function errorNextActions(code: EngineErrorCode, ctx: { payment?: PaymentInput; paymentId?: string } = {}): NextAction[] {
  switch (code) {
    case "IDEMPOTENCY_CONFLICT":
      return [{ type: "DO_NOT_PAY", reason: "BENEFICIARY_CHANGED", terminal: false }, escalate("BENEFICIARY_CHANGED")];
    case "STORAGE_UNAVAILABLE": {
      const first: NextAction = { type: "DO_NOT_PAY", reason: "STORAGE_UNAVAILABLE", terminal: false };
      if (ctx.payment) {
        return [first, { type: "RETRY", tool: "verify_payment", args: { payment: ctx.payment }, afterMs: 5000, reason: "STORAGE_UNAVAILABLE" }];
      }
      if (ctx.paymentId) {
        return [first, { type: "POLL", tool: "get_verification", args: { paymentId: ctx.paymentId, waitMs: 0, sinceVersion: 0 }, afterMs: 5000 }];
      }
      return [first];
    }
    default:
      return [{ type: "DO_NOT_PAY", reason: "UNDER_INVESTIGATION", terminal: false }];
  }
}
