import { after } from "next/server";
import { investigate } from "@/lib/forensics";
import { runGate } from "@/lib/gate";
import { paymentSource } from "@/lib/providers";
import type { Payment } from "@/lib/types";

export const dynamic = "force-dynamic";
// Forensics runs in after(); give it room for live RDAP + Tavily calls and audience pacing.
export const maxDuration = 60;

// Mock ERP/AP disbursement event. Accepts a Payment-shaped body, ingests it as RECEIVED, runs the gate.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Partial<Payment> | null;
  const required = ["id", "vendorId", "amountCents", "claimedBankLast4", "requestSourceDomain"] as const;
  const missing = required.filter((k) => body?.[k] === undefined || body?.[k] === "");
  if (!body || missing.length) {
    return Response.json({ error: `missing fields: ${missing.join(", ")}` }, { status: 400 });
  }

  const payment: Payment = {
    id: String(body.id),
    vendorId: String(body.vendorId),
    amountCents: Number(body.amountCents),
    currency: "USD",
    claimedBankLast4: String(body.claimedBankLast4),
    requestSourceDomain: String(body.requestSourceDomain),
    invoiceContactPhone: body.invoiceContactPhone,
    status: "RECEIVED",
    createdAt: body.createdAt ?? new Date().toISOString(),
    memo: body.memo,
  };

  try {
    const source = paymentSource();
    const existing = await source.get(payment.id).catch(() => null);
    if (existing && existing.status !== "RECEIVED") {
      return Response.json({ error: `payment ${payment.id} already ${existing.status}` }, { status: 409 });
    }
    await source.upsert(payment);
    const result = await runGate(payment.id);
    if (result.investigate) after(() => investigate(payment.id).catch((e) => console.error("[investigate]", e)));
    return Response.json(result, { status: 202 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
