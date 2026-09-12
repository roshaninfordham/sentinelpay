import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "sentinel-column-"));
process.env.SENTINEL_DB_PATH = path.join(dir, "test.db");
process.env.COLUMN_CONFIG_PATH = path.join(dir, "column.json");
process.env.DEMO_MODE = "live";
process.env.DEMO_PACE_MS = "0";
process.env.PAYMENT_SOURCE = "column";
process.env.COLUMN_API_KEY = "test_sandbox_key";
delete process.env.TAVILY_API_KEY;

writeFileSync(
  process.env.COLUMN_CONFIG_PATH,
  JSON.stringify({
    createdAt: "2026-09-12T00:00:00Z",
    bankAccountId: "bacc_ap",
    accountNumberId: "acno_ap",
    paymentCounterparties: { pay_240k: "cpty_attacker", pay_18k: "cpty_northwind" },
    vendorCounterparties: { v_meridian: "cpty_meridian", v_northwind: "cpty_northwind" },
  }),
);

type Call = { method: string; url: string; body?: string; headers: Record<string, string> };
const calls: Call[] = [];
const counterparties: Record<string, string> = { cpty_attacker: "770001939821", cpty_northwind: "500045102208" };

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  // Forensics probes: fail fast so they fall back to fixtures.
  if (!url.startsWith("https://api.column.com")) throw new Error("offline");
  calls.push({ method: init?.method ?? "GET", url, body: init?.body as string, headers: init?.headers as Record<string, string> });
  const cp = url.match(/\/counterparties\/(\w+)$/);
  if (cp) return Response.json({ id: cp[1], account_number: counterparties[cp[1]], routing_number: "121000248" });
  if (url.endsWith("/transfers/wire")) return Response.json({ id: "wire_123", amount: 1845000, currency_code: "USD", status: "initiated", counterparty_id: "cpty_northwind" });
  return Response.json({ message: "not found" }, { status: 404 });
}) as typeof fetch;

test("rejects non-sandbox keys", async () => {
  const { ColumnClient } = await import("./column-client");
  assert.throws(() => new ColumnClient("live_abc"), /sandbox key/);
});

test("clean payment: beneficiary read from Column, release creates a sandbox wire", async () => {
  const { reseed } = await import("../seed-data");
  const { runGate } = await import("../gate");
  const { readLedger } = await import("../ledger");
  await reseed();

  const r = await runGate("pay_18k");
  assert.equal(r.status, "CLEARED");
  const wire = calls.find((c) => c.url.endsWith("/transfers/wire"));
  assert.ok(wire, "wire was created");
  assert.equal(wire.headers.Authorization, `Basic ${Buffer.from(":test_sandbox_key").toString("base64")}`);
  assert.equal(wire.headers["Idempotency-Key"], "sentinelpay-pay_18k");
  const body = new URLSearchParams(wire.body);
  assert.equal(body.get("amount"), "1845000");
  assert.equal(body.get("counterparty_id"), "cpty_northwind");
  assert.equal(body.get("bank_account_id"), "bacc_ap");
  assert.ok((await readLedger("pay_18k")).some((e) => e.event === "RAIL_RELEASED"));
});

test("poisoned payment: gate uses the rail's account (••9821); freeze never creates a wire", async () => {
  const { reseed } = await import("../seed-data");
  const { run } = await import("../db");
  const { runGate } = await import("../gate");
  const { investigate } = await import("../forensics");
  const { decide } = await import("../governor");
  await reseed();
  calls.length = 0;
  // Local AP copy says the account is unchanged; the rail's counterparty record is what counts.
  await run(`UPDATE payments SET claimedBankLast4 = '4471' WHERE id = 'pay_240k'`);

  const r = await runGate("pay_240k");
  assert.equal(r.status, "PENDING_REVIEW");
  assert.match(r.mismatches[0], /••4471 → ••9821/);

  await investigate("pay_240k");
  const receipt = await decide({ paymentId: "pay_240k", verdict: "DENIED", toolInvoked: "freeze_payment" });
  assert.equal(receipt.payment.status, "QUARANTINED");
  assert.equal(receipt.payment.railReference, undefined);
  assert.equal(calls.filter((c) => c.url.endsWith("/transfers/wire")).length, 0);
});
