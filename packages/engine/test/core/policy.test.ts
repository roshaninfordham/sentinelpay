import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk, levelFor, withMissingSignalsAdverse } from "../../src/core/policy";
import type { ForensicSignal } from "../../src/core/types";

// The 5 cases from src/lib/forensics/policy.test.ts with identical assertions. Signals gain `origin`, which the v1 type requires.
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
  return Object.entries(values).map(([key, value]) => ({ key: key as ForensicSignal["key"], value, source: sources[key], origin: "live" }));
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

// ── additive: reasons, rules, policyVersion ──

test("reasons and rules are derived from the same rules as the score", () => {
  const a = assessRisk(base({ domain_age_days: 3, entity_match: false }), "+1-000-000-0000");
  assert.deepEqual(a.reasons, ["DOMAIN_YOUNG", "ENTITY_NOT_LINKED", "INVOICE_PHONE_MISMATCH"]);
  assert.deepEqual(a.rules.map((r) => [r.id, r.points]), [["young_domain", 50], ["entity_mismatch", 20], ["phone_unverified", 20]]);
  assert.equal(a.rules.reduce((sum, r) => sum + r.points, 0), a.score);
  assert.equal(a.policyVersion, "rules-v1");

  assert.deepEqual(assessRisk(base({ domain_age_days: null, verified_phone: false }), "x").reasons, ["DOMAIN_UNREGISTERED", "CALLBACK_UNVERIFIED"]);
  assert.deepEqual(assessRisk(base({ sanctions_hit: true }), "(312) 555-0198").reasons, ["SANCTIONS_HIT"]);
  assert.deepEqual(assessRisk(base({}), "+1 312-555-0198").rules, []);
});

test("a probe_error signal adds PROBE_FAILED without changing the score", () => {
  const signals = [...base({}), { key: "probe_error" as const, value: "rdap", source: "rdap", origin: "live" as const }];
  const a = assessRisk(signals, "+1 312-555-0198");
  assert.equal(a.score, 0);
  assert.deepEqual(a.reasons, ["PROBE_FAILED"]);
});

test("missing signals are completed as adverse, never favourable", () => {
  const a = assessRisk(withMissingSignalsAdverse([]), "+1 312-555-0198");
  assert.equal(a.score, 90);
  assert.deepEqual(a.reasons, ["DOMAIN_UNREGISTERED", "ENTITY_NOT_LINKED", "CALLBACK_UNVERIFIED"]);
  assert.deepEqual(withMissingSignalsAdverse(base({})), base({}), "present signals are left untouched");
});

test("levelFor thresholds", () => {
  assert.deepEqual([0, 29, 30, 59, 60, 100].map(levelFor), ["LOW", "LOW", "ELEVATED", "ELEVATED", "CRITICAL", "CRITICAL"]);
});
