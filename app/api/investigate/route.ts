import { requireOperator } from "@/lib/auth";
import { investigate, readAssessment } from "@/lib/forensics";
import { legacyError } from "@/lib/legacy-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Advances a held payment through forensics (engine.advance) and returns the RiskAssessment.
// The release/webhook routes schedule this automatically; this endpoint exists for direct testing.
// Production requires an operator key.
export async function POST(req: Request) {
  try {
    const gate = await requireOperator(req);
    if (gate instanceof Response) return gate;
    const { paymentId } = (await req.json().catch(() => ({}))) as { paymentId?: string };
    if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });
    return Response.json(await investigate(paymentId));
  } catch (err) {
    return legacyError(err, 409);
  }
}

export async function GET(req: Request) {
  try {
    const gate = await requireOperator(req);
    if (gate instanceof Response) return gate;
    const paymentId = new URL(req.url).searchParams.get("paymentId");
    const a = paymentId ? await readAssessment(paymentId) : undefined;
    return a ? Response.json(a) : Response.json({ error: "no assessment" }, { status: 404 });
  } catch (err) {
    return legacyError(err, 500);
  }
}
