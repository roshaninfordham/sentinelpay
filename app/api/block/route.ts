import { APP_OPERATOR, getRuntime } from "@/lib/engine";
import { legacyError } from "@/lib/legacy-response";

export const dynamic = "force-dynamic";

// "Freeze now" from the operator console: engine.block(), which only ever moves a payment toward QUARANTINED.
export async function POST(req: Request) {
  const { paymentId } = (await req.json().catch(() => ({}))) as { paymentId?: string };
  if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });
  try {
    const { engine } = await getRuntime();
    return Response.json(await engine.block(paymentId, { reason: "Frozen from the operator console", principal: APP_OPERATOR }));
  } catch (err) {
    return legacyError(err, 500);
  }
}
