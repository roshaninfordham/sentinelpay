import { createHash } from "node:crypto";
import { getDb } from "./db";
import type { LedgerEntry } from "./types";

// Node 4 — tamper-evident audit ledger (ARCHITECTURE §4).
// entryHash = sha256(seq | paymentId | event | JSON(payload) | prevHash); genesis prevHash = "0"×64.

export const GENESIS = "0".repeat(64);

interface Row {
  seq: number;
  paymentId: string;
  event: string;
  payload_json: string;
  prevHash: string;
  entryHash: string;
  ts: string;
}

export function hashEntry(seq: number, paymentId: string, event: string, payloadJson: string, prevHash: string): string {
  return createHash("sha256").update(`${seq}|${paymentId}|${event}|${payloadJson}|${prevHash}`).digest("hex");
}

const toEntry = (r: Row): LedgerEntry => ({
  seq: r.seq,
  paymentId: r.paymentId,
  event: r.event,
  payload: JSON.parse(r.payload_json),
  prevHash: r.prevHash,
  entryHash: r.entryHash,
  ts: r.ts,
});

export function appendLedger(event: string, paymentId: string, payload: unknown): LedgerEntry {
  const db = getDb();
  return db.transaction(() => {
    const last = db.prepare(`SELECT seq, entryHash FROM ledger ORDER BY seq DESC LIMIT 1`).get() as
      | { seq: number; entryHash: string }
      | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.entryHash ?? GENESIS;
    const payloadJson = JSON.stringify(payload ?? null);
    const row: Row = {
      seq,
      paymentId,
      event,
      payload_json: payloadJson,
      prevHash,
      entryHash: hashEntry(seq, paymentId, event, payloadJson, prevHash),
      ts: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO ledger (seq, paymentId, event, payload_json, prevHash, entryHash, ts)
       VALUES (@seq, @paymentId, @event, @payload_json, @prevHash, @entryHash, @ts)`,
    ).run(row);
    return toEntry(row);
  })();
}

export function readLedger(paymentId?: string): LedgerEntry[] {
  const db = getDb();
  const rows = (
    paymentId
      ? db.prepare(`SELECT * FROM ledger WHERE paymentId = ? ORDER BY seq`).all(paymentId)
      : db.prepare(`SELECT * FROM ledger ORDER BY seq`).all()
  ) as Row[];
  return rows.map(toEntry);
}

/** Recomputes every hash from the stored rows. One edited row breaks the chain from that seq onward. */
export function verifyChain(): { ok: boolean; brokenAt?: number; length: number } {
  const rows = getDb().prepare(`SELECT * FROM ledger ORDER BY seq`).all() as Row[];
  let prev = GENESIS;
  for (const r of rows) {
    const expected = hashEntry(r.seq, r.paymentId, r.event, r.payload_json, r.prevHash);
    if (r.prevHash !== prev || r.entryHash !== expected) return { ok: false, brokenAt: r.seq, length: rows.length };
    prev = r.entryHash;
  }
  return { ok: true, length: rows.length };
}
