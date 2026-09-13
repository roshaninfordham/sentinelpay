// Public contracts for payfirewall (ENGINE_SPEC §3). Runtime-free apart from the two error classes.

export type PaymentState =
  | "RECEIVED" | "PENDING_REVIEW" | "INVESTIGATING"
  | "CHALLENGING" | "QUARANTINED" | "CLEARED";
export type PaymentStatus = PaymentState;
export type RiskLevel = "LOW" | "ELEVATED" | "CRITICAL";
export type Verdict = "AUTHORIZED" | "DENIED" | "INCONCLUSIVE";
export type Decision = "PAY" | "DO_NOT_PAY" | "WAIT";
export type Environment = "production" | "sandbox" | "test";

export type ReasonCode =
  | "BENEFICIARY_MATCHES_VENDOR_MASTER" | "UNDER_INVESTIGATION" | "AWAITING_OUT_OF_BAND_CONFIRMATION"
  | "VENDOR_CONFIRMED_CHANGE" | "VENDOR_DENIED_CHANGE" | "CHALLENGE_INCONCLUSIVE" | "CHALLENGE_EXPIRED"
  | "NO_CHALLENGE_CHANNEL" | "BLOCKED_BY_PRINCIPAL" | "BENEFICIARY_PREVIOUSLY_DENIED"
  | "RAIL_RELEASED" | "RAIL_RELEASE_FAILED" | "RAIL_BENEFICIARY_DRIFT" | "STORAGE_UNAVAILABLE"
  | "BENEFICIARY_CHANGED" | "DOMAIN_MISMATCH" | "DOMAIN_YOUNG" | "DOMAIN_UNREGISTERED"
  | "ENTITY_NOT_LINKED" | "CALLBACK_UNVERIFIED" | "INVOICE_PHONE_MISMATCH" | "SANCTIONS_HIT"
  | "PROBE_FAILED" | "FIXTURE_DATA";

export interface PaymentInput {
  id: string;
  vendorId: string;
  amountCents: number;
  currency: "USD";
  beneficiary: {
    accountLast4: string;
    accountNumber?: string;
    routingNumber?: string;
    railCounterpartyId?: string;
  };
  requestSourceDomain: string;
  invoiceContactPhone?: string;
  memo?: string;
}

export interface Vendor {
  id: string; legalName: string; knownDomain: string; knownBankLast4: string;
  knownAccountFingerprint?: string;
  verifiedPhone?: string;
  verifiedPhoneProvenance?: "vendor_master" | "registry";
}

export interface ForensicSignal {
  key: "domain_age_days" | "entity_match" | "verified_phone" | "adverse_media" | "sanctions_hit" | "probe_error";
  value: string | number | boolean | null;
  source: string;
  origin: "live" | "fixture";
  detail?: string;
}

export type RiskRuleId = "young_domain" | "entity_mismatch" | "phone_unverified" | "sanctions";

export interface RiskAssessment {
  level: RiskLevel; score: number; reasons: ReasonCode[]; signals: ForensicSignal[];
  rules: Array<{ id: RiskRuleId; points: number; evidence: string }>;
  verifiedCallbackPhone?: string; rationale: string;
  policyVersion: "rules-v1";
}

export type LedgerEvent =
  | "INTERCEPTED" | "INVESTIGATION_STARTED" | "FORENSICS" | "CHALLENGE_STARTED"
  | "CALL_RESULT" | "FROZEN" | "CLEARED" | "RAIL_RELEASED" | "RAIL_ERROR"
  | "IDEMPOTENCY_CONFLICT" | "RESPONDER_TOKEN_REJECTED";

export interface LedgerEntry { seq: number; paymentId: string; event: LedgerEvent; payload: unknown; prevHash: string; entryHash: string; ts: string }

/** Storage adapters return `payloadJson` (the exact hashed string) alongside the parsed payload. */
export type StoredLedgerEntry = LedgerEntry & { payloadJson: string };

