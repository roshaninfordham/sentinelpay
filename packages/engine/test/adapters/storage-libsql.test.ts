import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createClient, type Client } from "@libsql/client";
import { libsqlStorage, libsqlVendors } from "../../src/adapters/libsql";
import { hashEntry, verifyEntries } from "../../src/core/hash";
import type { CaseRecord, StoredLedgerEntry } from "../../src/core/types";
import { runStorageContract } from "../../src/testing";

const dir = mkdtempSync(path.join(tmpdir(), "payfirewall-libsql-"));
const clients: Client[] = [];
let n = 0;

async function storageOn(url: string, opts?: Parameters<typeof libsqlStorage>[1]) {
  const client = createClient({ url });
  clients.push(client);
  const storage = libsqlStorage(client, opts);
  await storage.migrate();
  return { client, storage };
}

const fileUrl = () => `file:${path.join(dir, `contract-${++n}.db`)}`;

after(() => clients.forEach((c) => c.close()));

runStorageContract("libsql (:memory:)", async () => (await storageOn(":memory:")).storage);
runStorageContract("libsql (file)", async () => (await storageOn(fileUrl())).storage);

const TS = "2026-01-01T00:00:00.000Z";
const record = (paymentId: string, version = 1): CaseRecord => ({
  paymentId, version, idempotencyKey: `key_${paymentId}`, requestFingerprint: "fp", requestedBy: "agent:test",
  payment: { id: paymentId, vendorId: "v_1", amountCents: 100, currency: "USD", beneficiary: { accountLast4: "1234" }, requestSourceDomain: "vendor.example" },
  vendorSnapshot: { id: "v_1", legalName: "Vendor LLC", knownDomain: "vendor.example", knownBankLast4: "1234" },
  state: "PENDING_REVIEW", reason: "UNDER_INVESTIGATION", mismatches: [], rail: { status: "NOT_CONFIGURED" }, updatedAt: TS,
});

test("libsql: migrate is idempotent and keeps the app's ledger DDL and hash format", async () => {
  const { client, storage } = await storageOn(fileUrl());
  await storage.migrate();
  const cols = (await client.execute("PRAGMA table_info(ledger)")).rows.map((r) => r.name);
  assert.deepEqual(cols, ["seq", "paymentId", "event", "payload_json", "prevHash", "entryHash", "ts"]);

  // A row written the legacy way (raw INSERT, same hash formula) chains with engine commits.
  const legacyHash = await hashEntry(1, "pay_old", "INTERCEPTED", "{\"legacy\":true}", "0".repeat(64));
  await client.execute({
    sql: "INSERT INTO ledger (seq, paymentId, event, payload_json, prevHash, entryHash, ts) VALUES (1, 'pay_old', 'INTERCEPTED', ?, ?, ?, ?)",
    args: ["{\"legacy\":true}", "0".repeat(64), legacyHash, TS],
  });
  const [entry] = await storage.commit(record("pay_new"), 0, [{ event: "CLEARED", payload: { reason: "match" } }]);
  assert.equal(entry.seq, 2);
  assert.equal(entry.prevHash, legacyHash);
  assert.deepEqual(await verifyEntries((await storage.ledger()) as StoredLedgerEntry[]), { ok: true, length: 2 });

  await client.execute("UPDATE ledger SET payload_json = '{\"legacy\":false}' WHERE seq = 1");
  assert.equal((await verifyEntries((await storage.ledger()) as StoredLedgerEntry[])).ok, false);
});

test("libsql: onCommit runs inside the commit transaction and its failure rolls everything back", async () => {
  let fail = false;
  const { client, storage } = await storageOn(fileUrl(), {
    async onCommit(tx, next) {
      await tx.execute({ sql: "INSERT INTO status_mirror (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", args: [next.paymentId, next.state] });
      if (fail) throw new Error("host hook failed");
    },
  });
  await client.execute("CREATE TABLE status_mirror (id TEXT PRIMARY KEY, status TEXT NOT NULL)");

  await storage.commit(record("pay_x"), 0, [{ event: "INTERCEPTED", payload: {} }]);
  const status = async () => (await client.execute("SELECT status FROM status_mirror WHERE id = 'pay_x'")).rows[0]?.status;
  assert.equal(await status(), "PENDING_REVIEW");

  fail = true;
  await assert.rejects(storage.commit({ ...record("pay_x", 2), state: "QUARANTINED" }, 1, [{ event: "FROZEN", payload: {} }]), /host hook failed/);
  assert.equal(await status(), "PENDING_REVIEW");
  assert.equal((await storage.load({ paymentId: "pay_x" }))?.version, 1);
  assert.deepEqual((await storage.ledger()).map((e) => e.event), ["INTERCEPTED"]);
});

test("libsql: the adapter never names app tables", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/adapters/libsql.ts", import.meta.url), "utf8");
  const storageSrc = src.slice(0, src.indexOf("interface VendorRow"));
  const tables = [...storageSrc.matchAll(/\b(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?|ON)\s+(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ["cases", "ledger"]);
});

test("libsqlVendors maps a host vendors table, omitting null optional columns", async () => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await client.executeMultiple(`
    CREATE TABLE vendors (id TEXT PRIMARY KEY, legalName TEXT NOT NULL, knownDomain TEXT NOT NULL, knownBankLast4 TEXT NOT NULL, verifiedPhone TEXT, registryUrl TEXT);
    INSERT INTO vendors VALUES ('v_meridian', 'Meridian Global Logistics LLC', 'meridianglobal.com', '4471', NULL, NULL);
    INSERT INTO vendors VALUES ('v_northwind', 'Northwind Freight Partners Inc.', 'northwindfreight.com', '2208', '(206) 555-0143', NULL);
  `);
  const vendors = libsqlVendors(client);
  assert.deepEqual(await vendors.get("v_meridian"), { id: "v_meridian", legalName: "Meridian Global Logistics LLC", knownDomain: "meridianglobal.com", knownBankLast4: "4471" });
  assert.equal((await vendors.get("v_northwind"))?.verifiedPhone, "(206) 555-0143");
  assert.equal(await vendors.get("v_missing"), null);
});
