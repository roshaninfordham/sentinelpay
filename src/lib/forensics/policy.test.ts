import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk } from "./policy";
import type { ForensicSignal } from "../types";

const base = (overrides: Partial<Record<ForensicSignal["key"], ForensicSignal["value"]>>): ForensicSignal[] => {
  const values = {
    domain_age_days: 9800,
    entity_match: true,
    verified_phone: "(312) 555-0198",
    sanctions_hit: false,
    ...overrides,
  };
  const sources: Record<string, ForensicSignal["source"]> = {
    domain_age_days: "rdap", entity_match: "tavily", verified_phone: "tavily", sanctions_hit: "opensanctions",
  };
  return Object.entries(values).map(([key, value]) => ({ key: key as ForensicSignal["key"], value, source: sources[key] }));
};

test("clean: long-lived domain, entity match, same phone → LOW 0", () => {
  const a = assessRisk(base({}), "+1 312-555-0198");
  assert.equal(a.score, 0);
  assert.equal(a.level, "LOW");
  assert.equal(a.verifiedCallbackPhone, "(312) 555-0198");
});

test("new domain: 3-day-old lookalike, unlinked, invoice phone differs → CRITICAL 90", () => {
  const a = assessRisk(base({ domain_age_days: 3, entity_match: false }), "+1-000-000-0000");
  assert.equal(a.score, 90);
  assert.equal(a.level, "CRITICAL");
  assert.match(a.rationale, /registered about 72 hours ago/);
});

test("no registry record scores like a young domain", () => {
  assert.equal(assessRisk(base({ domain_age_days: null }), "+1 312 555 0198").score, 50);
});

test("sanctioned: otherwise clean beneficiary on a sanctions list → ELEVATED 40", () => {
  const a = assessRisk(base({ sanctions_hit: true }), "(312) 555-0198");
  assert.equal(a.score, 40);
  assert.equal(a.level, "ELEVATED");
});

test("deterministic: same inputs, same output", () => {
  const s = base({ domain_age_days: 3, entity_match: false });
  assert.deepEqual(assessRisk(s, "+1-000-000-0000"), assessRisk(s, "+1-000-000-0000"));
});
