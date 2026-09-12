import { appendLedger } from "./ledger";
import { paymentSource, vendorDirectory } from "./providers";
import { emit } from "./timeline";
import type { PaymentStatus } from "./types";

// Node 1 — interception & policy gate (ARCHITECTURE §4).

export interface GateResult {
  paymentId: string;
  status: PaymentStatus;
  mismatches: string[];
  investigate: boolean;   // caller schedules forensics when true
}

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export async function runGate(paymentId: string): Promise<GateResult> {
  const source = paymentSource();
  const payment = await source.get(paymentId);
  if (payment.status !== "RECEIVED") {
    return { paymentId, status: payment.status, mismatches: [], investigate: false };
  }
  const vendor = await vendorDirectory().get(payment.vendorId);

  emit(paymentId, "info", `→ Release requested: ${usd(payment.amountCents)} to ${vendor.legalName}`);

  const mismatches: string[] = [];
  if (payment.claimedBankLast4 !== vendor.knownBankLast4) {
    mismatches.push(`Beneficiary changed: ••${vendor.knownBankLast4} → ••${payment.claimedBankLast4}`);
  }
  if (payment.requestSourceDomain.toLowerCase() !== vendor.knownDomain.toLowerCase()) {
    mismatches.push(`Request domain ${payment.requestSourceDomain} ≠ vendor of record ${vendor.knownDomain}`);
  }

  if (mismatches.length === 0) {
    await source.setStatus(paymentId, "CLEARED");
    appendLedger("CLEARED", paymentId, { reason: "beneficiary and request domain match vendor master" });
    emit(paymentId, "ok", `✔ Beneficiary matches vendor master (••${vendor.knownBankLast4}) — released`);
    return { paymentId, status: "CLEARED", mismatches, investigate: false };
  }

  await source.setStatus(paymentId, "PENDING_REVIEW");
  appendLedger("INTERCEPTED", paymentId, {
    mismatches,
    onFile: { bankLast4: vendor.knownBankLast4, domain: vendor.knownDomain },
    claimed: { bankLast4: payment.claimedBankLast4, domain: payment.requestSourceDomain },
  });
  emit(paymentId, "alert", `⚠ ${mismatches[0]} — release HELD`);
  for (const m of mismatches.slice(1)) emit(paymentId, "warn", `⚠ ${m}`);
  return { paymentId, status: "PENDING_REVIEW", mismatches, investigate: true };
}
