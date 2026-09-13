import { sha256Hex } from "./hash";

// Challenge identifiers and responder tokens (§4.2). The plaintext token exists only in ChallengeRequest.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** "chl_" + 16 random bytes in lowercase RFC 4648 base32 (26 chars). */
export const newChallengeId = () => `chl_${base32(randomBytes(16))}`;

/** 32 random bytes, base64url (43 chars). */
export const newResponderToken = () => base64url(randomBytes(32));

export const hashResponderToken = (pepper: string, token: string) => sha256Hex(pepper + token);

/** Compares two strings without an early exit on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Checks a presented token against a stored hash. An empty stored hash (no live token) never matches. */
export async function responderTokenMatches(pepper: string, token: string, storedHash: string): Promise<boolean> {
  const presented = await hashResponderToken(pepper, token);
  return storedHash.length > 0 && constantTimeEqual(presented, storedHash);
}
