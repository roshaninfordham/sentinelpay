import type { Principal } from "payfirewall";
import { getRuntime } from "./engine";

const noStore = { "cache-control": "no-store" };

/**
 * Gate for the dashboard's legacy routes. Outside production they stay open for the demo and act as the app's
 * own principals. In production they need an operator API key from SENTINELPAY_API_KEYS; integrators use /api/v1.
 * Returns the authenticated operator (null outside production), or the refusal to send.
 */
export async function requireOperator(req: Request): Promise<{ principal: Principal | null } | Response> {
  const { settings, authenticate } = await getRuntime();
  if (settings.environment !== "production") return { principal: null };
  const principal = await authenticate(req);
  if (!principal) return Response.json({ error: "operator authentication required" }, { status: 401, headers: noStore });
  if (!principal.roles.includes("operator")) return Response.json({ error: "operator role required" }, { status: 403, headers: noStore });
  return { principal };
}

/** True when a route or page that has no production authentication must not be served. */
export async function isProduction(): Promise<boolean> {
  return (await getRuntime()).settings.environment === "production";
}

/** A hostname as the request domain: lowercase labels of letters, digits and hyphens, at least one dot. */
export function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) ? host : null;
}
