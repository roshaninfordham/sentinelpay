import { ConfigError, EngineError } from "payfirewall";

// Legacy routes keep their `{ error: string }` bodies for one release; engine errors keep their HTTP status.
export function legacyError(err: unknown, fallbackStatus: number): Response {
  if (err instanceof EngineError) return Response.json({ error: err.message, code: err.code }, { status: err.httpStatus });
  if (err instanceof ConfigError) {
    console.error("[sentinelpay] configuration refused:", err.message);
    return Response.json({ error: "verification service unavailable (configuration); payments stay held" }, { status: 503 });
  }
  return Response.json({ error: (err as Error).message }, { status: fallbackStatus });
}
