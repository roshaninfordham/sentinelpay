import type { Client } from "@libsql/client";
import type { Challenger } from "payfirewall";

// voice_browser Challenger (ENGINE_SPEC §4.3 rule 6). The operator's browser places the call, so the responder
// token is handed to it through /api/voice/token: assurance is "operator_session", never "out_of_band".
// The plaintext token lives only in the server-side voice_sessions table, until the challenge resolves or expires.

export interface VoiceSession {
  challengeId: string;
  paymentId: string;
  responderToken: string;
  expiresAt: string;
}

export function browserVoiceChallenger(client: Client, opts: { operatorAuth: boolean }): Challenger {
  return {
    channel: "voice_browser",
    assurance: "operator_session",
    // True only when /api/voice/token requires operator authentication; createEngine refuses production otherwise.
    operatorAuth: opts.operatorAuth,
    // The agent never says the new account's digits; the vendor reads them back, and a mismatch denies (SEC-07).
    requireReadBack: true,
    // A call needs an independently verified number; without one the engine fails closed (NO_CHALLENGE_CHANNEL).
    canHandle: ({ callbackPhone }) => callbackPhone !== null,
    async start(req) {
      // A retried start() mints a fresh token for the same challenge, so the row is replaced, never kept.
      await client.execute({
        sql: `INSERT INTO voice_sessions (challengeId, paymentId, responderToken, expiresAt) VALUES (?, ?, ?, ?)
              ON CONFLICT(challengeId) DO UPDATE SET responderToken = excluded.responderToken, expiresAt = excluded.expiresAt`,
        args: [req.challengeId, req.facts.paymentId, req.responderToken, req.expiresAt],
      });
      return { status: "pending" };
    },
    async cancel(c) {
      await endVoiceSession(client, c.challengeId);
    },
  };
}

/** The live session for an open challenge, or null once it has expired (expired rows are purged on read). */
export async function readVoiceSession(client: Client, challengeId: string, now: Date): Promise<VoiceSession | null> {
  await client.execute({ sql: `DELETE FROM voice_sessions WHERE expiresAt <= ?`, args: [now.toISOString()] });
  const rs = await client.execute({
    sql: `SELECT challengeId, paymentId, responderToken, expiresAt FROM voice_sessions WHERE challengeId = ?`,
    args: [challengeId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return {
    challengeId: String(row.challengeId),
    paymentId: String(row.paymentId),
    responderToken: String(row.responderToken),
    expiresAt: String(row.expiresAt),
  };
}

export async function endVoiceSession(client: Client, challengeId: string): Promise<void> {
  await client.execute({ sql: `DELETE FROM voice_sessions WHERE challengeId = ?`, args: [challengeId] });
}
