import { requireOperator } from "@/lib/auth";
import { decide, GovernorError } from "@/lib/governor";
import { legacyError } from "@/lib/legacy-response";
import type { CallOutcome, Verdict } from "@/lib/types";

export const dynamic = "force-dynamic";

const VERDICTS: Verdict[] = ["AUTHORIZED", "DENIED", "INCONCLUSIVE"];
const TOOLS: NonNullable<CallOutcome["toolInvoked"]>[] = ["approve_payment", "freeze_payment"];

// Legacy decision route. DENIED/INCONCLUSIVE work as before; AUTHORIZED requires the open challenge's
// challengeId + responderToken (handed to the operator's browser by /api/voice/token) and the vendor's read-back.
// Production requires an operator key, and that operator is the responder the engine checks.
export async function POST(req: Request) {
  let gate: Awaited<ReturnType<typeof requireOperator>>;
  try {
    gate = await requireOperator(req);
    if (gate instanceof Response) return gate;
  } catch (err) {
    return legacyError(err, 500);
  }

  const body = (await req.json().catch(() => ({}))) as {
    paymentId?: string;
    verdict?: Verdict;
    challengeId?: unknown;
    responderToken?: unknown;
    beneficiaryLast4ReadBack?: unknown;
    transcript?: string;
    toolInvoked?: CallOutcome["toolInvoked"];
    durationSec?: number;
  };
  if (!body.paymentId || !body.verdict || !VERDICTS.includes(body.verdict)) {
    return Response.json({ error: "paymentId and verdict (AUTHORIZED|DENIED|INCONCLUSIVE) required" }, { status: 400 });
  }
  if (body.toolInvoked && !TOOLS.includes(body.toolInvoked)) {
    return Response.json({ error: "unknown tool" }, { status: 400 });
  }
  try {
    return Response.json(
      await decide({
        paymentId: body.paymentId,
        verdict: body.verdict,
        challengeId: typeof body.challengeId === "string" ? body.challengeId : undefined,
        responderToken: typeof body.responderToken === "string" ? body.responderToken : undefined,
        beneficiaryLast4ReadBack: typeof body.beneficiaryLast4ReadBack === "string" && /^\d{4}$/.test(body.beneficiaryLast4ReadBack) ? body.beneficiaryLast4ReadBack : undefined,
        ...(gate.principal ? { responder: gate.principal } : {}),
        transcript: typeof body.transcript === "string" ? body.transcript.slice(0, 20000) : undefined,
        toolInvoked: body.toolInvoked ?? null,
        durationSec: Number(body.durationSec) || 0,
      }),
    );
  } catch (err) {
    if (err instanceof GovernorError) return Response.json({ error: err.message }, { status: err.status });
    return legacyError(err, 404);
  }
}
