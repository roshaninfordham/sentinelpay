import { isProduction } from "@/lib/auth";
import { legacyError } from "@/lib/legacy-response";
import { reseed } from "@/lib/seed-data";

export const dynamic = "force-dynamic";

// One-click "reset demo": wipes state and re-writes the seeded scenario. Never served in production, where it
// would erase the audit chain and the denied beneficiaries that later payments are checked against.
export async function POST() {
  try {
    if (await isProduction()) return Response.json({ error: "not found" }, { status: 404 });
    await reseed();
    return Response.json({ ok: true });
  } catch (err) {
    return legacyError(err, 500);
  }
}
