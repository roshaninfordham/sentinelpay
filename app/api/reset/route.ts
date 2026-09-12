import { reseed } from "@/lib/seed-data";

export const dynamic = "force-dynamic";

// One-click "reset demo": wipes state and re-writes the seeded scenario.
export async function POST() {
  reseed();
  return Response.json({ ok: true });
}
