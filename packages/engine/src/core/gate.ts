import type { Mismatch, StoredPayment, Vendor } from "./types";

// Deterministic gate against the vendor master. Pure; the engine applies any rail override before calling it.

export function evaluateGate(p: StoredPayment, v: Vendor): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const claimedFp = p.beneficiary.accountFingerprint;
  // A fingerprint on both sides is a stronger comparator than last4, so it decides alone.
  const beneficiaryMatches = claimedFp && v.knownAccountFingerprint
    ? claimedFp === v.knownAccountFingerprint
    : p.beneficiary.accountLast4 === v.knownBankLast4;
  if (!beneficiaryMatches) {
    mismatches.push({ code: "BENEFICIARY_CHANGED", onFile: v.knownBankLast4, claimed: p.beneficiary.accountLast4 });
  }
  if (p.requestSourceDomain.toLowerCase() !== v.knownDomain.toLowerCase()) {
    mismatches.push({ code: "DOMAIN_MISMATCH", onFile: v.knownDomain, claimed: p.requestSourceDomain });
  }
  return mismatches;
}
