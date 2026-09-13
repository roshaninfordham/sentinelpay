import { EngineError, type ChallengeAnswers, type ChallengeEvidence, type Principal } from "payfirewall";
import { APP_OPERATOR, getRuntime } from "./engine";
import { buildReceipt, type IncidentReceipt } from "./receipt";
import type { CallOutcome, Verdict } from "./types";
import { endVoiceSession } from "./voice/browser-challenger";

// Compatibility shim: Node 4 (settlement governor) is the engine's challenge resolution.
// Fail-closed: moving toward QUARANTINED needs no token; AUTHORIZED needs the challenge's responder token (§4.3).

export class GovernorError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export interface DecideInput {
  paymentId: string;
  verdict: Verdict;
  /** Required with responderToken for AUTHORIZED: both come from /api/voice/token for the open challenge. */
  challengeId?: string;
  responderToken?: string;
  /** Last 4 digits the vendor read back on the call; voice_browser requires it to authorize. */
  beneficiaryLast4ReadBack?: string;
  /** The authenticated operator (production). Makes the answer person-authenticated, so self-approval is refused. */
  responder?: Principal;
  transcript?: string;
  toolInvoked?: CallOutcome["toolInvoked"];
  durationSec?: number;
}

export async function decide(input: DecideInput): Promise<IncidentReceipt> {
  const { engine, loadCase, client } = await getRuntime();
  const c = await loadCase({ paymentId: input.paymentId });

  // Check order is part of the contract: terminal, then not gated, then not challenging, then the token.
  if (c && (c.state === "QUARANTINED" || c.state === "CLEARED")) {
    return buildReceipt(c.paymentId); // idempotent: a repeated tool call returns the existing receipt
  }
  if (!c || c.state === "RECEIVED") throw new GovernorError("payment has not been through the gate");

  const evidence: ChallengeEvidence = {
    ...(input.transcript ? { transcript: input.transcript } : {}),
    durationSec: Math.max(0, input.durationSec ?? 0),
    tool: input.toolInvoked ?? null,
  };

  try {
    if (c.state !== "CHALLENGING" || !c.challenge) {
      if (input.verdict === "AUTHORIZED") throw new GovernorError("authorization requires a completed out-of-band challenge");
      // Freezing before a challenge opens is always allowed; it is a block by the operator console.
      await engine.block(c.paymentId, { reason: `operator decision ${input.verdict} before the challenge opened`, principal: input.responder ?? APP_OPERATOR });
      return buildReceipt(c.paymentId);
    }

    const { challengeId } = c.challenge;
    const responder = input.responder ? { responder: input.responder } : {};
    if (input.verdict === "AUTHORIZED") {
      if (!input.challengeId || !input.responderToken) {
        throw new GovernorError("AUTHORIZED requires challengeId and responderToken", 403);
      }
      // Same answer as a wrong token, so the route does not confirm which challenge belongs to which payment.
      if (input.challengeId !== challengeId) throw new GovernorError("responder token is invalid", 401);
      const answers: ChallengeAnswers = {
        authorizedChange: "yes",
        ...(input.beneficiaryLast4ReadBack ? { beneficiaryLast4ReadBack: input.beneficiaryLast4ReadBack } : {}),
      };
      await engine.resolveChallenge({ challengeId, verdict: "AUTHORIZED", responderToken: input.responderToken, answers, evidence, ...responder });
      await endVoiceSession(client, challengeId);
    } else {
      await engine.resolveChallenge({ challengeId, verdict: input.verdict, evidence, ...responder });
    }
  } catch (err) {
    if (err instanceof EngineError) throw new GovernorError(err.message, err.httpStatus);
    throw err;
  }
  return buildReceipt(c.paymentId);
}
