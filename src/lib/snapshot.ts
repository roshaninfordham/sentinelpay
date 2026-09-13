import { getRuntime } from "./engine";
import { readLedger, verifyChain } from "./ledger";
import { paymentSource, vendorDirectory } from "./providers";
import { callOutcomeOf } from "./receipt";
import { callbackPhoneOf, maskPhone } from "./timeline-format";
import { readTimeline } from "./timeline";
import type { CallOutcome, ChallengeView, RiskAssessment, Snapshot } from "./types";

// Dashboard state for GET /api/stream. Assessments, calls and challenges are read from the engine's cases.
export async function snapshot(): Promise<Snapshot> {
  const { settings, listCases } = await getRuntime();
  const [cases, payments, vendors, timeline, ledger, chain] = await Promise.all([
    listCases(),
    paymentSource().listAll(),
    vendorDirectory().listAll(),
    readTimeline(),
    readLedger(),
    verifyChain(),
  ]);

  const assessments: Record<string, RiskAssessment> = {};
  const calls: Record<string, CallOutcome> = {};
  const challenges: Record<string, ChallengeView> = {};
  for (const c of cases) {
    if (c.risk) assessments[c.paymentId] = c.risk;
    const call = callOutcomeOf(c);
    if (call) calls[c.paymentId] = call;
    if (c.challenge) {
      // Only the public challenge view: never the token hash, attempt counters or evidence.
      const { challengeId, channel, assurance, status, expiresAt, verdict, resolvedBy, resolvedAt } = c.challenge;
      const dial = callbackPhoneOf(c);
      challenges[c.paymentId] = {
        challengeId, channel, assurance, status, expiresAt,
        ...(dial ? { dialMasked: maskPhone(dial) } : {}),
        ...(verdict ? { verdict } : {}),
        ...(resolvedBy ? { resolvedBy } : {}),
        ...(resolvedAt ? { resolvedAt } : {}),
      };
    }
  }

  return {
    environment: settings.environment,
    demoMode: settings.demoMode,
    rail: settings.rail,
    payments,
    vendors,
    timeline: timeline.map((l) => ({ ...l, id: Number(l.id) })),
    assessments,
    calls,
    challenges,
    ledger,
    chain: { ok: chain.ok, brokenAt: chain.brokenAt },
  };
}
