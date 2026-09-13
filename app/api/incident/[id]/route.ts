import { requireOperator } from "@/lib/auth";
import { legacyError } from "@/lib/legacy-response";
import { buildReceipt } from "@/lib/receipt";

export const dynamic = "force-dynamic";

// JSON incident receipt. The printable version lives at /incident/{id}. Production requires an operator key.
export async function GET(req: Request, ctx: RouteContext<"/api/incident/[id]">) {
  const { id } = await ctx.params;
  try {
    const gate = await requireOperator(req);
    if (gate instanceof Response) return gate;
  } catch (err) {
    return legacyError(err, 500);
  }
  try {
    return Response.json(await buildReceipt(id), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 404 });
  }
}
