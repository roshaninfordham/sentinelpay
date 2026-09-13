import assert from "node:assert/strict";
import { test } from "node:test";
import { createEngine } from "../../src/core/engine";
import { ConfigError, type Challenger, type EngineConfig } from "../../src/core/types";
import { humanApprovalChallenger } from "../../src/challengers/human-approval";
import { scriptedChallenger } from "../../src/testing";
import { clean, setup } from "./helpers";

const base = (): EngineConfig => {
  const { config } = setup();
  return config;
};

const refuses = (config: EngineConfig, pattern: RegExp) =>
  assert.throws(() => createEngine(config), (e: Error) => e instanceof ConfigError && pattern.test(e.message));

const voiceBrowser = (operatorAuth?: boolean): Challenger => ({
  channel: "voice_browser", assurance: "operator_session", operatorAuth,
  canHandle: () => true, start: async () => ({ status: "pending" }),
});

const approval = humanApprovalChallenger({ approvalBaseUrl: "https://x/approve", deliver: async () => {} });

test("refuses a missing environment", () => {
  refuses({ ...base(), environment: undefined as never }, /environment/);
});

test("refuses scriptedChallenger in production, and outside production without allowTestChallengers", () => {
  refuses({ ...base(), environment: "production", challengers: [scriptedChallenger("DENIED")], allowTestChallengers: true }, /production/);
  refuses({ ...base(), environment: "production", challengers: [scriptedChallenger("DENIED")], allowTestChallengers: undefined }, /production/);
  refuses({ ...base(), challengers: [scriptedChallenger("DENIED")], allowTestChallengers: undefined }, /allowTestChallengers/);
  assert.ok(createEngine({ ...base(), challengers: [scriptedChallenger("DENIED")], allowTestChallengers: true }));
});

test("refuses voice_browser in production without operator auth", () => {
  refuses({ ...base(), environment: "production", allowTestChallengers: undefined, challengers: [voiceBrowser()] }, /operatorAuth/);
  assert.ok(createEngine({ ...base(), environment: "production", allowTestChallengers: undefined, challengers: [voiceBrowser(true), approval] }));
  assert.ok(createEngine({ ...base(), environment: "sandbox", allowTestChallengers: undefined, challengers: [voiceBrowser()] }));
});

test("refuses a rail whose environment differs from the engine's", () => {
  const rail = { id: "column", environment: "production" as const, release: async () => ({ reference: "r", status: "s" }) };
  refuses({ ...base(), rail }, /environment/);
});

test("refuses a tokenPepper shorter than 32 bytes", () => {
  refuses({ ...base(), secrets: { tokenPepper: "x".repeat(31) } }, /tokenPepper/);
  assert.ok(createEngine({ ...base(), secrets: { tokenPepper: "é".repeat(16) } }), "32 bytes of UTF-8 is enough");
});

test("refuses a short fingerprintKey and invalid numeric options", () => {
  refuses({ ...base(), secrets: { tokenPepper: "x".repeat(32), fingerprintKey: "short" } }, /fingerprintKey/);
  refuses({ ...base(), maxTokenAttempts: 0 }, /maxTokenAttempts/);
  refuses({ ...base(), challengeTtlMs: -1 }, /challengeTtlMs/);
});

test("accountNumber is refused at verify when no fingerprintKey is configured", async () => {
  const engine = createEngine(base());
  await assert.rejects(
    engine.verify(clean({ beneficiary: { accountLast4: "4471", accountNumber: "000000004471" } })),
    (e: { code?: string; path?: string }) => e.code === "INVALID_INPUT" && e.path === "/payment/beneficiary/accountNumber",
  );
});
