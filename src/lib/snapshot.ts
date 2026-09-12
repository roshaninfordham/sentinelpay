import { getDb } from "./db";
import { demoMode } from "./env";
import { readLedger, verifyChain } from "./ledger";
import { paymentSource, railStatus, vendorDirectory } from "./providers";
import { readTimeline } from "./timeline";
import type { CallOutcome, RiskAssessment, Snapshot } from "./types";

export function snapshot(): Snapshot {
  const db = getDb();
  const assessments = Object.fromEntries(
    (db.prepare(`SELECT paymentId, json FROM assessments`).all() as { paymentId: string; json: string }[]).map((r) => [
      r.paymentId,
      JSON.parse(r.json) as RiskAssessment,
    ]),
  );
  const calls = Object.fromEntries(
    (db.prepare(`SELECT paymentId, json FROM calls`).all() as { paymentId: string; json: string }[]).map((r) => [
      r.paymentId,
      JSON.parse(r.json) as CallOutcome,
    ]),
  );
  const chain = verifyChain();
  return {
    demoMode: demoMode(),
    rail: railStatus(),
    payments: paymentSource().listAll(),
    vendors: vendorDirectory().listAll(),
    timeline: readTimeline(),
    assessments,
    calls,
    ledger: readLedger(),
    chain: { ok: chain.ok, brokenAt: chain.brokenAt },
  };
}
