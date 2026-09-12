import rdapFixtures from "../../../fixtures/rdap.json";
import { demoMode } from "../env";

// RDAP probe — deterministic, free, no key. `GET https://rdap.org/domain/{domain}`.

export interface RdapResult {
  domain: string;
  found: boolean;               // false = registry has no record of this domain
  registeredAt: string | null;  // ISO date of the "registration" event
  ageDays: number | null;
  ageHours: number | null;
  origin: "live" | "cache";
  note?: string;
}

interface RdapEvent { eventAction: string; eventDate: string }
interface FixtureEntry {
  events?: RdapEvent[];
  // Scenario fixtures store the registration relative to "now" so the demo stays "72 hours ago" on any day.
  registeredHoursAgo?: number;
  notFound?: boolean;
}

const fixtures = rdapFixtures as unknown as { domains: Record<string, FixtureEntry> };

function fromRegistration(domain: string, reg: string | undefined, origin: RdapResult["origin"], note?: string): RdapResult {
  if (!reg) return { domain, found: true, registeredAt: null, ageDays: null, ageHours: null, origin, note };
  const ms = Date.now() - Date.parse(reg);
  return {
    domain,
    found: true,
    registeredAt: reg,
    ageDays: Math.floor(ms / 864e5),
    ageHours: Math.floor(ms / 36e5),
    origin,
    note,
  };
}

export function fromFixture(domain: string, note?: string): RdapResult | null {
  const f = fixtures.domains[domain.toLowerCase()];
  if (!f) return null;
  if (f.notFound) return { domain, found: false, registeredAt: null, ageDays: null, ageHours: null, origin: "cache", note };
  const reg =
    f.registeredHoursAgo !== undefined
      ? new Date(Date.now() - f.registeredHoursAgo * 36e5).toISOString()
      : f.events?.find((e) => e.eventAction === "registration")?.eventDate;
  return fromRegistration(domain, reg, "cache", note);
}

export async function lookupDomain(domain: string): Promise<RdapResult> {
  if (demoMode() === "cache") {
    return fromFixture(domain) ?? { domain, found: false, registeredAt: null, ageDays: null, ageHours: null, origin: "cache", note: "no cached capture" };
  }

  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(6000),
      // rdap.org sits behind Cloudflare, which answers 403 to requests without a User-Agent (Node fetch sends none).
      headers: { accept: "application/rdap+json, application/json", "user-agent": "SentinelPay/0.1 (+https://github.com/sentinelpay)" },
    });
    const body = (await res.json().catch(() => ({}))) as { events?: RdapEvent[]; title?: string };

    if (res.status === 404) {
      // rdap.org answers 404 both for "no such domain" and for TLDs with no RDAP server (e.g. .co).
      // Only the former is evidence; for the latter we fall back to the cached capture.
      if (/no rdap service/i.test(body.title ?? "")) {
        return fromFixture(domain, `no RDAP server for .${domain.split(".").pop()} — cached capture`) ?? {
          domain, found: false, registeredAt: null, ageDays: null, ageHours: null, origin: "live",
          note: "TLD has no RDAP service",
        };
      }
      return { domain, found: false, registeredAt: null, ageDays: null, ageHours: null, origin: "live" };
    }
    if (!res.ok) throw new Error(`rdap ${res.status}`);

    const reg = body.events?.find((e) => e.eventAction === "registration")?.eventDate;
    return fromRegistration(domain, reg, "live");
  } catch (err) {
    const cached = fromFixture(domain, `live lookup failed (${(err as Error).message}) — cached capture`);
    if (cached) return cached;
    throw err;
  }
}