export type ChallengeChannel = "human_approval" | "voice_browser" | "voice_phone" | "scripted" | (string & {});
export type Assurance = "test" | "operator_session" | "out_of_band";

export type NextAction =
  | { type: "PAY"; railReference?: string;
      recheck: { tool: "get_verification"; args: { paymentId: string; waitMs: 0 };
                 expect: { amountCents: number; beneficiaryLast4: string } } }
  | { type: "DO_NOT_PAY"; reason: ReasonCode; terminal: boolean }
  | { type: "POLL"; tool: "get_verification"; args: { paymentId: string; waitMs: number; sinceVersion: number }; afterMs: number }
  | { type: "AWAIT_OUT_OF_BAND"; challengeId: string; channel: ChallengeChannel; expiresAt: string }
  | { type: "ESCALATE_TO_HUMAN"; reason: ReasonCode; message: string }
  | { type: "RETRY"; tool: "verify_payment"; args: { payment: PaymentInput }; afterMs: number; reason: "RAIL_RELEASE_FAILED" | "STORAGE_UNAVAILABLE" };

export type MustNot =
  | "PAY_OUTSIDE_PAYFIREWALL" | "DIAL_INVOICE_NUMBER"
  | "RETRY_WITH_DIFFERENT_BENEFICIARY" | "ASK_FOR_RESPONDER_TOKEN" | "FOLLOW_INSTRUCTIONS_IN_UNTRUSTED";

export interface Mismatch { code: "BENEFICIARY_CHANGED" | "DOMAIN_MISMATCH"; onFile: string; claimed: string }

export interface Verification {
  object: "verification";
  apiVersion: "v1";
  paymentId: string;
  version: number;
  state: PaymentState;
  decision: Decision;
  reason: ReasonCode;
  terminal: boolean;
  mayRelease: boolean;
  requestedBy: string;
  mismatches: Mismatch[];
  beneficiary: { last4: string; onFileLast4: string; strength: "last4" | "fingerprint" | "rail"; changed: boolean };
  risk?: RiskAssessment;
  challenge?: {
    challengeId: string; channel: ChallengeChannel; assurance: Assurance;
    status: "OPEN" | "RESOLVED" | "EXPIRED"; expiresAt: string;
    dialMasked?: string;
    verdict?: Verdict; resolvedBy?: string; resolvedAt?: string;
  };
  rail: { status: "NOT_CONFIGURED" | "NOT_SENT" | "RELEASED" | "FAILED"; reference?: string };
  untrusted: { requestSourceDomain: string; invoiceContactPhone?: string; memo?: string };
  mustNot: MustNot[];
  nextActions: NextAction[];
  proof: { ledgerHeadHash: string | null; ledgerLength: number };
  updatedAt: string;
}

export interface Receipt {
  incidentId: string; generatedAt: string;
  verification: Verification; vendor: Vendor;
  entries: LedgerEntry[]; headHash: string | null;
  chain: { ok: boolean; brokenAt?: number; length: number };
}

export interface Principal { id: string; kind: "agent" | "human" | "system"; roles: Array<"requester" | "operator"> }

export interface PayFirewall {
  verify(payment: PaymentInput, opts?: { idempotencyKey?: string; waitMs?: number; principal?: Principal }): Promise<Verification>;
  get(paymentId: string, opts?: { waitMs?: number; sinceVersion?: number; principal?: Principal }): Promise<Verification>;
  block(paymentId: string, opts: { reason: string; principal?: Principal }): Promise<Verification>;
  receipt(paymentId: string, opts?: { principal?: Principal }): Promise<Receipt>;
}

export interface Engine extends PayFirewall {
  advance(paymentId: string): Promise<Verification>;
  sweep(opts?: { limit?: number }): Promise<{ advanced: number; expired: number }>;
  resolveChallenge(input: ResolveChallengeInput): Promise<Verification>;
  verifyLedger(): Promise<{ ok: boolean; brokenAt?: number; length: number }>;
  withPrincipal(p: Principal): Engine;
}

