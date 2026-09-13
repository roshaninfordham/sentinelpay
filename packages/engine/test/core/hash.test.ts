import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { GENESIS, fingerprintAccount, hashEntry, verifyEntries } from "../../src/core/hash";

const legacyHash = (seq: number, paymentId: string, event: string, payloadJson: string, prevHash: string) =>
  createHash("sha256").update(`${seq}|${paymentId}|${event}|${payloadJson}|${prevHash}`).digest("hex");

const VECTORS: Array<[number, string, string, string, string]> = [
  [1, "pay_240k", "FROZEN", JSON.stringify({ verdict: "DENIED" }), GENESIS],
  [2, "pay_18k", "CLEARED", JSON.stringify({ reason: "match" }), "ab".repeat(32)],
  [7, "pay_x", "INTERCEPTED", JSON.stringify({ mismatches: ["Beneficiary changed: ••4471 → ••9821"], note: "ünïcødé ✓" }), "0f".repeat(32)],
  [42, "p", "CALL_RESULT", "null", GENESIS],
];

test("Web Crypto hashEntry equals the legacy node:crypto output on golden vectors", async () => {
  for (const v of VECTORS) assert.equal(await hashEntry(...v), legacyHash(...v));
});

test("hashEntry is pinned to a literal digest, independent of node:crypto", async () => {
  assert.equal(
    await hashEntry(1, "pay_240k", "FROZEN", '{"verdict":"DENIED"}', GENESIS),
    "2ffd4bfa5b4bd967c65c5b4fe668f832807b3ea0004709a478aa66a8a76521bd",
  );
});

test("verifyEntries accepts a legacy-built chain and reports the first tampered seq", async () => {
  const entries = [];
  let prev = GENESIS;
  for (const [i, payload] of [{ verdict: "DENIED" }, { reason: "match" }, { n: 3 }].entries()) {
    const payloadJson = JSON.stringify(payload);
    const entryHash = legacyHash(i + 1, "pay_1", "FROZEN", payloadJson, prev);
    entries.push({ seq: i + 1, paymentId: "pay_1", event: "FROZEN" as const, payload, payloadJson, prevHash: prev, entryHash, ts: "t" });
    prev = entryHash;
  }
  assert.deepEqual(await verifyEntries(entries), { ok: true, length: 3 });
  entries[1] = { ...entries[1], payloadJson: JSON.stringify({ reason: "AUTHORIZED" }) };
  assert.deepEqual(await verifyEntries(entries), { ok: false, brokenAt: 2, length: 3 });
});

test("fingerprintAccount is HMAC-SHA256(key, routing|account)", async () => {
  const expected = createHmac("sha256", "k".repeat(32)).update("021000021|000123459821").digest("hex");
  assert.equal(await fingerprintAccount("k".repeat(32), "021000021", "000123459821"), expected);
});
