import { requireOperator } from "@/lib/auth";
import { legacyError } from "@/lib/legacy-response";
import { snapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

// Dashboard state, polled by the UI. Production requires an operator key (use /api/v1 for principal-scoped reads).
export async function GET(req: Request) {
  try {
    const gate = await requireOperator(req);
    if (gate instanceof Response) return gate;
    return Response.json(await snapshot(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return legacyError(err, 500);
  }
}
