import { one } from "./db";
import { readAssessment } from "./forensics";
import { readLedger, verifyChain } from "./ledger";
import { paymentSource, vendorDirectory } from "./providers";
import type { CallOutcome, LedgerEntry, Payment, RiskAssessment, Vendor } from "./types";

export interface IncidentReceipt {
  incidentId: string;
  generatedAt: string;
  payment: Payment;
  vendor: Vendor;
  assessment?: RiskAssessment;
  call?: CallOutcome;
  entries: LedgerEntry[];
  headHash: string | null;      // hash of this payment's final ledger entry
  chain: { ok: boolean; brokenAt?: number; length: number };
}

export async function readCall(paymentId: string): Promise<CallOutcome | undefined> {
  const row = await one<{ json: string }>(`SELECT json FROM calls WHERE paymentId = ?`, [paymentId]);
  return row ? (JSON.parse(row.json) as CallOutcome) : undefined;
}

export async function buildReceipt(paymentId: string): Promise<IncidentReceipt> {
  const payment = await paymentSource().get(paymentId);
  const vendor = await vendorDirectory().get(payment.vendorId);
  const entries = await readLedger(paymentId);
  return {
    incidentId: `INC-${paymentId.toUpperCase()}-${entries[0]?.seq ?? 0}`,
    generatedAt: new Date().toISOString(),
    payment,
    vendor,
    assessment: await readAssessment(paymentId),
    call: await readCall(paymentId),
    entries,
    headHash: entries.at(-1)?.entryHash ?? null,
    chain: await verifyChain(),
  };
}
