import type { PaymentInput, Verification } from "@sentinelpay/engine";
import { getRuntime } from "./engine";
import { paymentSource } from "./providers";
import { describeMismatch } from "./timeline-format";
import type { Payment, PaymentStatus } from "./types";

// Compatibility shim: Node 1 (interception & policy gate) is engine.verify() over the payments row.

export interface GateResult {
  paymentId: string;
  status: PaymentStatus;
  mismatches: string[];
  investigate: boolean;   // caller schedules forensics when true
}

export function toPaymentInput(p: Payment): PaymentInput {
  return {
    id: p.id,
    vendorId: p.vendorId,
    amountCents: p.amountCents,
    currency: "USD",
    beneficiary: { accountLast4: p.claimedBankLast4, ...(p.railCounterpartyId ? { railCounterpartyId: p.railCounterpartyId } : {}) },
    requestSourceDomain: p.requestSourceDomain,
    ...(p.invoiceContactPhone ? { invoiceContactPhone: p.invoiceContactPhone } : {}),
    ...(p.memo ? { memo: p.memo } : {}),
  };
}

const toGateResult = (v: Pick<Verification, "paymentId" | "state" | "mismatches">): GateResult => ({
  paymentId: v.paymentId,
  status: v.state,
  mismatches: v.mismatches.map(describeMismatch),
  investigate: v.state === "PENDING_REVIEW",
});

export async function runGate(paymentId: string): Promise<GateResult> {
  const { engine, loadCase } = await getRuntime();
  // An existing case is never re-submitted: the payments row now mirrors the rail's beneficiary, so a second
  // verify would look like a changed request (409). The case already holds the gate's answer.
  const existing = await loadCase({ paymentId });
  if (existing) return toGateResult(existing);

  const payment = await paymentSource().get(paymentId);
  if (payment.status !== "RECEIVED") return { paymentId, status: payment.status, mismatches: [], investigate: false };
  return toGateResult(await engine.verify(toPaymentInput(payment)));
}
