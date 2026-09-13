import assert from "node:assert/strict";
import { test } from "node:test";
import { columnRail } from "../../src/adapters/column";
import { memoryStorage } from "../../src/adapters/memory";
import { ConfigError, type Rail } from "../../src/core/types";
import { clean, eventsOf, poisoned, setup } from "../core/helpers";
import { stubFetch, type RecordedCall } from "./stub-fetch";

const KEY = "test_sandbox_key" as const;
const COUNTERPARTIES = { pay_240k: "cpty_attacker", pay_18k: "cpty_northwind" };

/** Column sandbox stub: counterparty accounts are mutable so a test can edit one at the rail mid-flight. */
function columnStub(accounts: Record<string, string>) {
  return stubFetch((call) => {
    const cp = call.url.match(/\/counterparties\/(\w+)$/);
    if (cp && accounts[cp[1]]) return Response.json({ id: cp[1], account_number: accounts[cp[1]], routing_number: "121000248" });
    if (call.url.endsWith("/transfers/wire")) return Response.json({ id: "wire_123", amount: 1_800_000, currency_code: "USD", status: "initiated" });
    return Response.json({ message: "not found" }, { status: 404 });
  });
}

const rail = (fetch: typeof globalThis.fetch): Rail => columnRail({ apiKey: KEY, bankAccountId: "bacc_ap", counterparties: COUNTERPARTIES, fetch });
const wires = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith("/transfers/wire"));

test("columnRail refuses non-test_ keys with ConfigError", () => {
  for (const apiKey of ["live_abc", "sk_live_abc", "", "TEST_abc"]) {
    assert.throws(() => columnRail({ apiKey: apiKey as `test_${string}`, bankAccountId: "bacc_ap", counterparties: {} }), ConfigError);
  }
  assert.equal(columnRail({ apiKey: KEY, bankAccountId: "bacc_ap", counterparties: {} }).environment, "sandbox");
});

test("readBeneficiary reads last4 from the mapped counterparty; the payment's own counterparty id wins", async () => {
  const { fetch, calls } = columnStub({ cpty_attacker: "770001939821", cpty_other: "111122223333" });
  const r = rail(fetch);
  assert.deepEqual(await r.readBeneficiary!(poisoned({ beneficiary: { accountLast4: "4471" } })), { accountLast4: "9821" });
  assert.equal(calls[0].url, "https://api.column.com/counterparties/cpty_attacker");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, `Basic ${btoa(`:${KEY}`)}`);
  assert.deepEqual(await r.readBeneficiary!(poisoned({ beneficiary: { accountLast4: "4471", railCounterpartyId: "cpty_other" } })), { accountLast4: "3333" });
  await assert.rejects(r.readBeneficiary!(clean({ id: "pay_unmapped" })), /no Column counterparty/);
  await assert.rejects(r.readBeneficiary!(clean({ id: "pay_18k" })), /404/);
});

test("release: Basic ':key' auth, form-encoded wire, Idempotency-Key payfirewall-{paymentId}", async () => {
  const { fetch, calls } = columnStub({});
  const released = await rail(fetch).release(clean({ memo: "Invoice 118" }), { idempotencyKey: "payfirewall-pay_18k" });
  assert.deepEqual(released, { reference: "wire_123", status: "initiated" });
  const [wire] = wires(calls);
  assert.equal(wire.method, "POST");
  assert.equal(wire.url, "https://api.column.com/transfers/wire");
  assert.equal(wire.headers.Authorization, `Basic ${Buffer.from(`:${KEY}`).toString("base64")}`);
  assert.equal(wire.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(wire.headers["Idempotency-Key"], "payfirewall-pay_18k");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(wire.body)), {
    currency_code: "USD", bank_account_id: "bacc_ap", counterparty_id: "cpty_northwind", amount: "1800000", description: "Invoice 118",
  });
});

test("release never invents a reference: a response without an id or a non-2xx rejects", async () => {
  const noId = stubFetch(() => Response.json({ status: "initiated" }));
  await assert.rejects(rail(noId.fetch).release(clean(), { idempotencyKey: "payfirewall-pay_18k" }), /no id/);
  const failed = stubFetch(() => Response.json({ message: "insufficient funds" }, { status: 400 }));
  await assert.rejects(rail(failed.fetch).release(clean(), { idempotencyKey: "payfirewall-pay_18k" }), /400 insufficient funds/);
});

test("engine + columnRail: clean payment reads the rail beneficiary and creates one sandbox wire", async () => {
  const { fetch, calls } = columnStub({ cpty_northwind: "500045104471" });
  const { engine, storage } = setup({ environment: "sandbox", rail: rail(fetch) });
  const v = await engine.verify(clean());
  assert.equal(v.state, "CLEARED");
  assert.equal(v.beneficiary.strength, "rail");
  const settled = await engine.get("pay_18k");
  assert.equal(settled.decision, "PAY");
  assert.deepEqual(settled.rail, { status: "RELEASED", reference: "wire_123" });
  assert.equal(wires(calls).length, 1);
  assert.equal(wires(calls)[0].headers["Idempotency-Key"], "payfirewall-pay_18k");
  assert.deepEqual(await eventsOf(storage, "pay_18k"), ["CLEARED", "RAIL_RELEASED"]);
});

test("engine + columnRail: the gate uses the rail's account (9821), and a freeze creates zero wires", async () => {
  const { fetch, calls } = columnStub({ cpty_attacker: "770001939821" });
  const { engine, starts } = setup({ environment: "sandbox", rail: rail(fetch) });
  // The caller claims the on-file account; the rail's counterparty record is what counts.
  const v1 = await engine.verify(poisoned({ beneficiary: { accountLast4: "4471" } }));
  assert.equal(v1.state, "PENDING_REVIEW");
  assert.deepEqual(v1.mismatches[0], { code: "BENEFICIARY_CHANGED", onFile: "4471", claimed: "9821" });

  await engine.advance("pay_240k");
  const v3 = await engine.resolveChallenge({ challengeId: starts[0].challengeId, verdict: "DENIED" });
  assert.equal(v3.state, "QUARANTINED");
  assert.equal(v3.rail.reference, undefined);
  assert.equal(wires(calls).length, 0);
});

test("engine + columnRail: counterparty edited at Column after CLEARED -> no wire, DO_NOT_PAY RAIL_BENEFICIARY_DRIFT", async () => {
  const accounts = { cpty_northwind: "500045104471" };
  const { fetch, calls } = columnStub(accounts);
  const storage = memoryStorage();
  const base = rail(fetch);
  // Swap the account between the verify-time read and the post-CLEARED re-read.
  let reads = 0;
  const swapping: Rail = {
    ...base,
    async readBeneficiary(p) {
      const r = await base.readBeneficiary!(p);
      if (++reads === 1) accounts.cpty_northwind = "999900009821";
      return r;
    },
  };
  const { engine } = setup({ environment: "sandbox", storage, rail: swapping });
  await engine.verify(clean());
  const v = await engine.get("pay_18k");
  assert.equal(v.state, "CLEARED");
  assert.equal(v.decision, "DO_NOT_PAY");
  assert.equal(v.reason, "RAIL_BENEFICIARY_DRIFT");
  assert.deepEqual(v.rail, { status: "FAILED" });
  assert.equal(reads, 2);
  assert.equal(wires(calls).length, 0);
  const railError = (await storage.ledger()).find((e) => e.event === "RAIL_ERROR");
  assert.deepEqual(railError?.payload, { reason: "RAIL_BENEFICIARY_DRIFT", verifiedLast4: "4471", railLast4: "9821" });
});
