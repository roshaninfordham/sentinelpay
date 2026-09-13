import { requireOperator } from "@/lib/auth";
import { APP_OPERATOR, getRuntime } from "@/lib/engine";
import { legacyError } from "@/lib/legacy-response";

export const dynamic = "force-dynamic";

// "Freeze now" from the operator console: engine.block(), which only ever moves a payment toward QUARANTINED.
// Production requires an operator key, and the ledger records that operator instead of the console principal.
export async function POST(req: Request) {
  try {
    const gate = await requireOperator(req);
    if (gate instanceof Response) return gate;
    const { paymentId } = (await req.json().catch(() => ({}))) as { paymentId?: string };
    if (!paymentId) return Response.json({ error: "paymentId required" }, { status: 400 });
    const { engine } = await getRuntime();
    return Response.json(await engine.block(paymentId, { reason: "Frozen from the operator console", principal: gate.principal ?? APP_OPERATOR }));
  } catch (err) {
    return legacyError(err, 500);
  }
}
