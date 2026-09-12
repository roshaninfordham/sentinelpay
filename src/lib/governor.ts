import { run } from "./db";
import { appendLedger } from "./ledger";
import { paymentSource } from "./providers";
import { buildReceipt, type IncidentReceipt } from "./receipt";
import { emit } from "./timeline";
import type { CallOutcome, Verdict } from "./types";

// Node 4 — settlement governor. The only code path that moves a payment to a terminal state
// after interception. Fail-closed: anything other than an explicit AUTHORIZED quarantines the wire.

export class GovernorError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export interface DecideInput {
  paymentId: string;
  verdict: Verdict;
  transcript?: string;
  toolInvoked?: CallOutcome["toolInvoked"];
  durationSec?: number;
}

export async function decide(input: DecideInput): Promise<IncidentReceipt> {
  const source = paymentSource();
  const payment = await source.get(input.paymentId);

  if (payment.status === "QUARANTINED" || payment.status === "CLEARED") {
    return buildReceipt(payment.id); // idempotent: a repeated tool call returns the existing receipt
  }
  if (payment.status === "RECEIVED") {
    throw new GovernorError("payment has not been through the gate");
  }
  if (input.verdict === "AUTHORIZED" && payment.status !== "CHALLENGING") {
    throw new GovernorError("authorization requires a completed out-of-band challenge");
  }

  const call: CallOutcome = {
    paymentId: payment.id,
    verdict: input.verdict,
    transcript: input.transcript ?? "",
    toolInvoked: input.toolInvoked ?? null,
    durationSec: Math.max(0, Math.round(input.durationSec ?? 0)),
  };
  await run(`INSERT OR REPLACE INTO calls (paymentId, json) VALUES (?, ?)`, [payment.id, JSON.stringify(call)]);
  await appendLedger("CALL_RESULT", payment.id, call);

  const amount = (payment.amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (input.verdict === "AUTHORIZED") {
    await source.setStatus(payment.id, "CLEARED");
    await appendLedger("CLEARED", payment.id, { verdict: call.verdict, toolInvoked: call.toolInvoked });
    await emit(payment.id, "ok", `✔ Vendor controller authorized the change — ${amount} released`);
  } else {
    await source.setStatus(payment.id, "QUARANTINED");
    await appendLedger("FROZEN", payment.id, { verdict: call.verdict, toolInvoked: call.toolInvoked, amountCents: payment.amountCents });
    await emit(
      payment.id,
      "alert",
      input.verdict === "DENIED"
        ? `■ Vendor controller DENIED the change — ${amount} QUARANTINED`
        : `■ Challenge inconclusive — failing closed, ${amount} QUARANTINED`,
    );
  }
  return buildReceipt(payment.id);
}
