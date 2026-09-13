import type { Mismatch, StoredPayment, Vendor } from "./types";

// Deterministic gate against the vendor master. Pure; the engine applies any rail override before calling it.

export function evaluateGate(p: StoredPayment, v: Vendor): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const claimedFp = p.beneficiary.accountFingerprint;
  // A fingerprint on both sides is a stronger comparator than last4, so it decides alone.
  const byFingerprint = !!(claimedFp && v.knownAccountFingerprint);
  const beneficiaryMatches = byFingerprint ? claimedFp === v.knownAccountFingerprint : p.beneficiary.accountLast4 === v.knownBankLast4;
  // The fingerprint already covers routing|account. Otherwise the same last 4 at a different bank is still a change.
  const claimedRouting = p.beneficiary.routingNumber;
  const routingChanged = !byFingerprint && !!claimedRouting && !!v.knownRoutingNumber && claimedRouting !== v.knownRoutingNumber;
  if (!beneficiaryMatches) {
    mismatches.push({ code: "BENEFICIARY_CHANGED", onFile: v.knownBankLast4, claimed: p.beneficiary.accountLast4 });
  } else if (routingChanged) {
    const at = (routing: string) => `routing ••${routing.slice(-4)}`;
    mismatches.push({ code: "BENEFICIARY_CHANGED", onFile: `${v.knownBankLast4} at ${at(v.knownRoutingNumber!)}`, claimed: `${p.beneficiary.accountLast4} at ${at(claimedRouting!)}` });
  }
  if (p.requestSourceDomain.toLowerCase() !== v.knownDomain.toLowerCase()) {
    mismatches.push({ code: "DOMAIN_MISMATCH", onFile: v.knownDomain, claimed: p.requestSourceDomain });
  }
  return mismatches;
}
