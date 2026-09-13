import { assessRisk as engineAssessRisk, type ForensicSignal as EngineSignal } from "@sentinelpay/engine";
import type { ForensicSignal, RiskAssessment } from "../types";

// Compatibility shim: the deterministic policy (rules-v1) lives in @sentinelpay/engine with byte-identical scoring.

export { levelFor } from "@sentinelpay/engine";

/** Signals without an origin are treated as live evidence, which is what every pre-engine caller produced. */
export function assessRisk(signals: ForensicSignal[], invoiceContactPhone?: string): RiskAssessment {
  const withOrigin = signals.map((s): EngineSignal => ({ ...s, origin: s.origin ?? "live" }));
  return engineAssessRisk(withOrigin, invoiceContactPhone);
}
