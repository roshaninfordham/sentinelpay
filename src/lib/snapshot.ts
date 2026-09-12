import { all } from "./db";
import { demoMode } from "./env";
import { readLedger, verifyChain } from "./ledger";
import { paymentSource, railStatus, vendorDirectory } from "./providers";
import { readTimeline } from "./timeline";
import type { CallOutcome, RiskAssessment, Snapshot } from "./types";

const byPayment = <T>(rows: { paymentId: string; json: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.paymentId, JSON.parse(r.json) as T]));

export async function snapshot(): Promise<Snapshot> {
  const [assessments, calls, payments, vendors, timeline, ledger, chain] = await Promise.all([
    all<{ paymentId: string; json: string }>(`SELECT paymentId, json FROM assessments`),
    all<{ paymentId: string; json: string }>(`SELECT paymentId, json FROM calls`),
    paymentSource().listAll(),
    vendorDirectory().listAll(),
    readTimeline(),
    readLedger(),
    verifyChain(),
  ]);
  return {
    demoMode: demoMode(),
    rail: railStatus(),
    payments,
    vendors,
    timeline: timeline.map((l) => ({ ...l, id: Number(l.id) })),
    assessments: byPayment<RiskAssessment>(assessments),
    calls: byPayment<CallOutcome>(calls),
    ledger,
    chain: { ok: chain.ok, brokenAt: chain.brokenAt },
  };
}
