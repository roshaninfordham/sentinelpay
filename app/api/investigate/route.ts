import { investigate, readAssessment } from "@/lib/forensics";

export const dynamic = "force-dynamic";

// Runs forensics synchronously for a payment in PENDING_REVIEW and returns the RiskAssessment.
// The release/webhook routes schedule this automatically; this endpoint exists for direct testing.
export async function POST(req: Request) {
  const { paymentId } = (await req.json().catch(() => ({}))) as { paymentId?: string };
  if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });
  try {
    return Response.json(await investigate(paymentId));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 409 });
  }
}

export async function GET(req: Request) {
  const paymentId = new URL(req.url).searchParams.get("paymentId");
  const a = paymentId ? readAssessment(paymentId) : undefined;
  return a ? Response.json(a) : Response.json({ error: "no assessment" }, { status: 404 });
}
