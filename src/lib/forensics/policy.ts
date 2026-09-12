import type { ForensicSignal, RiskAssessment, RiskLevel } from "../types";

// Deterministic risk policy (ARCHITECTURE §4 Node 2). Pure function, no I/O, no LLM.
//
//   domain_age_days < 30 (or no registry record) → +50
//   entity_match == false                          → +20   (request domain is not tied to the verified entity)
//   verified_phone != invoice phone                → +20
//   sanctions_hit                                  → +40
//   level = score>=60 CRITICAL | score>=30 ELEVATED | LOW

export const YOUNG_DOMAIN_DAYS = 30;

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

  const age = signal(signals, "domain_age_days");
  if (age) {
    if (age.value === null) {
      score += 50;
      notes.push("the request domain has no registry record");
    } else if (typeof age.value === "number" && age.value < YOUNG_DOMAIN_DAYS) {
      score += 50;
      notes.push(
        age.value <= 4
          ? `the request domain was registered about ${age.value * 24} hours ago`
          : `the request domain was registered ${age.value} days ago`,
      );
    }
  }

  const entity = signal(signals, "entity_match");
  if (entity && entity.value === false) {
    score += 20;
    notes.push("the request domain is not linked to the vendor's verified legal entity");
  }

  const phone = signal(signals, "verified_phone");
  const verified = typeof phone?.value === "string" ? phone.value : undefined;
  if (phone && (!verified || !invoiceContactPhone || digits(verified) !== digits(invoiceContactPhone))) {
    score += 20;
    notes.push(verified ? "the invoice contact number differs from the registry number" : "no registry callback number could be verified");
  }

  const sanctions = signal(signals, "sanctions_hit");
  if (sanctions && sanctions.value === true) {
    score += 40;
    notes.push("the beneficiary matched a sanctions list");
  }

  score = Math.min(score, 100);
  const level = levelFor(score);
  const rationale = notes.length
    ? `Risk ${level} (score ${score}): ${notes.join("; ")}. Release is held pending out-of-band confirmation on the independently sourced number.`
    : `Risk ${level} (score ${score}): no adverse signals. The beneficiary change still requires out-of-band confirmation before release.`;

  return { level, score, signals, verifiedCallbackPhone: verified, rationale };
}
