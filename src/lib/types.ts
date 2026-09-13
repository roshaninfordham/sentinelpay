// App-side contracts. Engine vocabulary (states, verdicts, risk levels, challenge view) comes from
// @sentinelpay/engine; the shapes below are the dashboard's legacy wire format kept for one release.

import type { PaymentStatus, RiskLevel, Verdict, Verification } from "@sentinelpay/engine";

export type { PaymentStatus, RiskLevel, Verdict };

export interface Vendor {
  id: string;
  legalName: string;              // "Meridian Global Logistics LLC"
  knownDomain: string;            // "meridianglobal.com"  (the REAL, long-lived domain)
  knownBankLast4: string;         // beneficiary on file
  verifiedPhone?: string;         // resolved on demand; never trusted from the invoice
  registryUrl?: string;           // SEC/state/opencorporates ref
}

export interface Payment {
  id: string;
  vendorId: string;
  amountCents: number;            // 24000000 = $240,000.00
  currency: "USD";
  // details as they arrive on THIS disbursement (attacker-controlled surface):
  claimedBankLast4: string;
  requestSourceDomain: string;    // domain the change request came from
  invoiceContactPhone?: string;   // the number printed on the invoice (do NOT trust)
  status: PaymentStatus;
  createdAt: string;
  memo?: string;                  // AP context line shown in the queue (UI only)
  // Payment-rail linkage (PAYMENT_SOURCE=column). Absent on the mock rail.
  railCounterpartyId?: string;    // beneficiary record on the rail (source of truth for claimedBankLast4)
  railReference?: string;         // rail transfer id, set only when the wire is actually released
}

// Looser than the engine's ForensicSignal (origin optional) so pre-engine callers keep compiling.
export interface ForensicSignal {
  key: "domain_age_days" | "entity_match" | "verified_phone" | "adverse_media" | "sanctions_hit" | "probe_error";
  // domain_age_days is null when the registry has no record for the domain
  value: string | number | boolean | null;
  source: string;
  origin?: "live" | "fixture";
  detail?: string;                // human-readable line for the terminal
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;                  // 0..100
  signals: ForensicSignal[];
  verifiedCallbackPhone?: string; // the number the voice agent must dial
  rationale: string;              // one paragraph, plain English
  reasons?: string[];
  policyVersion?: string;
}

export interface CallOutcome {
  paymentId: string;
  verdict: Verdict;
  transcript: string;
  toolInvoked: "approve_payment" | "freeze_payment" | null;
  durationSec: number;
}

export interface LedgerEntry {
  seq: number;
  paymentId: string;
  event: string;                  // "INTERCEPTED" | "FORENSICS" | "CALL_RESULT" | "FROZEN" | "CLEARED"
  payload: unknown;
  prevHash: string;               // hex
  entryHash: string;              // sha256(seq|paymentId|event|payload|prevHash)
  ts: string;
}

// ── Provider interfaces (mock ↔ Rho swap without touching the pipeline) ──

export interface PaymentSource {
  listPending(): Promise<Payment[]>;
  get(id: string): Promise<Payment>;
  // enforcement hook — in prod a bank/AP system honors this; in demo it just updates state
  setStatus(id: string, status: PaymentStatus): Promise<void>;
}

export interface VendorDirectory {
  get(vendorId: string): Promise<Vendor>;
}

// ── Env contract ──
// DEMO_MODE=live  → hit real APIs, fall back to fixtures on failure / missing key
// DEMO_MODE=cache → fixtures only (wifi-off safe)
export type DemoMode = "live" | "cache";

// PAYMENT_SOURCE=mock   → SQLite AP queue; release/freeze only update state
// PAYMENT_SOURCE=column → beneficiary read from Column sandbox counterparties; release creates a sandbox wire
export type PaymentRail = "mock" | "column";

// ── Dashboard wire format (GET /api/stream) ──

export type TimelineKind = "info" | "warn" | "probe" | "risk" | "call" | "ok" | "alert";

export interface TimelineLine {
  id: number;
  paymentId: string;
  kind: TimelineKind;
  text: string;
  ts: string;
}

export type ChallengeView = NonNullable<Verification["challenge"]>;

export interface Snapshot {
  environment: string;
  demoMode: DemoMode;
  rail: { name: PaymentRail; note?: string };
  payments: Payment[];
  vendors: Vendor[];
  timeline: TimelineLine[];
  assessments: Record<string, RiskAssessment>;
  calls: Record<string, CallOutcome>;
  challenges: Record<string, ChallengeView>;
  ledger: LedgerEntry[];
  chain: { ok: boolean; brokenAt?: number };
}
