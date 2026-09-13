import type { ChallengeRequest, Challenger } from "../core/types";

/**
 * Leaves the challenge open and hands the full ChallengeRequest (including the responder token) to the test,
 * which then plays the responder through engine.resolveChallenge.
 */
export function pendingChallenger(
  onStart?: (r: ChallengeRequest) => void,
  opts: { channel?: string; requireApproverSession?: boolean; canHandle?: Challenger["canHandle"] } = {},
): Challenger {
  return {
    channel: opts.channel ?? "scripted",
    assurance: "test",
    requireApproverSession: opts.requireApproverSession,
    canHandle: opts.canHandle ?? (() => true),
    async start(req) {
      onStart?.(req);
      return { status: "pending" };
    },
  };
}
