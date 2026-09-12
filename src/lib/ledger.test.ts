import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SENTINEL_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "sentinel-")), "test.db");
process.env.DEMO_MODE = "cache";
process.env.DEMO_PACE_MS = "0";

test("two decisions form a valid chain; tampering one row breaks it", async () => {
  const { getDb } = await import("./db");
  const { reseed } = await import("./seed-data");
  const { appendLedger, verifyChain, GENESIS } = await import("./ledger");
  reseed();

  const a = appendLedger("FROZEN", "pay_240k", { verdict: "DENIED" });
  const b = appendLedger("CLEARED", "pay_18k", { reason: "match" });
  assert.equal(a.prevHash, GENESIS);
  assert.equal(b.prevHash, a.entryHash);
  assert.deepEqual(verifyChain(), { ok: true, length: 2 });

  getDb().prepare(`UPDATE ledger SET payload_json = ? WHERE seq = 1`).run(JSON.stringify({ verdict: "AUTHORIZED" }));
  const broken = verifyChain();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 1);
});

test("end to end (cache mode): gate → forensics → deny → QUARANTINED with verifiable receipt", async () => {
  const { reseed } = await import("./seed-data");
  const { runGate } = await import("./gate");
  const { investigate } = await import("./forensics");
  const { decide } = await import("./governor");
  reseed();

  const gate = await runGate("pay_240k");
  assert.equal(gate.status, "PENDING_REVIEW");
  assert.equal(gate.investigate, true);

  const risk = await investigate("pay_240k");
  assert.equal(risk.level, "CRITICAL");
  assert.equal(risk.score, 90);
  assert.equal(risk.verifiedCallbackPhone, "(312) 555-0198");

  await assert.rejects(decide({ paymentId: "pay_18k", verdict: "AUTHORIZED" }), /gate/);

  const receipt = await decide({ paymentId: "pay_240k", verdict: "DENIED", toolInvoked: "freeze_payment" });
  assert.equal(receipt.payment.status, "QUARANTINED");
  assert.equal(receipt.chain.ok, true);
  assert.deepEqual(
    receipt.entries.map((e) => e.event),
    ["INTERCEPTED", "INVESTIGATION_STARTED", "FORENSICS", "CHALLENGE_STARTED", "CALL_RESULT", "FROZEN"],
  );

  // terminal states are immutable
  const again = await decide({ paymentId: "pay_240k", verdict: "AUTHORIZED", toolInvoked: "approve_payment" });
  assert.equal(again.payment.status, "QUARANTINED");

  const clean = await runGate("pay_18k");
  assert.equal(clean.status, "CLEARED");
});
