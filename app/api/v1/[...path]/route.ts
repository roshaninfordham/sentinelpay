import { createHandler } from "payfirewall/http";
import { after } from "next/server";
import { getRuntime } from "@/lib/engine";

export const dynamic = "force-dynamic";
// Scheduled engine steps (after()) run probes and pacing; give them the same room as the legacy routes.
export const maxDuration = 60;

// HTTP contract v1 (ENGINE_SPEC §5.5). Principals come only from SENTINELPAY_API_KEYS bearer keys.
async function handle(req: Request): Promise<Response> {
  let runtime;
  try {
    runtime = await getRuntime();
  } catch (err) {
    console.error("[sentinelpay] engine unavailable:", (err as Error).message);
    const error = {
      code: "STORAGE_UNAVAILABLE", message: "verification service unavailable", retryable: true,
      nextActions: [{ type: "DO_NOT_PAY", reason: "STORAGE_UNAVAILABLE", terminal: false }],
    };
    return Response.json({ error }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const handler = createHandler(runtime.engine, {
    authenticate: runtime.authenticate,
    schedule: (work) => after(work),
    health: () => runtime.health,
  });
  return handler(req);
}

export const GET = handle;
export const POST = handle;
