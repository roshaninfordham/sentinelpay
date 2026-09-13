import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fixtureProbe, withFallback } from "../../src/adapters/fixtures";
import { DEFAULT_RDAP_USER_AGENT, rdapProbe } from "../../src/adapters/rdap";
import { REGISTRY_DOMAINS, extractFindings, tavilyProbe, type TavilyResponse } from "../../src/adapters/tavily";
import { assessRisk } from "../../src/core/policy";
import { ConfigError, type Probe, type StoredPayment } from "../../src/core/types";
import { INVOICE_PHONE, MERIDIAN, REGISTRY_PHONE, T0, clean, poisoned } from "../core/helpers";
import { stubFetch } from "./stub-fetch";

const readFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../fixtures/${name}`, import.meta.url), "utf8"));
const RDAP_FIXTURE = readFixture("rdap.json");
const TAVILY_FIXTURE = readFixture("tavily.json") as { vendors: Record<string, { entity: TavilyResponse; domain: TavilyResponse }> };

const NOW = new Date(T0);
const ctx = (payment: StoredPayment = poisoned(), signal: AbortSignal = new AbortController().signal) =>
  ({ payment, vendor: MERIDIAN, signal, now: NOW });

// ── RDAP ──

test("rdap live: registration event -> domain_age_days, origin live, user-agent and ctx.signal sent", async () => {
  const { fetch, calls } = stubFetch(() => Response.json({ events: [
    { eventAction: "expiration", eventDate: "2027-02-27T05:00:00Z" },
    { eventAction: "registration", eventDate: "1999-02-27T05:00:00Z" },
  ] }));
  const c = ctx(clean());
  const r = await rdapProbe({ fetch }).run(c);
  assert.deepEqual(r, { origin: "live", signals: [{
    key: "domain_age_days", value: 10059, source: "rdap", origin: "live", detail: "meridianglobal.com: registered 27 years ago (1999-02-27)",
  }] });
  assert.equal(calls[0].url, "https://rdap.org/domain/meridianglobal.com");
  assert.equal(calls[0].headers["user-agent"], DEFAULT_RDAP_USER_AGENT);
  assert.equal(calls[0].signal, c.signal);
});

test("rdap live: a young domain is reported in hours and scores DOMAIN_YOUNG", async () => {
  const { fetch } = stubFetch(() => Response.json({ events: [{ eventAction: "registration", eventDate: "2026-09-09T18:00:00.000Z" }] }));
  const r = await rdapProbe({ fetch, userAgent: "custom/1" }).run(ctx());
  assert.equal(r.signals[0].value, 3);
  assert.equal(r.signals[0].detail, "meridian-global.co: registered 72 hours ago");
  assert.deepEqual(assessRisk(r.signals).reasons, ["DOMAIN_YOUNG"]);
});

test("rdap live: registered without a published date scores as no record (fail-closed)", async () => {
  const { fetch } = stubFetch(() => Response.json({ events: [] }));
  const r = await rdapProbe({ fetch }).run(ctx());
  assert.equal(r.signals[0].value, null);
  assert.equal(r.signals[0].detail, "meridian-global.co: registered (date not published)");
});

test("rdap 404: no such domain -> domain_age_days null (found:false), origin live", async () => {
  const { fetch } = stubFetch(() => Response.json({ errorCode: 404, title: "Not Found" }, { status: 404 }));
  const r = await rdapProbe({ fetch }).run(ctx());
  assert.equal(r.origin, "live");
  assert.deepEqual(r.signals, [{ key: "domain_age_days", value: null, source: "rdap", origin: "live", detail: "meridian-global.co: no registry record" }]);
  assert.deepEqual(assessRisk(r.signals).reasons, ["DOMAIN_UNREGISTERED"]);
});

test("rdap 404 'No RDAP service': not evidence of anything, so the probe throws", async () => {
  const { fetch } = stubFetch(() => Response.json({ title: "No RDAP service for this TLD" }, { status: 404 }));
  await assert.rejects(rdapProbe({ fetch }).run(ctx()), { name: "RdapUnsupportedTldError", message: "no RDAP service for .co" });
});

test("rdap 403 and a throwing fetch both reject", async () => {
  const forbidden = stubFetch(() => new Response("forbidden", { status: 403 }));
  await assert.rejects(rdapProbe({ fetch: forbidden.fetch }).run(ctx()), /rdap 403/);
  const offline = stubFetch(() => { throw new TypeError("fetch failed"); });
  await assert.rejects(rdapProbe({ fetch: offline.fetch }).run(ctx()), /fetch failed/);
});

// ── Tavily ──

const tavilyStub = (entity: TavilyResponse, domain: TavilyResponse = { query: "d", results: [] }) =>
  stubFetch(async (call) => {
    const body = JSON.parse(call.body!) as { include_domains?: string[] };
    return Response.json(body.include_domains ? entity : domain);
  });

test("extractFindings golden: fixtures/tavily.json for the poisoned payment", () => {
  const f = TAVILY_FIXTURE.vendors.v_meridian;
  assert.deepEqual(extractFindings(MERIDIAN, poisoned(), f.entity, f.domain), {
    entityResolved: true,
    entitySources: ["opencorporates.com", "bloomberg.com", "sec.gov"],
    verifiedPhone: REGISTRY_PHONE,
    phoneSources: ["opencorporates.com", "bloomberg.com", "sec.gov"],
    requestDomainLinked: false,
    adverseMedia: null,
  });
  assert.equal(extractFindings(MERIDIAN, clean(), f.entity, f.domain).requestDomainLinked, true);
});

test("extractFindings: the invoice number never becomes the verified phone, and non-registry hosts don't count", () => {
  const entity: TavilyResponse = { query: "q", results: [
    { title: "Meridian Global Logistics LLC", url: "https://opencorporates.com/x", content: "Meridian Global Logistics LLC phone (415) 555-0100" },
    { title: "Meridian Global Logistics LLC", url: "https://www.bloomberg.com/y", content: "Meridian Global Logistics LLC call 415.555.0100" },
    { title: "Meridian Global Logistics LLC", url: "https://pastebin.example/z", content: "Meridian Global Logistics LLC (650) 555-0111 (650) 555-0111 (650) 555-0111" },
  ] };
  const domain: TavilyResponse = { query: "d", results: [
    { title: "Lookalike alert", url: "https://security.example/post", content: "meridian-global.co is a lookalike phishing domain" },
  ] };
  const withInvoice = extractFindings(MERIDIAN, poisoned({ invoiceContactPhone: "+1 (415) 555-0100" }), entity, domain);
  assert.equal(withInvoice.verifiedPhone, null);
  assert.equal(withInvoice.adverseMedia, "security.example: Lookalike alert");
  const found = extractFindings(MERIDIAN, poisoned(), entity, domain);
  assert.equal(found.verifiedPhone, "(415) 555-0100");
  // Provenance is only the registry pages that cited the chosen number, never the non-registry page that mentions the vendor.
  assert.deepEqual(found.phoneSources, ["opencorporates.com", "bloomberg.com"]);
  assert.ok(found.entitySources.includes("pastebin.example"));
});

test("tavily live: Bearer auth, registry include_domains, signals with origin live, registry contactCandidate", async () => {
  const f = TAVILY_FIXTURE.vendors.v_meridian;
  const { fetch, calls } = tavilyStub(f.entity, f.domain);
  const c = ctx();
  const r = await tavilyProbe({ apiKey: "tvly-test", fetch }).run(c);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://api.tavily.com/search");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Authorization, "Bearer tvly-test");
    assert.equal(call.signal, c.signal);
    assert.doesNotMatch(call.body!, /000-000-0000/);
  }
  const entityBody = calls.map((x) => JSON.parse(x.body!)).find((b) => b.include_domains);
  assert.deepEqual(entityBody.include_domains, REGISTRY_DOMAINS);

  assert.equal(r.origin, "live");
  assert.deepEqual(r.signals.map((s) => [s.key, s.value, s.origin]), [["entity_match", false, "live"], ["verified_phone", REGISTRY_PHONE, "live"]]);
  assert.deepEqual(r.contactCandidate, { phone: REGISTRY_PHONE, sources: ["opencorporates.com", "bloomberg.com", "sec.gov"] });
  const risk = assessRisk(r.signals, INVOICE_PHONE);
  assert.equal(risk.verifiedCallbackPhone, REGISTRY_PHONE);
  assert.deepEqual(risk.reasons, ["ENTITY_NOT_LINKED", "INVOICE_PHONE_MISMATCH"]);
});

test("tavily live: no registry phone gives verified_phone false and no contactCandidate", async () => {
  const { fetch } = tavilyStub({ query: "q", results: [] });
  const r = await tavilyProbe({ apiKey: "k", fetch, registryDomains: ["registry.example"] }).run(ctx());
  assert.deepEqual(r.signals.map((s) => [s.key, s.value]), [["entity_match", false], ["verified_phone", false]]);
  assert.equal(r.contactCandidate, undefined);
});

test("tavily 403, 404 and a throwing fetch reject", async () => {
  for (const status of [403, 404]) {
    const { fetch } = stubFetch(() => Response.json({ detail: "no" }, { status }));
    await assert.rejects(tavilyProbe({ apiKey: "k", fetch }).run(ctx()), new RegExp(`tavily ${status}`));
  }
  const offline = stubFetch(() => { throw new TypeError("fetch failed"); });
  await assert.rejects(tavilyProbe({ apiKey: "k", fetch: offline.fetch }).run(ctx()), /fetch failed/);
});

// ── fixtures and fallback ──

test("fixtureProbe rdap: relative registration and recorded events, origin fixture", async () => {
  const probe = fixtureProbe("rdap", RDAP_FIXTURE);
  const young = await probe.run(ctx());
  assert.deepEqual(young, { origin: "fixture", signals: [{
    key: "domain_age_days", value: 3, source: "rdap", origin: "fixture", detail: "meridian-global.co: registered 72 hours ago",
  }] });
  assert.equal((await probe.run(ctx(clean()))).signals[0].value, 10059);
  assert.deepEqual((await fixtureProbe("rdap", { domains: { "gone.example": { notFound: true } } })
    .run(ctx(poisoned({ requestSourceDomain: "gone.example" })))).signals[0].value, null);
  await assert.rejects(probe.run(ctx(poisoned({ requestSourceDomain: "uncaptured.example" }))), /no rdap fixture/);
});

test("fixtureProbe tavily: same extraction as live, origin fixture on result and every signal", async () => {
  const r = await fixtureProbe("tavily", TAVILY_FIXTURE).run(ctx());
  assert.equal(r.origin, "fixture");
  assert.ok(r.signals.every((s) => s.origin === "fixture"));
  assert.deepEqual(r.signals.map((s) => [s.key, s.value]), [["entity_match", false], ["verified_phone", REGISTRY_PHONE]]);
  assert.equal(r.contactCandidate?.phone, REGISTRY_PHONE);
});

test("fixtureProbe refuses unknown ids and malformed data at construction", () => {
  assert.throws(() => fixtureProbe("sanctions", {}), ConfigError);
  assert.throws(() => fixtureProbe("rdap", { vendors: {} }), ConfigError);
  assert.throws(() => fixtureProbe("tavily", null), ConfigError);
});

test("withFallback: live result passes through; a live throw uses the fallback with a note; aborts are not rescued", async () => {
  const fallback = fixtureProbe("rdap", RDAP_FIXTURE);
  const live200 = stubFetch(() => Response.json({ events: [{ eventAction: "registration", eventDate: "2026-08-01T00:00:00Z" }] }));
  const ok = await withFallback(rdapProbe({ fetch: live200.fetch }), fallback).run(ctx());
  assert.equal(ok.origin, "live");
  assert.equal(ok.signals[0].value, 42);

  const noService = stubFetch(() => Response.json({ title: "No RDAP service" }, { status: 404 }));
  const probe = withFallback(rdapProbe({ fetch: noService.fetch }), fallback);
  assert.equal(probe.id, "rdap");
  const fell = await probe.run(ctx());
  assert.equal(fell.origin, "fixture");
  assert.equal(fell.signals[0].value, 3);
  assert.match(fell.note!, /live rdap failed \(no RDAP service for \.co\)/);

  const controller = new AbortController();
  const hanging: Probe = { id: "rdap", run: async () => { controller.abort(); throw new Error("aborted"); } };
  await assert.rejects(withFallback(hanging, fallback).run(ctx(poisoned(), controller.signal)), /aborted/);
});
