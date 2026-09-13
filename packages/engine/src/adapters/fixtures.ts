import { ConfigError, type Probe } from "../core/types";
import { rdapSignal, registrationDate, type RdapEvent } from "./rdap";
import { extractFindings, tavilyResult, type TavilyResponse } from "./tavily";

// Recorded probe data, passed in by the host (never imported here). Signals go through the same pure
// mappings as the live probes, so origin "fixture" is the only difference.

export interface RdapFixture {
  domains: Record<string, {
    events?: RdapEvent[];
    /** Registration relative to the probe's `now`, so a scenario reads "72 hours ago" on any day. */
    registeredHoursAgo?: number;
    notFound?: boolean;
  }>;
}

export interface TavilyFixture {
  vendors: Record<string, { entity: TavilyResponse; domain: TavilyResponse }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `id` selects the data shape: "rdap" takes an RdapFixture, "tavily" a TavilyFixture. */
export function fixtureProbe(id: string, data: unknown): Probe {
  if (id === "rdap") {
    if (!isRecord(data) || !isRecord(data.domains)) throw new ConfigError(`fixtureProbe("rdap") needs { domains: {...} }`);
    const { domains } = data as unknown as RdapFixture;
    return {
      id,
      async run({ payment, now }) {
        const domain = payment.requestSourceDomain;
        const f = domains[domain.toLowerCase()];
        // No capture is no evidence: throwing makes the engine record probe_error and score the gap adverse.
        if (!f) throw new Error(`no rdap fixture for ${domain}`);
        const registeredAt = f.registeredHoursAgo !== undefined
          ? new Date(now.getTime() - f.registeredHoursAgo * 36e5).toISOString()
          : registrationDate(f.events);
        return { origin: "fixture", signals: [rdapSignal({ domain, found: !f.notFound, registeredAt: f.notFound ? null : registeredAt }, now, "fixture")] };
      },
    };
  }

  if (id === "tavily") {
    if (!isRecord(data) || !isRecord(data.vendors)) throw new ConfigError(`fixtureProbe("tavily") needs { vendors: {...} }`);
    const { vendors } = data as unknown as TavilyFixture;
    return {
      id,
      async run({ payment, vendor }) {
        const f = vendors[vendor.id];
        if (!f) throw new Error(`no tavily fixture for ${vendor.id}`);
        return tavilyResult(vendor, payment, extractFindings(vendor, payment, f.entity, f.domain), "fixture");
      },
    };
  }

  throw new ConfigError(`fixtureProbe has no data shape for "${id}" (expected "rdap" or "tavily")`);
}

/**
 * Runs `live`; if it throws, runs `fallback` and says so in `note`. A probe the engine already timed out
 * (aborted signal) is not rescued: the timeout must stay a probe_error.
 */
export function withFallback(live: Probe, fallback: Probe): Probe {
  return {
    id: live.id,
    async run(ctx) {
      try {
        return await live.run(ctx);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const r = await fallback.run(ctx);
        const why = `live ${live.id} failed (${err instanceof Error ? err.message : String(err)}); ${fallback.id} ${r.origin} data used`;
        return { ...r, note: r.note ? `${why}; ${r.note}` : why };
      }
    },
  };
}
