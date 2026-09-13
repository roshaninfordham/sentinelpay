import { assessRisk, levelFor } from "payfirewall";

// The payfirewall://policy resource: enough of rules-v1 for a model to explain a score.
// Weights are restated here because the engine index does not export them; test/policy.test.ts checks
// every weight and threshold against assessRisk and levelFor, so a policy change fails the build.

export const POLICY = {
  policyVersion: assessRisk([]).policyVersion,
  scoreCap: 100,
  levels: [
    { level: levelFor(60), minScore: 60 },
    { level: levelFor(30), minScore: 30 },
    { level: levelFor(0), minScore: 0 },
  ],
  rules: [
    { id: "young_domain", points: 50, signal: "domain_age_days", when: "request domain registered under 30 days ago, or no registry record", reasons: ["DOMAIN_YOUNG", "DOMAIN_UNREGISTERED"] },
    { id: "entity_mismatch", points: 20, signal: "entity_match", when: "request domain is not linked to the vendor's verified legal entity", reasons: ["ENTITY_NOT_LINKED"] },
    { id: "phone_unverified", points: 20, signal: "verified_phone", when: "no registry callback number, or the invoice number differs from it", reasons: ["CALLBACK_UNVERIFIED", "INVOICE_PHONE_MISMATCH"] },
    { id: "sanctions", points: 40, signal: "sanctions_hit", when: "the beneficiary matched a sanctions list", reasons: ["SANCTIONS_HIT"] },
  ],
  failClosed: [
    "A signal no probe produced (domain_age_days, entity_match, verified_phone) is scored as adverse.",
    "A probe that fails or times out adds PROBE_FAILED and can never lower the score.",
  ],
  note: "The score explains the risk; it never authorizes payment. A changed beneficiary always needs out-of-band confirmation before PAY.",
} as const;
