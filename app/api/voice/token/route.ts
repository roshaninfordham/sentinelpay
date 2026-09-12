import { demoMode } from "@/lib/env";
import { readAssessment } from "@/lib/forensics";
import { paymentSource, vendorDirectory } from "@/lib/providers";

export const dynamic = "force-dynamic";

// Mints a single-use ElevenLabs conversation token server-side (the API key never reaches the browser)
// and returns the per-call dynamic variables. Falls back to the scripted challenge when voice is unavailable.
export async function GET(req: Request) {
  const paymentId = new URL(req.url).searchParams.get("paymentId");
  if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });

  let payment, vendor;
  try {
    payment = await paymentSource().get(paymentId);
    vendor = await vendorDirectory().get(payment.vendorId);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 404 });
  }

  const assessment = readAssessment(paymentId);
  const dynamicVariables = {
    payment_id: payment.id,
    amount: (payment.amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
    vendor: vendor.legalName,
    newLast4: payment.claimedBankLast4,
    oldLast4: vendor.knownBankLast4,
    request_domain: payment.requestSourceDomain,
    payer: process.env.PAYER_COMPANY_NAME ?? "Acme Corp",
    callback_number: assessment?.verifiedCallbackPhone ?? "unknown",
  };

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (demoMode() === "cache") return Response.json({ mode: "simulated", reason: "DEMO_MODE=cache", dynamicVariables });
  if (!apiKey || !agentId) {
    return Response.json({ mode: "simulated", reason: "ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID not set", dynamicVariables });
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(8000), cache: "no-store" },
    );
    if (!res.ok) throw new Error(`ElevenLabs token ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    return Response.json({ mode: "live", conversationToken: token, dynamicVariables });
  } catch (err) {
    return Response.json({ mode: "simulated", reason: (err as Error).message, dynamicVariables });
  }
}
