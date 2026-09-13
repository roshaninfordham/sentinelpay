import type { CaseRecord, ChallengeEvidence, Verification } from "payfirewall";
import { APP_OPERATOR, getRuntime } from "./engine";
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
  /** The engine's view of the case; absent only for a payment that never reached the gate. */
  verification?: Verification;
  environment: string;
  /** Who spoke for SentinelPay on a voice_browser call: the ElevenLabs agent, or the local script when it is not configured. */
  voiceAgent: "elevenlabs" | "scripted";
  entries: LedgerEntry[];
  headHash: string | null;      // hash of this payment's final ledger entry
  chain: { ok: boolean; brokenAt?: number; length: number };
}

/** The legacy call record, derived from the resolved challenge and the evidence the responder channel sent. */
export function callOutcomeOf(c: CaseRecord): CallOutcome | undefined {
  const ch = c.challenge;
  if (!ch || ch.status === "OPEN") return undefined;
  const evidence = (ch.evidence ?? {}) as ChallengeEvidence;
  return {
    paymentId: c.paymentId,
    verdict: ch.verdict ?? "INCONCLUSIVE", // an expired challenge has no verdict: it failed closed
    transcript: evidence.transcript ?? "",
    toolInvoked: evidence.tool ?? null,
    durationSec: Math.max(0, Math.round(evidence.durationSec ?? 0)),
  };
}

// Compatibility shim over engine.receipt(), in the dashboard's IncidentReceipt shape.
export async function buildReceipt(paymentId: string): Promise<IncidentReceipt> {
  const { engine, loadCase, settings } = await getRuntime();
  const started = await loadCase({ paymentId });
  const receipt = started ? await engine.receipt(paymentId, { principal: APP_OPERATOR }) : null;
  const c = started ? await loadCase({ paymentId }) : null;

  const payment = await paymentSource().get(paymentId);
  const vendor = await vendorDirectory().get(payment.vendorId);
  const entries: LedgerEntry[] = receipt ? receipt.entries : await readLedger(paymentId);
  return {
    incidentId: receipt?.incidentId ?? `INC-${paymentId.toUpperCase()}`,
    generatedAt: receipt?.generatedAt ?? new Date().toISOString(),
    payment,
    vendor,
    assessment: c?.risk,
    call: c ? callOutcomeOf(c) : undefined,
    verification: receipt?.verification,
    environment: settings.environment,
    voiceAgent: settings.demoMode === "cache" || !settings.elevenLabs ? "scripted" : "elevenlabs",
    entries,
    headHash: entries.at(-1)?.entryHash ?? null,
    chain: receipt?.chain ?? (await verifyChain()),
  };
}
