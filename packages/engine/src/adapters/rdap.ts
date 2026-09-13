import type { ForensicSignal, Probe } from "../core/types";

// RDAP probe: `GET https://rdap.org/domain/{domain}` for the change request's source domain.
// Deterministic, free, no key. Emits one domain_age_days signal (null = the registry has no record).

export const RDAP_BASE = "https://rdap.org/domain/";
export const DEFAULT_RDAP_USER_AGENT = "payfirewall/0.1 (+https://www.npmjs.com/package/payfirewall)";

export interface RdapEvent { eventAction: string; eventDate: string }

/** The registry's answer for one domain. `registeredAt: null` with `found: true` = registered, date not published. */
export interface RdapLookup { domain: string; found: boolean; registeredAt: string | null }

/** rdap.org answers 404 for TLDs it has no RDAP server for. That is absence of evidence, not "unregistered". */
export class RdapUnsupportedTldError extends Error {
  constructor(readonly domain: string) {
    super(`no RDAP service for .${domain.split(".").pop()}`);
    this.name = "RdapUnsupportedTldError";
  }
}

export const registrationDate = (events: RdapEvent[] | undefined): string | null =>
  events?.find((e) => e.eventAction === "registration")?.eventDate ?? null;

function describe(l: RdapLookup, ageHours: number | null, ageDays: number | null): string {
  if (!l.found) return "no registry record";
  if (ageHours === null || ageDays === null) return "registered (date not published)";
  if (ageHours <= 96) return `registered ${ageHours} hours ago`;
  if (ageDays < 365) return `registered ${ageDays} days ago`;
  return `registered ${Math.floor(ageDays / 365)} years ago (${l.registeredAt!.slice(0, 10)})`;
}

/**
 * Pure mapping from a lookup to the signal. A missing record or an unpublished registration date both
 * score as "no registry record" (null), which is the fail-closed reading the app has always used.
 */
export function rdapSignal(l: RdapLookup, now: Date, origin: ForensicSignal["origin"]): ForensicSignal {
  const ms = l.registeredAt ? now.getTime() - Date.parse(l.registeredAt) : NaN;
  const ageDays = l.found && Number.isFinite(ms) ? Math.floor(ms / 864e5) : null;
  const ageHours = l.found && Number.isFinite(ms) ? Math.floor(ms / 36e5) : null;
  return { key: "domain_age_days", value: ageDays, source: "rdap", origin, detail: `${l.domain}: ${describe(l, ageHours, ageDays)}` };
}

export function rdapProbe(opts: { fetch?: typeof fetch; userAgent?: string } = {}): Probe {
  const userAgent = opts.userAgent ?? DEFAULT_RDAP_USER_AGENT;
  return {
    id: "rdap",
    async run({ payment, signal, now }) {
      const domain = payment.requestSourceDomain;
      const doFetch = opts.fetch ?? globalThis.fetch;
      const res = await doFetch(`${RDAP_BASE}${encodeURIComponent(domain)}`, {
        signal,
        // rdap.org sits behind Cloudflare, which answers 403 to requests without a User-Agent.
        headers: { accept: "application/rdap+json, application/json", "user-agent": userAgent },
      });
      const body = (await res.json().catch(() => ({}))) as { events?: RdapEvent[]; title?: string };

      if (res.status === 404) {
        if (/no rdap service/i.test(body.title ?? "")) throw new RdapUnsupportedTldError(domain);
        return { origin: "live", signals: [rdapSignal({ domain, found: false, registeredAt: null }, now, "live")] };
      }
      if (!res.ok) throw new Error(`rdap ${res.status}`);
      return { origin: "live", signals: [rdapSignal({ domain, found: true, registeredAt: registrationDate(body.events) }, now, "live")] };
    },
  };
}
