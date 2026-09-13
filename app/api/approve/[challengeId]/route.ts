import { createHash, timingSafeEqual } from "node:crypto";
import { EngineError, type ChallengeAnswers, type Principal } from "payfirewall";
import { getRuntime } from "@/lib/engine";
import { callbackPhoneOf } from "@/lib/timeline-format";

export const dynamic = "force-dynamic";

// The /approve page's server side. Both methods take the link's responder token as bearer, and without a valid
// token every challenge id, real or not, gets the same 401: the page reveals neither existence nor payment details.

const APPROVAL_PAGE: Principal = { id: "approval-page:unauthenticated", kind: "human", roles: ["requester"] };

const noStore = { "cache-control": "no-store" };

const bearer = (req: Request) => /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];

const invalid = () =>
  Response.json({ error: { code: "RESPONDER_TOKEN_INVALID", message: "responder token is invalid" } }, { status: 401, headers: noStore });

/** Same scheme as the engine's stored hash: SHA-256 hex of pepper + token. */
function tokenMatches(pepper: string, token: string | undefined, storedHash: string): boolean {
  if (!token) return false;
  const presented = Buffer.from(createHash("sha256").update(pepper + token).digest("hex"));
  const stored = Buffer.from(storedHash);
  return stored.length === presented.length && timingSafeEqual(presented, stored);
}

// What the page shows. Reading does not count toward the token attempt limit and cannot change the payment.
export async function GET(req: Request, ctx: RouteContext<"/api/approve/[challengeId]">) {
  const { challengeId } = await ctx.params;
  const token = bearer(req);
  try {
    const { settings, engine, loadCase } = await getRuntime();
    const found = token ? await loadCase({ challengeId }) : null;
    const ch = found?.challenge;
    if (!found || !ch || ch.channel !== "human_approval" || !tokenMatches(settings.tokenPepper, token, ch.responderTokenHash)) return invalid();
    // One lazy engine step enforces expiry before anything is shown as confirmable.
    await engine.advance(found.paymentId).catch(() => undefined);
    const c = (await loadCase({ challengeId })) ?? found;
    const current = c.challenge!;
    if (current.status === "EXPIRED") return Response.json({ status: "expired" }, { headers: noStore });
    if (current.status !== "OPEN" || c.state !== "CHALLENGING") return Response.json({ status: "closed" }, { headers: noStore });
    return Response.json(
      {
        status: "open",
        amountCents: c.payment.amountCents,
        vendor: c.vendorSnapshot.legalName,
        onFileLast4: c.vendorSnapshot.knownBankLast4,
        requestSourceDomain: c.payment.requestSourceDomain,
        callbackPhone: callbackPhoneOf(c),
        expiresAt: current.expiresAt,
      },
      { headers: noStore },
    );
  } catch {
    return Response.json({ error: { code: "STORAGE_UNAVAILABLE", message: "could not load the confirmation" } }, { status: 503, headers: noStore });
  }
}

// "Vendor did not confirm". The v1 result route accepts DENIED only from an authenticated principal, and the app has
// no approver sessions yet, so the page's denial is resolved here in-process. It can only move the payment toward
// QUARANTINED. Production refuses it until approver sessions exist (fail closed: the challenge then expires and the
// payment freezes anyway).
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
    const token = bearer(req);
    const c = token ? await loadCase({ challengeId }) : null;
    // Same answer for an unknown challenge, another channel and a bad link: no existence oracle.
    if (!c?.challenge || c.challenge.channel !== "human_approval" || !tokenMatches(settings.tokenPepper, token, c.challenge.responderTokenHash)) return invalid();
    const v = await engine.resolveChallenge({ challengeId, verdict: body.verdict, responder: APPROVAL_PAGE, answers });
    // Only the outcome: a link is not a session, so this route never returns the case itself.
    return Response.json({ decision: v.decision });
  } catch (err) {
    if (err instanceof EngineError) return Response.json({ error: err.toJSON() }, { status: err.httpStatus });
    return Response.json({ error: { code: "STORAGE_UNAVAILABLE", message: "could not record the answer" } }, { status: 503 });
  }
}
