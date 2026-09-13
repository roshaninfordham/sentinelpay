import type { ChallengeRequest, Challenger, Verdict } from "../core/types";

/** Resolves synchronously with a fixed verdict. Assurance "test": refused in production and without allowTestChallengers. */
export function scriptedChallenger(verdict: Verdict | ((r: ChallengeRequest) => Verdict)): Challenger {
  return {
    channel: "scripted",
    assurance: "test",
    canHandle: () => true,
    async start(req) {
      return { status: "resolved", verdict: typeof verdict === "function" ? verdict(req) : verdict };
    },
  };
}
