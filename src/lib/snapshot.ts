import { one } from "./db";
import { getRuntime } from "./engine";
import { readLedger, verifyChain } from "./ledger";
import { paymentSource, vendorDirectory } from "./providers";
import { callOutcomeOf } from "./receipt";
import { callbackPhoneOf, maskPhone } from "./timeline-format";
import { readTimeline } from "./timeline";
import type { CallOutcome, ChallengeView, RiskAssessment, Snapshot } from "./types";

const CHAIN_TTL_MS = 60_000;
let chainCache: { head: string; at: number; result: Awaited<ReturnType<typeof verifyChain>> } | null = null;

/**
 * Full-chain verification for the header indicator, recomputed when a new entry is written and at least every
 * 60 s otherwise, instead of on every poll (ENGINE_SPEC §6.3). The receipt and /api/v1/ledger/verify always recompute.
 */
async function recentChainCheck() {
  const head = await one<{ seq: number; entryHash: string }>(`SELECT seq, entryHash FROM ledger ORDER BY seq DESC LIMIT 1`);
  const key = head ? `${head.seq}:${head.entryHash}` : "empty";
  if (chainCache?.head === key && Date.now() - chainCache.at < CHAIN_TTL_MS) return chainCache.result;
  const result = await verifyChain();
  chainCache = { head: key, at: Date.now(), result };
  return result;
}

// Dashboard state for GET /api/stream. Assessments, calls and challenges are read from the engine's cases.
export async function snapshot(): Promise<Snapshot> {
  const { settings, listCases } = await getRuntime();
  const [cases, payments, vendors, timeline, ledger, chain] = await Promise.all([
    listCases(),
    paymentSource().listAll(),
    vendorDirectory().listAll(),
    readTimeline(),
    readLedger(),
    recentChainCheck(),
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
    voiceAgent: settings.demoMode === "cache" || !settings.elevenLabs ? "scripted" : "elevenlabs",
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
