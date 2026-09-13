import { EngineError, type ChallengeAnswers, type Principal } from "@sentinelpay/engine";
import { getRuntime } from "@/lib/engine";

export const dynamic = "force-dynamic";

// "Vendor did not confirm" from the /approve page. The v1 result route accepts DENIED only from an authenticated
// principal, and the app has no approver sessions yet, so the page's denial is resolved here in-process. It can
// only move the payment toward QUARANTINED. Production refuses it until approver sessions exist (fail closed:
// the challenge then expires and the payment freezes anyway).
const APPROVAL_PAGE: Principal = { id: "approval-page:unauthenticated", kind: "human", roles: ["requester"] };

const invalid = () =>
  Response.json({ error: { code: "RESPONDER_TOKEN_INVALID", message: "responder token is invalid" } }, { status: 401 });

export async function POST(req: Request, ctx: RouteContext<"/api/approve/[challengeId]">) {
  const { challengeId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { verdict?: unknown; answers?: { beneficiaryLast4ReadBack?: unknown } };
  if (body.verdict !== "DENIED" && body.verdict !== "INCONCLUSIVE") {
    return Response.json({ error: { code: "INVALID_INPUT", message: "verdict must be DENIED or INCONCLUSIVE" } }, { status: 400 });
  }
  const readBack = body.answers?.beneficiaryLast4ReadBack;
  const answers: ChallengeAnswers = {
    authorizedChange: body.verdict === "DENIED" ? "no" : "unclear",
    ...(typeof readBack === "string" && /^\d{4}$/.test(readBack) ? { beneficiaryLast4ReadBack: readBack } : {}),
  };

  try {
    const { settings, engine, loadCase } = await getRuntime();
    if (settings.environment === "production") {
      return Response.json({ error: { code: "RESPONDER_TOKEN_REQUIRED", message: "an approver session is required" } }, { status: 403 });
    }
    const c = await loadCase({ challengeId });
    if (c?.challenge?.channel !== "human_approval") return invalid(); // same answer as a bad link: no existence oracle
    const v = await engine.resolveChallenge({ challengeId, verdict: body.verdict, responder: APPROVAL_PAGE, answers });
    // Only the outcome: this route is unauthenticated, so it never returns the case itself.
    return Response.json({ decision: v.decision });
  } catch (err) {
    if (err instanceof EngineError) return Response.json({ error: err.toJSON() }, { status: err.httpStatus });
    return Response.json({ error: { code: "STORAGE_UNAVAILABLE", message: "could not record the answer" } }, { status: 503 });
  }
}
