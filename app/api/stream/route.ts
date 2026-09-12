import { snapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

// Dashboard state. The UI polls this (ARCHITECTURE §4: "1s polling is fine and simpler").
export async function GET() {
  return Response.json(snapshot(), { headers: { "cache-control": "no-store" } });
}