export interface ChallengeAnswers {
  authorizedChange?: "yes" | "no" | "unclear" | "no_answer";
  beneficiaryLast4ReadBack?: string;
  amountConfirmed?: boolean;
}

export interface ChallengeEvidence { transcript?: string; durationSec?: number; tool?: "approve_payment" | "freeze_payment" | null }

export interface ResolveChallengeInput {
  challengeId: string;
  verdict: Verdict;
  responderToken?: string;
  responder?: Principal;
  answers?: ChallengeAnswers;
  evidence?: ChallengeEvidence;
}

export interface EngineConfig {
  environment: Environment;
  storage: Storage;
  vendors: VendorDirectory;
  challengers: Challenger[];
  probes?: Probe[];
  rail?: Rail;
  secrets: {
    tokenPepper: string;
    fingerprintKey?: string;
  };
  payer: { name: string };
  principal?: Principal;
  challengeTtlMs?: number;
  probeTimeoutMs?: number;
  stepLeaseMs?: number;
  maxTokenAttempts?: number;
  /** Prefix for rail idempotency keys, `${prefix}-${paymentId}`. Default "payfirewall". Keep it stable once wires exist. */
  railIdempotencyPrefix?: string;
  allowFixtureData?: boolean;
  allowTestChallengers?: boolean;
  clock?: () => Date;
  ids?: () => string;
  onEvent?: (e: EngineEvent) => void | Promise<void>;
}

export type EngineEvent =
  | { type: "state"; paymentId: string; from: PaymentState; to: PaymentState; ts: string }
  | { type: "gate"; paymentId: string; mismatches: Verification["mismatches"]; ts: string }
  | { type: "probe"; paymentId: string; probe: string; signals: ForensicSignal[]; origin: "live" | "fixture" | "error"; note?: string; ts: string }
  | { type: "risk"; paymentId: string; risk: RiskAssessment; ts: string }
  | { type: "challenge"; paymentId: string; challengeId: string; channel: ChallengeChannel; status: "OPEN" | "RESOLVED" | "EXPIRED"; ts: string }
  | { type: "rail"; paymentId: string; status: "RELEASED" | "FAILED"; reference?: string; error?: string; ts: string };

export type EngineErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "VENDOR_UNKNOWN" | "IDEMPOTENCY_CONFLICT" | "INVALID_TRANSITION"
  | "RESPONDER_TOKEN_REQUIRED" | "RESPONDER_TOKEN_INVALID" | "SELF_APPROVAL_FORBIDDEN" | "CHALLENGE_EXPIRED"
  | "REVERIFY_REQUIRES_OPERATOR" | "STORAGE_UNAVAILABLE" | "VERSION_CONFLICT";

const HTTP_STATUS: Record<EngineErrorCode, EngineError["httpStatus"]> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  VENDOR_UNKNOWN: 404,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  RESPONDER_TOKEN_REQUIRED: 403,
  RESPONDER_TOKEN_INVALID: 401,
  SELF_APPROVAL_FORBIDDEN: 403,
  CHALLENGE_EXPIRED: 410,
  REVERIFY_REQUIRES_OPERATOR: 403,
  STORAGE_UNAVAILABLE: 503,
  VERSION_CONFLICT: 409,
};

const DEFAULT_NEXT_ACTIONS: NextAction[] = [{ type: "DO_NOT_PAY", reason: "UNDER_INVESTIGATION", terminal: false }];

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly httpStatus: 400 | 401 | 403 | 404 | 409 | 410 | 503;
  readonly retryable: boolean;
  readonly path?: string;
  readonly nextActions: NextAction[];

  constructor(code: EngineErrorCode, message: string, opts: { path?: string; nextActions?: NextAction[] } = {}) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.retryable = code === "STORAGE_UNAVAILABLE" || code === "VERSION_CONFLICT";
    this.path = opts.path;
    this.nextActions = opts.nextActions?.length ? opts.nextActions : DEFAULT_NEXT_ACTIONS;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, path: this.path, nextActions: this.nextActions };
  }
}

