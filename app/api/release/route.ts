import { after } from "next/server";
import { investigate } from "@/lib/forensics";
import { runGate } from "@/lib/gate";

export const dynamic = "force-dynamic";
// Forensics runs in after(); give it room for live RDAP + Tavily calls and audience pacing.
export const maxDuration = 60;

// Operator clicks "Release payment" → the gate decides whether money may move.
export async function POST(req: Request) {
  const { paymentId } = (await req.json().catch(() => ({}))) as { paymentId?: string };
  if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });

  try {
    const result = await runGate(paymentId);
    if (result.investigate) after(() => investigate(paymentId).catch((e) => console.error("[investigate]", e)));
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 404 });
  }
}
