import { mintConversationToken } from "payfirewall/adapters/elevenlabs";
import { normalizeHostname, requireOperator } from "@/lib/auth";
import { getRuntime } from "@/lib/engine";
import { legacyError } from "@/lib/legacy-response";
import { callbackPhoneOf } from "@/lib/timeline-format";
import { readVoiceSession } from "@/lib/voice/browser-challenger";
import { liveTokenBody, simulatedTokenBody } from "@/lib/voice/token-response";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

// Hands the operator's browser what it needs to run the open voice_browser challenge: the challengeId and responder
// token (operator_session assurance, §4.3 rule 6), per-call dynamic variables, and when voice is available a
// single-use ElevenLabs conversation token (the API key never reaches the browser). The responder token is never
// placed in dynamicVariables, which are sent to the voice provider, and neither are the new account's digits: the
// vendor reads them back (voice_browser requires the read-back). Only the scripted call gets them (token-response.ts).
export async function GET(req: Request) {
  const paymentId = new URL(req.url).searchParams.get("paymentId");
  if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });

  try {
    const gate = await requireOperator(req);
    if (gate instanceof Response) return gate;
    const { settings, client, loadCase } = await getRuntime();

    const c = await loadCase({ paymentId });
    if (!c) return Response.json({ error: "verification not found" }, { status: 404, headers: noStore });
    const ch = c.challenge;
    if (c.state !== "CHALLENGING" || ch?.status !== "OPEN" || ch.channel !== "voice_browser") {
      return Response.json({ error: "no open voice_browser challenge for this payment" }, { status: 409, headers: noStore });
    }
    const session = await readVoiceSession(client, ch.challengeId, new Date());
    if (!session) {
      // The engine records the open challenge before start() writes the session, so a fast client can arrive in
      // between: 202 until it exists, 409 once the challenge has expired.
      if (new Date(ch.expiresAt) > new Date()) return Response.json({ status: "starting" }, { status: 202, headers: { ...noStore, "retry-after": "1" } });
      return Response.json({ error: "voice session expired" }, { status: 409, headers: noStore });
    }

    const base = {
      challengeId: ch.challengeId,
      responderToken: session.responderToken,
      dynamicVariables: {
        payment_id: c.paymentId,
        amount: (c.payment.amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
        vendor: c.vendorSnapshot.legalName,
        oldLast4: c.vendorSnapshot.knownBankLast4,
        // Untrusted input that reaches the agent's prompt: passed only when it is a bare hostname.
        request_domain: normalizeHostname(c.payment.requestSourceDomain) ?? "an unrecognized sender",
        payer: settings.payerName,
        callback_number: callbackPhoneOf(c) ?? "unknown",
      },
    };

    const last4 = c.payment.beneficiary.accountLast4;
    const scripted = (reason: string) => Response.json(simulatedTokenBody(base, reason, last4), { headers: noStore });
    if (settings.demoMode === "cache") return scripted("DEMO_MODE=cache");
    if (!settings.elevenLabs) return scripted("ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID not set");
    try {
      return Response.json(liveTokenBody(base, await mintConversationToken(settings.elevenLabs)), { headers: noStore });
    } catch (err) {
      return scripted((err as Error).message);
    }
  } catch (err) {
    return legacyError(err, 500);
  }
}
