// The one module in the engine that imports node:*: it IS a node:test suite (§7.2), used only by adapter test files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { verifyEntries } from "../core/hash";
import type { CaseRecord, LedgerEntry, Storage, StoredLedgerEntry } from "../core/types";

const TS = "2026-01-01T00:00:00.000Z";

function record(paymentId: string, overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    paymentId,
    version: 1,
    idempotencyKey: `key_${paymentId}`,
    requestFingerprint: `fp_${paymentId}`,
    requestedBy: "agent:test",
    payment: {
      id: paymentId, vendorId: "v_1", amountCents: 100, currency: "USD",
      beneficiary: { accountLast4: "1234" }, requestSourceDomain: "vendor.example",
    },
    vendorSnapshot: { id: "v_1", legalName: "Vendor LLC", knownDomain: "vendor.example", knownBankLast4: "1234" },
    state: "PENDING_REVIEW",
    reason: "UNDER_INVESTIGATION",
    mismatches: [],
    rail: { status: "NOT_CONFIGURED" },
    updatedAt: TS,
    ...overrides,
  };
}

const withChallenge = (c: CaseRecord, challengeId: string): CaseRecord => ({
  ...c,
  state: "CHALLENGING",
  challenge: {
    challengeId, channel: "scripted", assurance: "test", status: "OPEN", expiresAt: TS,
    responderTokenHash: "a".repeat(64), badTokenAttempts: 0, startAttempts: 0,
  },
});

const isVersionConflict = (err: unknown) => (err as { code?: string }).code === "VERSION_CONFLICT";

const stored = (entries: LedgerEntry[]) => entries as StoredLedgerEntry[];

