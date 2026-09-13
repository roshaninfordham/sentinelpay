import { EngineError, type PaymentState } from "./types";

// Pure state machine (§4.1). Every engine state change goes through transition(); terminal states accept nothing.

export type TransitionInput =
  | "GATE_MATCH" | "GATE_MISMATCH" | "PREVIOUSLY_DENIED"
  | "TAKE_LEASE" | "OPEN_CHALLENGE" | "NO_CHALLENGE_CHANNEL"
  | "AUTHORIZE" | "DENY" | "INCONCLUSIVE" | "EXPIRE" | "BLOCK";

export const TRANSITIONS: Readonly<Record<PaymentState, Partial<Record<TransitionInput, PaymentState>>>> = {
  RECEIVED: { GATE_MATCH: "CLEARED", GATE_MISMATCH: "PENDING_REVIEW", PREVIOUSLY_DENIED: "QUARANTINED" },
  PENDING_REVIEW: { TAKE_LEASE: "INVESTIGATING", BLOCK: "QUARANTINED" },
  // TAKE_LEASE from INVESTIGATING is the retake after an expired step lease.
  INVESTIGATING: { TAKE_LEASE: "INVESTIGATING", OPEN_CHALLENGE: "CHALLENGING", NO_CHALLENGE_CHANNEL: "QUARANTINED", BLOCK: "QUARANTINED" },
  CHALLENGING: { AUTHORIZE: "CLEARED", DENY: "QUARANTINED", INCONCLUSIVE: "QUARANTINED", EXPIRE: "QUARANTINED", BLOCK: "QUARANTINED" },
  QUARANTINED: {},
  CLEARED: {},
};

export const isTerminal = (s: PaymentState) => s === "CLEARED" || s === "QUARANTINED";

export function transition(from: PaymentState, input: TransitionInput): PaymentState {
  const to = TRANSITIONS[from][input];
  if (!to) throw new EngineError("INVALID_TRANSITION", `cannot apply ${input} in state ${from}`);
  return to;
}
