import { getRuntime } from "../engine";
import type { RiskAssessment } from "../types";

// Compatibility shim: Node 2 (forensics) is engine.advance(). The engine takes the investigation lease (CAS),
// runs the probes, scores them, and opens the challenge; the timeline lines come from the app's onEvent sink.

export async function investigate(paymentId: string): Promise<RiskAssessment> {
  const { engine } = await getRuntime();
  const v = await engine.advance(paymentId);
  if (!v.risk) throw new Error(`payment ${paymentId} is ${v.state}, not PENDING_REVIEW`);
  return v.risk;
}

export async function readAssessment(paymentId: string): Promise<RiskAssessment | undefined> {
  const { loadCase } = await getRuntime();
  return (await loadCase({ paymentId }))?.risk;
}