export function runStorageContract(name: string, make: () => Promise<Storage>): void {
  describe(`Storage contract: ${name}`, () => {
    test("insert at version 0, then load by paymentId, idempotencyKey and challengeId", async () => {
      const s = await make();
      const c = withChallenge(record("pay_a"), "chl_a");
      const entries = await s.commit(c, 0, [{ event: "INTERCEPTED", payload: { n: 1 } }]);
      assert.equal(entries.length, 1);
      assert.deepEqual(await s.load({ paymentId: "pay_a" }), c);
      assert.deepEqual(await s.load({ idempotencyKey: "key_pay_a" }), c);
      assert.deepEqual(await s.load({ challengeId: "chl_a" }), c);
      assert.equal(await s.load({ paymentId: "pay_missing" }), null);
      assert.equal(await s.load({ challengeId: "chl_missing" }), null);
      assert.equal(await s.load({ idempotencyKey: "key_missing" }), null);
    });

    test("CAS update succeeds at the stored version and rejects a stale one with VERSION_CONFLICT", async () => {
      const s = await make();
      const v1 = record("pay_b");
      await s.commit(v1, 0, []);
      const v2 = { ...v1, version: 2, state: "INVESTIGATING" as const };
      await s.commit(v2, 1, [{ event: "INVESTIGATION_STARTED", payload: { status: "INVESTIGATING" } }]);
      assert.equal((await s.load({ paymentId: "pay_b" }))?.state, "INVESTIGATING");

      await assert.rejects(s.commit({ ...v1, version: 2, state: "QUARANTINED" }, 1, []), isVersionConflict);
      await assert.rejects(s.commit(v1, 0, []), isVersionConflict);
      assert.equal((await s.load({ paymentId: "pay_b" }))?.version, 2);
    });

    test("idempotencyKey and challengeId are unique across cases", async () => {
      const s = await make();
      await s.commit(withChallenge(record("pay_c"), "chl_c"), 0, []);
      await assert.rejects(s.commit(record("pay_d", { idempotencyKey: "key_pay_c" }), 0, [{ event: "INTERCEPTED", payload: {} }]), isVersionConflict);
      await assert.rejects(s.commit(withChallenge(record("pay_e"), "chl_c"), 0, [{ event: "INTERCEPTED", payload: {} }]), isVersionConflict);
      assert.equal(await s.load({ paymentId: "pay_d" }), null);
      assert.equal(await s.load({ paymentId: "pay_e" }), null);
      assert.equal((await s.ledger()).length, 0);
    });

    test("a failed commit leaves neither state nor ledger changed", async () => {
      const s = await make();
      const v1 = record("pay_f");
      await s.commit(v1, 0, [{ event: "INTERCEPTED", payload: { a: 1 } }]);
      const before = { case: await s.load({ paymentId: "pay_f" }), ledger: await s.ledger() };
      await assert.rejects(
        s.commit({ ...v1, version: 3, state: "QUARANTINED" }, 2, [{ event: "CALL_RESULT", payload: {} }, { event: "FROZEN", payload: {} }]),
        isVersionConflict,
      );
      assert.deepEqual({ case: await s.load({ paymentId: "pay_f" }), ledger: await s.ledger() }, before);
    });

    test("ledger entries carry payloadJson, filter by paymentId and chain from GENESIS", async () => {
      const s = await make();
      await s.commit(record("pay_g"), 0, [{ event: "INTERCEPTED", payload: { mismatches: ["x"] } }]);
      await s.commit(record("pay_h"), 0, [{ event: "CLEARED", payload: { reason: "match" } }]);
      await s.commit({ ...record("pay_g"), version: 2 }, 1, [{ event: "INVESTIGATION_STARTED", payload: null }]);

      const all = stored(await s.ledger());
      assert.deepEqual(all.map((e) => [e.seq, e.paymentId, e.event]), [
        [1, "pay_g", "INTERCEPTED"], [2, "pay_h", "CLEARED"], [3, "pay_g", "INVESTIGATION_STARTED"],
      ]);
      for (const e of all) {
        assert.equal(typeof e.payloadJson, "string");
        assert.deepEqual(JSON.parse(e.payloadJson), e.payload);
      }
      assert.deepEqual(await verifyEntries(all), { ok: true, length: 3 });
      assert.deepEqual((await s.ledger({ paymentId: "pay_g" })).map((e) => e.seq), [1, 3]);
    });

    test("50 concurrent commits produce a gap-free, verifiable chain; same-version racers yield one winner", async () => {
      const s = await make();
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          s.commit(record(`pay_${i}`), 0, [{ event: "INTERCEPTED", payload: { i } }, { event: "INVESTIGATION_STARTED", payload: { i } }]),
        ),
      );
      const chain = stored(await s.ledger());
      assert.deepEqual(chain.map((e) => e.seq), Array.from({ length: 100 }, (_, i) => i + 1));
      assert.deepEqual(await verifyEntries(chain), { ok: true, length: 100 });

      const racers = await Promise.allSettled(
        Array.from({ length: 10 }, () => s.commit({ ...record("pay_0"), version: 2 }, 1, [{ event: "FORENSICS", payload: {} }])),
      );
      assert.equal(racers.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(racers.every((r) => r.status === "fulfilled" || isVersionConflict(r.reason)));
      assert.equal((await s.ledger({ paymentId: "pay_0" })).filter((e) => e.event === "FORENSICS").length, 1);
    });

    test("list filters by states, vendorId, staleBefore and limit", async () => {
      const s = await make();
      await s.commit(record("pay_l1", { state: "PENDING_REVIEW", updatedAt: "2026-01-01T00:00:00.000Z" }), 0, []);
      await s.commit(record("pay_l2", { state: "CHALLENGING", updatedAt: "2026-01-02T00:00:00.000Z" }), 0, []);
      const other = record("pay_l3", { state: "QUARANTINED", updatedAt: "2026-01-03T00:00:00.000Z" });
      await s.commit({ ...other, payment: { ...other.payment, vendorId: "v_2" } }, 0, []);

      const ids = (cs: CaseRecord[]) => cs.map((c) => c.paymentId).sort();
      assert.deepEqual(ids(await s.list({})), ["pay_l1", "pay_l2", "pay_l3"]);
      assert.deepEqual(ids(await s.list({ states: ["PENDING_REVIEW", "CHALLENGING"] })), ["pay_l1", "pay_l2"]);
      assert.deepEqual(ids(await s.list({ vendorId: "v_2" })), ["pay_l3"]);
      assert.deepEqual(ids(await s.list({ staleBefore: "2026-01-02T12:00:00.000Z" })), ["pay_l1", "pay_l2"]);
      assert.equal((await s.list({ limit: 2 })).length, 2);
    });
  });
}
