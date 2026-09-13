import type { ForensicSignal, Probe, ProbeResult, StoredPayment, Vendor } from "../core/types";

// Tavily probe: corporate identity resolution. Resolves the vendor's corporate phone from registry-grade
// sources and checks whether the change-request domain belongs to that entity.
// It never reads the contact details printed on the disputed invoice.

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const REGISTRY_DOMAINS = ["sec.gov", "opencorporates.com", "bloomberg.com"];

export interface TavilyResult { title: string; url: string; content: string; score?: number }
export interface TavilyResponse { query: string; results: TavilyResult[] }

export interface TavilyFindings {
  entityResolved: boolean;              // registry sources mention the vendor's legal name
  entitySources: string[];              // hostnames that corroborated it
  verifiedPhone: string | null;         // most-cited phone across registry results
  requestDomainLinked: boolean;         // any source ties requestSourceDomain to the entity
  adverseMedia: string | null;          // first result flagging the request domain as suspicious
}

const PHONE_RE = /\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
const ADVERSE_RE = /\b(phishing|fraud|scam|impersonat\w*|spoof\w*|lookalike|typosquat\w*|newly registered)\b/i;

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
export const formatPhone = (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const onDomain = (h: string, domains: string[]) => domains.some((d) => h === d || h.endsWith(`.${d}`));

type PaymentFacts = Pick<StoredPayment, "requestSourceDomain" | "invoiceContactPhone">;

/**
 * Pure extraction over Tavily-shaped responses, used identically for live and fixture data.
 * A phone counts only when it comes from a registry host and is not the invoice's own number.
 */
export function extractFindings(
  vendor: Vendor,
  payment: PaymentFacts,
  entity: TavilyResponse,
  domain: TavilyResponse,
  registryDomains: string[] = REGISTRY_DOMAINS,
): TavilyFindings {
  const nameCore = vendor.legalName.replace(/\b(LLC|Inc\.?|Ltd\.?|Corp\.?|Co\.?)$/i, "").trim().toLowerCase();
  const invoiceDigits = payment.invoiceContactPhone ? digits(payment.invoiceContactPhone) : "";

  const entityHits = entity.results.filter((r) => `${r.title} ${r.content}`.toLowerCase().includes(nameCore));
  const counts = new Map<string, number>();
  for (const r of entityHits) {
    if (!onDomain(host(r.url), registryDomains)) continue;
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
  };
}

export function queriesFor(vendor: Vendor, payment: PaymentFacts, registryDomains: string[] = REGISTRY_DOMAINS) {
  return {
    entity: { query: `${vendor.legalName} headquarters corporate phone`, include_domains: registryDomains },
    domain: { query: `${payment.requestSourceDomain} whois legitimacy` },
  };
}

/** Maps findings to signals and the registry contact candidate. Shared by the live and fixture probes. */
export function tavilyResult(vendor: Vendor, payment: PaymentFacts, f: TavilyFindings, origin: ProbeResult["origin"]): ProbeResult {
  const domain = payment.requestSourceDomain;
  const signals: ForensicSignal[] = [
    {
      key: "entity_match", value: f.requestDomainLinked, source: "tavily", origin,
      detail: f.requestDomainLinked
        ? `${domain} belongs to ${vendor.legalName}`
        : `${domain} not linked to ${vendor.legalName} (${f.entitySources.join(", ") || "no sources"})`,
    },
    {
      key: "verified_phone", value: f.verifiedPhone ?? false, source: "tavily", origin,
      detail: f.verifiedPhone ? `registry line ${f.verifiedPhone}` : "no registry phone found",
    },
  ];
  if (f.adverseMedia) signals.push({ key: "adverse_media", value: f.adverseMedia, source: "tavily", origin, detail: f.adverseMedia });
  return {
    origin,
    signals,
    ...(f.verifiedPhone ? { contactCandidate: { phone: f.verifiedPhone, sources: f.entitySources } } : {}),
  };
}

export function tavilyProbe(opts: { apiKey: string; fetch?: typeof fetch; registryDomains?: string[] }): Probe {
  const registryDomains = opts.registryDomains ?? REGISTRY_DOMAINS;

  async function search(body: Record<string, unknown>, signal: AbortSignal): Promise<TavilyResponse> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const res = await doFetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ search_depth: "advanced", max_results: 5, ...body }),
      signal,
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const j = (await res.json()) as Partial<TavilyResponse>;
    return { query: j.query ?? "", results: (j.results ?? []).map(({ title, url, content, score }) => ({ title, url, content, score })) };
  }

  return {
    id: "tavily",
    async run({ payment, vendor, signal }) {
      const q = queriesFor(vendor, payment, registryDomains);
      const [entity, domain] = await Promise.all([search(q.entity, signal), search(q.domain, signal)]);
      return tavilyResult(vendor, payment, extractFindings(vendor, payment, entity, domain, registryDomains), "live");
    },
  };
}