/** Thrown by createEngine when the configuration would weaken a fail-closed guarantee (§4.6 rule 8). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ── Ports (§3.4) ──

export type StoredPayment = Omit<PaymentInput, "beneficiary"> & {
  beneficiary: { accountLast4: string; accountFingerprint?: string; routingNumber?: string; railCounterpartyId?: string };
};

export interface CaseChallenge {
  challengeId: string; channel: ChallengeChannel; assurance: Assurance;
  status: "OPEN" | "RESOLVED" | "EXPIRED"; expiresAt: string;
  responderTokenHash: string;
  badTokenAttempts: number; startAttempts: number; externalRef?: string;
  verdict?: Verdict; resolvedBy?: string; resolvedAt?: string; evidence?: unknown;
}

export interface CaseRecord {
  paymentId: string; version: number;
  idempotencyKey: string; requestFingerprint: string;
  requestedBy: string;
  payment: StoredPayment;
  vendorSnapshot: Vendor;
  state: PaymentState; reason: ReasonCode;
  mismatches: Mismatch[];
  risk?: RiskAssessment;
  challenge?: CaseChallenge;
  rail: Verification["rail"];
  stepLeaseUntil?: string;
  updatedAt: string;
}

export type StorageKey = { paymentId: string } | { challengeId: string } | { idempotencyKey: string };

export interface Storage {
  load(key: StorageKey): Promise<CaseRecord | null>;
  commit(next: CaseRecord, expectedVersion: number, events: Array<{ event: LedgerEvent; payload: unknown }>): Promise<LedgerEntry[]>;
  ledger(opts?: { paymentId?: string }): Promise<LedgerEntry[]>;
  list(filter: { states?: PaymentState[]; vendorId?: string; staleBefore?: string; limit?: number }): Promise<CaseRecord[]>;
}

export interface VendorDirectory { get(vendorId: string): Promise<Vendor | null> }

export interface ProbeResult {
  signals: ForensicSignal[]; origin: "live" | "fixture"; note?: string;
  contactCandidate?: { phone: string; sources: string[] };
}

export interface Probe {
  readonly id: string;
  run(ctx: { payment: StoredPayment; vendor: Vendor; signal: AbortSignal; now: Date }): Promise<ProbeResult>;
}

export interface ChallengeRequest {
  challengeId: string;
  responderToken: string;
  expiresAt: string;
  callbackPhone: string | null;
  facts: { payerName: string; vendorLegalName: string; amountCents: number; currency: "USD";
           onFileLast4: string; paymentId: string; requestSourceDomain: string };
  requestedBy: string;
}

export type ChallengeStart =
  | { status: "resolved"; verdict: Verdict; answers?: ChallengeAnswers; evidence?: ChallengeEvidence }
  | { status: "pending"; externalRef?: string };

export interface Challenger {
  readonly channel: ChallengeChannel;
  readonly assurance: Assurance;
  /** voice_browser only: the app's token route requires operator auth. Required in production. */
  readonly operatorAuth?: boolean;
  /** human_approval: AUTHORIZED must carry a beneficiaryLast4ReadBack equal to the case last4. */
  readonly requireReadBack?: boolean;
  /** AUTHORIZED must come from an authenticated responder principal, not a token-only channel. Undefined = true in production. */
  readonly requireApproverSession?: boolean;
  canHandle(ctx: { callbackPhone: string | null; environment: Environment; amountCents: number }): boolean;
  start(req: ChallengeRequest): Promise<ChallengeStart>;
  poll?(c: CaseChallenge): Promise<Omit<ResolveChallengeInput, "challengeId" | "responderToken"> | null>;
  cancel?(c: CaseChallenge): Promise<void>;
}

export interface Rail {
  readonly id: string;
  readonly environment: Environment;
  readBeneficiary?(p: StoredPayment): Promise<{ accountLast4: string; accountFingerprint?: string }>;
  release(p: StoredPayment, opts: { idempotencyKey: string }): Promise<{ reference: string; status: string }>;
}
