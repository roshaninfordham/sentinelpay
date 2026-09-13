import { investigate, readAssessment } from "@/lib/forensics";
import { legacyError } from "@/lib/legacy-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Advances a held payment through forensics (engine.advance) and returns the RiskAssessment.
// The release/webhook routes schedule this automatically; this endpoint exists for direct testing.
export async function POST(req: Request) {
  const { paymentId } = (await req.json().catch(() => ({}))) as { paymentId?: string };
  if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });
  try {
    return Response.json(await investigate(paymentId));
  } catch (err) {
    return legacyError(err, 409);
  }
}

export async function GET(req: Request) {
  const paymentId = new URL(req.url).searchParams.get("paymentId");
  try {
    const a = paymentId ? await readAssessment(paymentId) : undefined;
    return a ? Response.json(a) : Response.json({ error: "no assessment" }, { status: 404 });
  } catch (err) {
    return legacyError(err, 500);
  }
}
