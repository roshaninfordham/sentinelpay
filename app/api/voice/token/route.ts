import { mintConversationToken } from "payfirewall/adapters/elevenlabs";
import { getRuntime } from "@/lib/engine";
import { legacyError } from "@/lib/legacy-response";
import { callbackPhoneOf } from "@/lib/timeline-format";
import { readVoiceSession } from "@/lib/voice/browser-challenger";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

// Hands the operator's browser what it needs to run the open voice_browser challenge: the challengeId and responder
// token (operator_session assurance, §4.3 rule 6), per-call dynamic variables, and when voice is available a
// single-use ElevenLabs conversation token (the API key never reaches the browser). The responder token is never
// placed in dynamicVariables, which are sent to the voice provider.
export async function GET(req: Request) {
  const paymentId = new URL(req.url).searchParams.get("paymentId");
  if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });

  try {
    const { settings, client, loadCase, authenticate } = await getRuntime();
    if (settings.environment === "production") {
      const principal = await authenticate(req);
      if (!principal?.roles.includes("operator")) {
        return Response.json({ error: "operator authentication required" }, { status: 401, headers: noStore });
      }
    }

    const c = await loadCase({ paymentId });
    if (!c) return Response.json({ error: "verification not found" }, { status: 404, headers: noStore });
    const ch = c.challenge;
    if (c.state !== "CHALLENGING" || ch?.status !== "OPEN" || ch.channel !== "voice_browser") {
      return Response.json({ error: "no open voice_browser challenge for this payment" }, { status: 409, headers: noStore });
    }
    const session = await readVoiceSession(client, ch.challengeId, new Date());
    if (!session) return Response.json({ error: "voice session expired or not started" }, { status: 409, headers: noStore });

    const base = {
      challengeId: ch.challengeId,
      responderToken: session.responderToken,
      dynamicVariables: {
        payment_id: c.paymentId,
        amount: (c.payment.amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
        vendor: c.vendorSnapshot.legalName,
        newLast4: c.payment.beneficiary.accountLast4,
        oldLast4: c.vendorSnapshot.knownBankLast4,
        request_domain: c.payment.requestSourceDomain,
        payer: settings.payerName,
        callback_number: callbackPhoneOf(c) ?? "unknown",
      },
    };

    if (settings.demoMode === "cache") return Response.json({ mode: "simulated", reason: "DEMO_MODE=cache", ...base }, { headers: noStore });
    if (!settings.elevenLabs) {
      return Response.json({ mode: "simulated", reason: "ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID not set", ...base }, { headers: noStore });
    }
    try {
      const conversationToken = await mintConversationToken(settings.elevenLabs);
      return Response.json({ mode: "live", conversationToken, ...base }, { headers: noStore });
    } catch (err) {
      return Response.json({ mode: "simulated", reason: (err as Error).message, ...base }, { headers: noStore });
    }
  } catch (err) {
    return legacyError(err, 500);
  }
}
