import type { LedgerEntry } from "./types";

// Ledger chain v1: entryHash = sha256(seq | paymentId | event | payloadJson | prevHash), genesis prevHash = "0"×64.
// Web Crypto only, so the output must equal the legacy node:crypto implementation byte for byte.

export const GENESIS = "0".repeat(64);

const encoder = new TextEncoder();

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

export function hashEntry(seq: number, paymentId: string, event: string, payloadJson: string, prevHash: string): Promise<string> {
  return sha256Hex(`${seq}|${paymentId}|${event}|${payloadJson}|${prevHash}`);
}

/** Recomputes every hash. One edited row breaks the chain from that seq onward. */
export async function verifyEntries(
  entries: Array<LedgerEntry & { payloadJson: string }>,
): Promise<{ ok: boolean; brokenAt?: number; length: number }> {
  let prev = GENESIS;
  for (const e of entries) {
    const expected = await hashEntry(e.seq, e.paymentId, e.event, e.payloadJson, e.prevHash);
    if (e.prevHash !== prev || e.entryHash !== expected) return { ok: false, brokenAt: e.seq, length: entries.length };
    prev = e.entryHash;
  }
  return { ok: true, length: entries.length };
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await globalThis.crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await globalThis.crypto.subtle.sign("HMAC", k, encoder.encode(message)));
}

/** HMAC-SHA256(key, routing|account). The account number itself is never stored or logged. */
export function fingerprintAccount(key: string, routingNumber: string, accountNumber: string): Promise<string> {
  return hmacSha256Hex(key, `${routingNumber}|${accountNumber}`);
}
