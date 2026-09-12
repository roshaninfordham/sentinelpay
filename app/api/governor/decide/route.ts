import { decide, GovernorError } from "@/lib/governor";
import type { CallOutcome, Verdict } from "@/lib/types";

export const dynamic = "force-dynamic";

const VERDICTS: Verdict[] = ["AUTHORIZED", "DENIED", "INCONCLUSIVE"];
const TOOLS: NonNullable<CallOutcome["toolInvoked"]>[] = ["approve_payment", "freeze_payment"];

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    paymentId?: string;
    verdict?: Verdict;
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
        transcript: typeof body.transcript === "string" ? body.transcript.slice(0, 20000) : undefined,
        toolInvoked: body.toolInvoked ?? null,
        durationSec: Number(body.durationSec) || 0,
      }),
    );
  } catch (err) {
    const status = err instanceof GovernorError ? err.status : 404;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
