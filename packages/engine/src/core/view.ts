import { decisionFor, mustNotFor, nextActionsFor, reasonFor } from "./next-actions";
import { isTerminal } from "./state";
import type { CaseRecord, Verification } from "./types";

// CaseRecord -> public Verification. The responder token hash, attempt counters and evidence never leave the case.

/** Callback number for the challenge: vendor master first, then the registry-verified number. Never the invoice. */
export const callbackPhoneFor = (c: CaseRecord): string | null => c.vendorSnapshot.verifiedPhone ?? c.risk?.verifiedCallbackPhone ?? null;

export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) •••-${d.slice(6)}`;
  return d.length >= 4 ? `•••-${d.slice(-4)}` : "•••";
}

export const railReadUnavailable = (c: CaseRecord) => c.mismatches.some((m) => m.code === "BENEFICIARY_CHANGED" && m.claimed === "unknown");

export function toVerification(
  c: CaseRecord,
  ledger: { headHash: string | null; length: number },
  opts: { railReadsBeneficiary: boolean },
): Verification {
  const decision = decisionFor(c);
  const b = c.payment.beneficiary;
  const strength: Verification["beneficiary"]["strength"] = opts.railReadsBeneficiary && !railReadUnavailable(c)
    ? "rail"
    : b.accountFingerprint && c.vendorSnapshot.knownAccountFingerprint ? "fingerprint" : "last4";
  const dial = callbackPhoneFor(c);

  return {
    object: "verification",
    apiVersion: "v1",
    paymentId: c.paymentId,
    version: c.version,
    state: c.state,
    decision,
    reason: reasonFor(c),
    terminal: isTerminal(c.state),
    mayRelease: decision === "PAY",
    requestedBy: c.requestedBy,
    mismatches: c.mismatches,
    beneficiary: {
      last4: b.accountLast4,
      onFileLast4: c.vendorSnapshot.knownBankLast4,
      strength,
      changed: c.mismatches.some((m) => m.code === "BENEFICIARY_CHANGED"),
    },
    ...(c.risk ? { risk: c.risk } : {}),
    ...(c.challenge
      ? {
          challenge: {
            challengeId: c.challenge.challengeId,
            channel: c.challenge.channel,
            assurance: c.challenge.assurance,
            status: c.challenge.status,
            expiresAt: c.challenge.expiresAt,
            ...(dial ? { dialMasked: maskPhone(dial) } : {}),
            ...(c.challenge.verdict ? { verdict: c.challenge.verdict } : {}),
            ...(c.challenge.resolvedBy ? { resolvedBy: c.challenge.resolvedBy } : {}),
            ...(c.challenge.resolvedAt ? { resolvedAt: c.challenge.resolvedAt } : {}),
          },
        }
      : {}),
    rail: { status: c.rail.status, ...(c.rail.reference ? { reference: c.rail.reference } : {}) },
    untrusted: {
      requestSourceDomain: c.payment.requestSourceDomain,
      ...(c.payment.invoiceContactPhone !== undefined ? { invoiceContactPhone: c.payment.invoiceContactPhone } : {}),
      ...(c.payment.memo !== undefined ? { memo: c.payment.memo } : {}),
    },
    mustNot: mustNotFor(decision, c.rail.status),
    nextActions: nextActionsFor(c),
    proof: { ledgerHeadHash: ledger.headHash, ledgerLength: ledger.length },
    updatedAt: c.updatedAt,
  };
}
