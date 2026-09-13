import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGate } from "../../src/core/gate";
import type { StoredPayment } from "../../src/core/types";
import { MERIDIAN, clean, poisoned, setup, spyRail } from "./helpers";

const stored = (p: { beneficiary: StoredPayment["beneficiary"] } & Omit<StoredPayment, "beneficiary">): StoredPayment => p;

test("gate: matching beneficiary and domain → no mismatches", () => {
  assert.deepEqual(evaluateGate(stored(clean()), MERIDIAN), []);
});

test("gate: last4 mismatch", () => {
  assert.deepEqual(evaluateGate(stored(clean({ beneficiary: { accountLast4: "9821" } })), MERIDIAN), [
    { code: "BENEFICIARY_CHANGED", onFile: "4471", claimed: "9821" },
  ]);
});

test("gate: domain mismatch", () => {
  assert.deepEqual(evaluateGate(stored(clean({ requestSourceDomain: "meridian-global.co" })), MERIDIAN), [
    { code: "DOMAIN_MISMATCH", onFile: "meridianglobal.com", claimed: "meridian-global.co" },
  ]);
});

test("gate: both mismatches", () => {
  assert.deepEqual(evaluateGate(stored(poisoned()), MERIDIAN).map((m) => m.code), ["BENEFICIARY_CHANGED", "DOMAIN_MISMATCH"]);
});

test("gate: domain compare is case-insensitive", () => {
  assert.deepEqual(evaluateGate(stored(clean({ requestSourceDomain: "MeridianGlobal.COM" })), MERIDIAN), []);
});

test("gate: fingerprint compare beats last4", () => {
  const vendor = { ...MERIDIAN, knownAccountFingerprint: "fp_on_file" };
  const sameLast4OtherAccount = { ...clean(), beneficiary: { accountLast4: "4471", accountFingerprint: "fp_other" } };
  assert.deepEqual(evaluateGate(sameLast4OtherAccount, vendor).map((m) => m.code), ["BENEFICIARY_CHANGED"]);
  const sameAccount = { ...clean(), beneficiary: { accountLast4: "4471", accountFingerprint: "fp_on_file" } };
  assert.deepEqual(evaluateGate(sameAccount, vendor), []);
});

test("rail readBeneficiary overrides the caller's beneficiary before the gate", async () => {
  let ledger: () => Promise<Array<{ event: string }>> = async () => [];
  const rail = spyRail(() => ledger(), "9821");
  const { engine, storage } = setup({ rail });
  ledger = () => storage.ledger();
  const v = await engine.verify(clean()); // caller claims the on-file ••4471; the rail says ••9821
  assert.equal(v.state, "PENDING_REVIEW");
  assert.deepEqual(v.mismatches, [{ code: "BENEFICIARY_CHANGED", onFile: "4471", claimed: "9821" }]);
  assert.equal(v.beneficiary.strength, "rail");
  assert.equal(v.beneficiary.last4, "9821");
});

test("rail readBeneficiary throwing yields a BENEFICIARY_CHANGED mismatch with claimed unknown", async () => {
  const rail = { id: "broken", environment: "test" as const, readBeneficiary: async () => { throw new Error("rail down"); }, release: async () => ({ reference: "x", status: "x" }) };
  const { engine } = setup({ rail });
  const v = await engine.verify(clean());
  assert.equal(v.state, "PENDING_REVIEW");
  assert.deepEqual(v.mismatches, [{ code: "BENEFICIARY_CHANGED", onFile: "4471", claimed: "unknown" }]);
  assert.equal(v.beneficiary.strength, "last4");
});

test("a known routing number catches a same-last4 account at a different bank", () => {
  const vendor = { ...MERIDIAN, knownRoutingNumber: "071000013" };
  const sameBank = stored(clean({ beneficiary: { accountLast4: "4471", routingNumber: "071000013" } }));
  assert.deepEqual(evaluateGate(sameBank, vendor), []);
  const otherBank = stored(clean({ beneficiary: { accountLast4: "4471", routingNumber: "121000248" } }));
  assert.deepEqual(evaluateGate(otherBank, vendor), [{ code: "BENEFICIARY_CHANGED", onFile: "4471 at routing ••0013", claimed: "4471 at routing ••0248" }]);
  // No routing on file or none supplied: last4 decides, as before.
  assert.deepEqual(evaluateGate(otherBank, MERIDIAN), []);
  assert.deepEqual(evaluateGate(stored(clean({ beneficiary: { accountLast4: "4471" } })), vendor), []);
});
