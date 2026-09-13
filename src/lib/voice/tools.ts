import type { CallOutcome, Verdict } from "../types";

// Client tools the ElevenLabs agent invokes mid-call. Browser-safe (no server imports).
// The same tool names and parameter schema must be registered on the agent in the ElevenLabs
// dashboard (see agent.config.md) — registering them only here is not enough for the call to fire.

export type ToolName = NonNullable<CallOutcome["toolInvoked"]>;
export type FreezeOutcome = "denied" | "inconclusive";

export interface DecisionContext {
  paymentId: string;
  /** From /api/voice/token for the open voice_browser challenge. */
  challengeId: string;
  /** Held in browser memory only; sent solely to authorize. Never given to the voice provider. */
  responderToken: string;
  startedAt: number;
  transcript: () => string;
  onDecided?: (tool: ToolName, verdict: Verdict) => void;
}

/** Only four digits count as a read-back; anything else is dropped, and the engine then denies an AUTHORIZED. */
const readBackDigits = (value: unknown) => (typeof value === "string" ? value.replace(/\D/g, "") : "");

export async function submitDecision(ctx: DecisionContext, tool: ToolName, verdict: Verdict, readBack?: unknown): Promise<string> {
  const digits = readBackDigits(readBack);
  const res = await fetch("/api/governor/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paymentId: ctx.paymentId,
      challengeId: ctx.challengeId,
      ...(verdict === "AUTHORIZED" ? { responderToken: ctx.responderToken, ...(digits.length === 4 ? { beneficiaryLast4ReadBack: digits } : {}) } : {}),
      verdict,
      toolInvoked: tool,
      transcript: ctx.transcript(),
      durationSec: (Date.now() - ctx.startedAt) / 1000,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; payment?: { status: string } };
  if (!res.ok) return `Governor rejected the decision: ${body.error ?? res.status}`;
  ctx.onDecided?.(tool, verdict);
  return `Payment ${ctx.paymentId} is now ${body.payment?.status}.`;
}

/**
 * Tool handlers for `startSession({ clientTools })`. The verdict comes from which tool the agent calls and, for
 * freeze_payment, from the structured `outcome` enum; free text is never parsed. Anything other than exactly
 * "denied" freezes as INCONCLUSIVE, so a malformed call still fails closed. approve_payment carries the digits the
 * vendor read back; the engine compares them with the case and denies on a mismatch or when they are missing.
 */
export function createClientTools(ctx: DecisionContext) {
  return {
    freeze_payment: async (params: { outcome?: unknown; reason?: string }) =>
      submitDecision(ctx, "freeze_payment", params?.outcome === "denied" ? "DENIED" : "INCONCLUSIVE"),
    approve_payment: async (params: { last4_read_back?: unknown }) => submitDecision(ctx, "approve_payment", "AUTHORIZED", params?.last4_read_back),
  };
}

/** Tool schema as configured on the ElevenLabs agent (mirrors agent.config.md). */
export const TOOL_SCHEMA = [
  {
    type: "client",
    name: "freeze_payment",
    description:
      "Quarantine the pending wire. Call when the vendor controller denies authorizing the bank change, cannot confirm it, or the call is otherwise inconclusive.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["denied", "inconclusive"] satisfies FreezeOutcome[],
          description: "\"denied\" when the controller says the change was not authorized; \"inconclusive\" for anything else.",
        },
        reason: { type: "string", description: "Short note for the audit record. Not used to decide the outcome." },
      },
      required: ["outcome"],
    },
    expects_response: true,
  },
  {
    type: "client",
    name: "approve_payment",
    description:
      "Request release of the pending wire. Call ONLY after the controller explicitly confirms their treasury team authorized the change and reads back the last 4 digits of the new account.",
    parameters: {
      type: "object",
      properties: {
        last4_read_back: {
          type: "string",
          description: "The last 4 digits of the new account exactly as the controller read them. Never suggest or repeat digits yourself.",
        },
      },
      required: ["last4_read_back"],
    },
    expects_response: true,
  },
] as const;
