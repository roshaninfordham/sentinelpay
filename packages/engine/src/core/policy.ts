import type { ForensicSignal, ReasonCode, RiskAssessment, RiskLevel } from "./types";

// Deterministic risk policy rules-v1. Pure function, no I/O, no LLM.
// Scoring and rationale text are byte-identical to src/lib/forensics/policy.ts; reasons/rules are additive.
//
//   domain_age_days < 30 (or no registry record) → +50
//   entity_match == false                          → +20   (request domain is not tied to the verified entity)
//   verified_phone != invoice phone                → +20
//   sanctions_hit                                  → +40
//   level = score>=60 CRITICAL | score>=30 ELEVATED | LOW

export const YOUNG_DOMAIN_DAYS = 30;
export const POLICY_VERSION = "rules-v1" as const;

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

function signal<K extends ForensicSignal["key"]>(signals: ForensicSignal[], key: K) {
  return signals.find((s) => s.key === key);
}

export function levelFor(score: number): RiskLevel {
  return score >= 60 ? "CRITICAL" : score >= 30 ? "ELEVATED" : "LOW";
}

export function assessRisk(signals: ForensicSignal[], invoiceContactPhone?: string): RiskAssessment {
  let score = 0;
  const notes: string[] = [];
  const reasons: ReasonCode[] = [];
  const rules: RiskAssessment["rules"] = [];

  const age = signal(signals, "domain_age_days");
  if (age) {
    if (age.value === null) {
      score += 50;
      notes.push("the request domain has no registry record");
      reasons.push("DOMAIN_UNREGISTERED");
      rules.push({ id: "young_domain", points: 50, evidence: "no registry record" });
    } else if (typeof age.value === "number" && age.value < YOUNG_DOMAIN_DAYS) {
      score += 50;
      notes.push(
        age.value <= 4
          ? `the request domain was registered about ${age.value * 24} hours ago`
          : `the request domain was registered ${age.value} days ago`,
      );
      reasons.push("DOMAIN_YOUNG");
      rules.push({ id: "young_domain", points: 50, evidence: `domain_age_days=${age.value}` });
    }
  }

  const entity = signal(signals, "entity_match");
  if (entity && entity.value === false) {
    score += 20;
    notes.push("the request domain is not linked to the vendor's verified legal entity");
    reasons.push("ENTITY_NOT_LINKED");
    rules.push({ id: "entity_mismatch", points: 20, evidence: "entity_match=false" });
  }

  const phone = signal(signals, "verified_phone");
  const verified = typeof phone?.value === "string" ? phone.value : undefined;
  if (phone && (!verified || !invoiceContactPhone || digits(verified) !== digits(invoiceContactPhone))) {
    score += 20;
    notes.push(verified ? "the invoice contact number differs from the registry number" : "no registry callback number could be verified");
    reasons.push(verified ? "INVOICE_PHONE_MISMATCH" : "CALLBACK_UNVERIFIED");
    rules.push({ id: "phone_unverified", points: 20, evidence: verified ? "invoice number differs from registry number" : "no verified callback number" });
  }

  const sanctions = signal(signals, "sanctions_hit");
  if (sanctions && sanctions.value === true) {
    score += 40;
    notes.push("the beneficiary matched a sanctions list");
    reasons.push("SANCTIONS_HIT");
    rules.push({ id: "sanctions", points: 40, evidence: `sanctions_hit via ${sanctions.source}` });
  }

  if (signals.some((s) => s.key === "probe_error")) reasons.push("PROBE_FAILED");

  score = Math.min(score, 100);
  const level = levelFor(score);
  const rationale = notes.length
    ? `Risk ${level} (score ${score}): ${notes.join("; ")}. Release is held pending out-of-band confirmation on the independently sourced number.`
    : `Risk ${level} (score ${score}): no adverse signals. The beneficiary change still requires out-of-band confirmation before release.`;

  return { level, score, reasons, signals, rules, verifiedCallbackPhone: verified, rationale, policyVersion: POLICY_VERSION };
}

/**
 * Fail-closed completion (§4.6 rule 2): a signal no probe produced is scored as adverse,
 * so a failed or missing probe can never lower the score.
 */
export function withMissingSignalsAdverse(signals: ForensicSignal[]): ForensicSignal[] {
  const out = [...signals];
  const missing = (key: ForensicSignal["key"]) => !signals.some((s) => s.key === key);
  if (missing("domain_age_days")) out.push({ key: "domain_age_days", value: null, source: "engine", origin: "live", detail: "no probe produced a registry record" });
  if (missing("entity_match")) out.push({ key: "entity_match", value: false, source: "engine", origin: "live", detail: "no probe linked the request domain to the vendor" });
  if (missing("verified_phone")) out.push({ key: "verified_phone", value: false, source: "engine", origin: "live", detail: "no probe verified a callback number" });
  return out;
}
