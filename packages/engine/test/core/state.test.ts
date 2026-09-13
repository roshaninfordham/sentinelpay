import assert from "node:assert/strict";
import { test } from "node:test";
import { isTerminal, transition, type TransitionInput } from "../../src/core/state";
import type { PaymentState } from "../../src/core/types";

const STATES: PaymentState[] = ["RECEIVED", "PENDING_REVIEW", "INVESTIGATING", "CHALLENGING", "QUARANTINED", "CLEARED"];
const INPUTS: TransitionInput[] = [
  "GATE_MATCH", "GATE_MISMATCH", "PREVIOUSLY_DENIED", "TAKE_LEASE", "OPEN_CHALLENGE", "NO_CHALLENGE_CHANNEL",
  "AUTHORIZE", "DENY", "INCONCLUSIVE", "EXPIRE", "BLOCK",
];

// The complete §4.1 table. Every pair not listed here must be INVALID_TRANSITION.
const ALLOWED: Record<string, PaymentState> = {
  "RECEIVED GATE_MATCH": "CLEARED",
  "RECEIVED GATE_MISMATCH": "PENDING_REVIEW",
  "RECEIVED PREVIOUSLY_DENIED": "QUARANTINED",
  "PENDING_REVIEW TAKE_LEASE": "INVESTIGATING",
  "PENDING_REVIEW BLOCK": "QUARANTINED",
  "INVESTIGATING TAKE_LEASE": "INVESTIGATING",
  "INVESTIGATING OPEN_CHALLENGE": "CHALLENGING",
  "INVESTIGATING NO_CHALLENGE_CHANNEL": "QUARANTINED",
  "INVESTIGATING BLOCK": "QUARANTINED",
  "CHALLENGING AUTHORIZE": "CLEARED",
  "CHALLENGING DENY": "QUARANTINED",
  "CHALLENGING INCONCLUSIVE": "QUARANTINED",
  "CHALLENGING EXPIRE": "QUARANTINED",
  "CHALLENGING BLOCK": "QUARANTINED",
};

test("exhaustive transition table: every (state x input) is allowed or INVALID_TRANSITION", () => {
  let checked = 0;
  for (const state of STATES) {
    for (const input of INPUTS) {
      const expected = ALLOWED[`${state} ${input}`];
      if (expected) assert.equal(transition(state, input), expected, `${state} ${input}`);
      else assert.throws(() => transition(state, input), (e: { code?: string }) => e.code === "INVALID_TRANSITION", `${state} ${input}`);
      checked++;
    }
  }
  assert.equal(checked, STATES.length * INPUTS.length);
});

test("terminal states are immutable and only CLEARED/QUARANTINED are terminal", () => {
  assert.deepEqual(STATES.filter(isTerminal), ["QUARANTINED", "CLEARED"]);
  for (const state of ["CLEARED", "QUARANTINED"] as const) {
    for (const input of INPUTS) assert.throws(() => transition(state, input));
  }
});
