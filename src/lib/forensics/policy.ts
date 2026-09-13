import { assessRisk as engineAssessRisk, type ForensicSignal as EngineSignal } from "payfirewall";
import type { ForensicSignal, RiskAssessment } from "../types";

// Compatibility shim: the deterministic policy (rules-v1) lives in payfirewall with byte-identical scoring.

export { levelFor } from "payfirewall";

/** Signals without an origin are treated as live evidence, which is what every pre-engine caller produced. */
export function assessRisk(signals: ForensicSignal[], invoiceContactPhone?: string): RiskAssessment {
  const withOrigin = signals.map((s): EngineSignal => ({ ...s, origin: s.origin ?? "live" }));
  return engineAssessRisk(withOrigin, invoiceContactPhone);
}
