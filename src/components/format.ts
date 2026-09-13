import type { PaymentStatus } from "@/lib/types";

export const usd = (cents: number, digits = 2) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const STATUS_LABEL: Record<PaymentStatus, string> = {
  RECEIVED: "Pending release",
  PENDING_REVIEW: "Held",
  INVESTIGATING: "Investigating",
  CHALLENGING: "Awaiting vendor",
  QUARANTINED: "Frozen",
  CLEARED: "Released",
};

export const STATUS_TONE: Record<PaymentStatus, string> = {
  RECEIVED: "text-paper border-rule",
  PENDING_REVIEW: "text-brass border-brass/60",
  INVESTIGATING: "text-brass border-brass/60",
  CHALLENGING: "text-brass border-brass/60",
  QUARANTINED: "text-signal border-signal/70",
  CLEARED: "text-cleared border-cleared/60",
};

export const TERMINAL_STATUS = new Set<PaymentStatus>(["CLEARED", "QUARANTINED"]);

export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Absolute expiry in the viewer's time zone, e.g. "12:25 AM EDT". The same format on every surface. */
export const expiryTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/** "Meridian Global Logistics LLC" -> "Meridian Global Logistics". */
export const shortName = (legalName: string) => legalName.replace(/,?\s+(LLC|Inc\.?|Ltd\.?|Corp\.?|Co\.?)$/i, "");

export const possessive = (name: string) => (name.endsWith("s") ? `${name}’` : `${name}’s`);

/** Principal ids submitted outside the dashboard, read from the "(via …)" suffix the timeline writes on intake. */
export function requestersFrom(lines: { paymentId: string; text: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    const m = /^→ Release requested: .*\(via ([^)]+)\)$/.exec(l.text);
    if (m) out[l.paymentId] = m[1];
  }
  return out;
}

const LEVEL_WORD: Record<string, string> = { LOW: "Low", ELEVATED: "Elevated", CRITICAL: "Critical" };

/**
 * The engine's rationale in the dashboard's words: "Risk CRITICAL (score 90): …" reads "Critical risk, score 90: …".
 * "Out-of-band" is left to the receipt's assurance tier, which says whether the confirmation actually was.
 */
export const rationaleText = (rationale: string) =>
  rationale
    .replace(/^Risk (LOW|ELEVATED|CRITICAL) \(score (\d+)\):/, (_, level: string, score: string) => `${LEVEL_WORD[level]} risk, score ${score}:`)
    .replace(/out-of-band confirmation/g, "vendor confirmation");

export const SIGNAL_LABEL: Record<string, string> = {
  domain_age_days: "Request domain age",
  entity_match: "Entity match",
  verified_phone: "Registry phone",
  adverse_media: "Adverse media",
  sanctions_hit: "Sanctions",
  probe_error: "Probe error",
};

const SOURCE_LABEL: Record<string, string> = { rdap: "RDAP", tavily: "Tavily" };

/** "Request domain age · RDAP, fixture" */
export const signalLabel = (s: { key: string; source: string; origin?: string }) =>
  `${SIGNAL_LABEL[s.key] ?? s.key.replace(/_/g, " ")} · ${SOURCE_LABEL[s.source] ?? s.source}${s.origin === "fixture" ? ", recorded fixture" : ""}`;

/** Spoken digit groups ("ending 9 8 2 1") as written digits for transcripts on screen. */
export const writtenDigits = (text: string) => text.replace(/\b\d(?: \d){3}\b/g, (m) => m.replace(/ /g, ""));
