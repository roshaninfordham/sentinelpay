import { createHash } from "node:crypto";
import { all, one, run, writeTransaction } from "./db";
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
  seq: Number(r.seq),
  paymentId: r.paymentId,
  event: r.event,
  payload: JSON.parse(r.payload_json),
  prevHash: r.prevHash,
  entryHash: r.entryHash,
  ts: r.ts,
});

export async function appendLedger(event: string, paymentId: string, payload: unknown): Promise<LedgerEntry> {
  // Read-tail and insert in one write transaction so concurrent appends can't fork the chain.
  // `seq` is the primary key, so a lost race fails loudly instead of silently.
  return writeTransaction(async (tx) => {
    const last = await one<{ seq: number; entryHash: string }>(`SELECT seq, entryHash FROM ledger ORDER BY seq DESC LIMIT 1`, [], tx);
    const seq = Number(last?.seq ?? 0) + 1;
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
    await run(
      `INSERT INTO ledger (seq, paymentId, event, payload_json, prevHash, entryHash, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.seq, row.paymentId, row.event, row.payload_json, row.prevHash, row.entryHash, row.ts],
      tx,
    );
    return toEntry(row);
  });
}

export async function readLedger(paymentId?: string): Promise<LedgerEntry[]> {
  const rows = paymentId
    ? await all<Row>(`SELECT * FROM ledger WHERE paymentId = ? ORDER BY seq`, [paymentId])
    : await all<Row>(`SELECT * FROM ledger ORDER BY seq`);
  return rows.map(toEntry);
}

/** Recomputes every hash from the stored rows. One edited row breaks the chain from that seq onward. */
export async function verifyChain(): Promise<{ ok: boolean; brokenAt?: number; length: number }> {
  const rows = await all<Row>(`SELECT * FROM ledger ORDER BY seq`);
  let prev = GENESIS;
  for (const r of rows) {
    const seq = Number(r.seq);
    const expected = hashEntry(seq, r.paymentId, r.event, r.payload_json, r.prevHash);
    if (r.prevHash !== prev || r.entryHash !== expected) return { ok: false, brokenAt: seq, length: rows.length };
    prev = r.entryHash;
  }
  return { ok: true, length: rows.length };
}
