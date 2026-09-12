import tavilyFixtures from "../../../fixtures/tavily.json";
import { demoMode } from "../env";
import type { Payment, Vendor } from "../types";

// Tavily probe — corporate identity resolution. Resolves the vendor's verified corporate phone
// from registry-grade sources and checks whether the change-request domain belongs to that entity.
// It never reads the contact details printed on the disputed invoice.

export const REGISTRY_DOMAINS = ["sec.gov", "opencorporates.com", "bloomberg.com"];

export interface TavilyResult { title: string; url: string; content: string; score?: number }
export interface TavilyResponse { query: string; results: TavilyResult[] }

export interface TavilyFindings {
  entityResolved: boolean;              // registry sources mention the vendor's legal name
  entitySources: string[];              // hostnames that corroborated it
  verifiedPhone: string | null;         // most-cited phone across registry results
  requestDomainLinked: boolean;         // any source ties requestSourceDomain to the entity
  adverseMedia: string | null;          // first result flagging the request domain as suspicious
  origin: "live" | "cache";
  note?: string;
}

const PHONE_RE = /\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
const ADVERSE_RE = /\b(phishing|fraud|scam|impersonat\w*|spoof\w*|lookalike|typosquat\w*|newly registered)\b/i;

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
export const formatPhone = (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** Pure extraction over Tavily-shaped responses. Used identically for live and cached data. */
export function extractFindings(
  vendor: Vendor,
  payment: Payment,
  entity: TavilyResponse,
  domain: TavilyResponse,
  origin: TavilyFindings["origin"],
  note?: string,
): TavilyFindings {
  const nameCore = vendor.legalName.replace(/\b(LLC|Inc\.?|Ltd\.?|Corp\.?|Co\.?)$/i, "").trim().toLowerCase();
  const invoiceDigits = payment.invoiceContactPhone ? digits(payment.invoiceContactPhone) : "";

  const entityHits = entity.results.filter((r) => `${r.title} ${r.content}`.toLowerCase().includes(nameCore));
  const counts = new Map<string, number>();
  for (const r of entityHits) {
    for (const m of r.content.matchAll(PHONE_RE)) {
      const d = `${m[1]}${m[2]}${m[3]}`;
      if (d === invoiceDigits || d.startsWith("000")) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const reqDomain = payment.requestSourceDomain.toLowerCase();
  const linked =
    reqDomain === vendor.knownDomain.toLowerCase() ||
    entityHits.some((r) => r.content.toLowerCase().includes(reqDomain) || host(r.url) === reqDomain);
  const adverse = domain.results.find((r) => r.content.toLowerCase().includes(reqDomain) && ADVERSE_RE.test(r.content));

  return {
    entityResolved: entityHits.length > 0,
    entitySources: [...new Set(entityHits.map((r) => host(r.url)))],
    verifiedPhone: best ? formatPhone(best) : null,
    requestDomainLinked: linked,
    adverseMedia: adverse ? `${host(adverse.url)}: ${adverse.title}` : null,
    origin,
    note,
  };
}

async function search(apiKey: string, body: Record<string, unknown>): Promise<TavilyResponse> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ search_depth: "advanced", max_results: 5, ...body }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const j = (await res.json()) as TavilyResponse;
  return { query: j.query, results: (j.results ?? []).map(({ title, url, content, score }) => ({ title, url, content, score })) };
}

export function queriesFor(vendor: Vendor, payment: Payment) {
  return {
    entity: { query: `${vendor.legalName} headquarters corporate phone`, include_domains: REGISTRY_DOMAINS },
    domain: { query: `${payment.requestSourceDomain} whois legitimacy` },
  };
}

type FixtureFile = { vendors: Record<string, { entity: TavilyResponse; domain: TavilyResponse }> };

function cached(vendor: Vendor, payment: Payment, note?: string): TavilyFindings {
  const f = (tavilyFixtures as unknown as FixtureFile).vendors[vendor.id];
  if (!f) {
    return { entityResolved: false, entitySources: [], verifiedPhone: null, requestDomainLinked: false, adverseMedia: null, origin: "cache", note: "no cached capture" };
  }
  return extractFindings(vendor, payment, f.entity, f.domain, "cache", note);
}

export async function investigateEntity(vendor: Vendor, payment: Payment): Promise<TavilyFindings> {
  const key = process.env.TAVILY_API_KEY;
  if (demoMode() === "cache") return cached(vendor, payment);
  if (!key) return cached(vendor, payment, "TAVILY_API_KEY not set — cached capture");

  try {
    const q = queriesFor(vendor, payment);
    const [entity, domain] = await Promise.all([search(key, q.entity), search(key, q.domain)]);
    const live = extractFindings(vendor, payment, entity, domain, "live");
    // A fictional demo vendor won't resolve on the open web; keep the scenario intact.
    if (!live.verifiedPhone) return cached(vendor, payment, "live search found no registry phone — cached capture");
    return live;
  } catch (err) {
    return cached(vendor, payment, `live search failed (${(err as Error).message}) — cached capture`);
  }
}
