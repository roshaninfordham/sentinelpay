import assert from "node:assert/strict";
import { test } from "node:test";
import { liveTokenBody, simulatedTokenBody } from "./token-response";

const base = { challengeId: "chl_1", responderToken: "tok", dynamicVariables: { vendor: "Meridian Global Logistics LLC", oldLast4: "4471" } };

test("a live voice token response never carries the new account digits", () => {
  const body = liveTokenBody(base, "conv_token");
  assert.equal("beneficiaryLast4" in body, false);
  assert.doesNotMatch(JSON.stringify(body), /9821/);
});

test("only the scripted demo call receives the digits its simulated vendor reads back", () => {
  const body = simulatedTokenBody(base, "DEMO_MODE=cache", "9821");
  assert.equal(body.mode, "simulated");
  assert.equal(body.mode === "simulated" && body.beneficiaryLast4, "9821");
});
