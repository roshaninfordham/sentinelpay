import { createEngine } from "../../src/core/engine";
import { memoryStorage } from "../../src/adapters/memory";
import { fixedClock, pendingChallenger } from "../../src/testing";
import type {
  ChallengeRequest, EngineConfig, EngineEvent, ForensicSignal, PaymentInput, Principal, Probe, Rail, StoredPayment, Vendor,
} from "../../src/core/types";

export const PEPPER = "pepper-for-tests-0123456789abcdef";
export const FP_KEY = "fingerprint-key-for-tests-0123456789";
export const T0 = "2026-09-12T18:00:00.000Z";

export const AGENT: Principal = { id: "agent:ap-bot", kind: "agent", roles: ["requester"] };
export const APPROVER: Principal = { id: "human:controller-desk", kind: "human", roles: ["operator"] };
export const OPERATOR: Principal = { id: "human:ops", kind: "human", roles: ["operator"] };

export const MERIDIAN: Vendor = {
  id: "v_meridian", legalName: "Meridian Global Logistics LLC", knownDomain: "meridianglobal.com", knownBankLast4: "4471",
};

export const REGISTRY_PHONE = "(312) 555-0198";
export const INVOICE_PHONE = "+1-000-000-0000";

export function poisoned(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    id: "pay_240k", vendorId: "v_meridian", amountCents: 24_000_000, currency: "USD",
    beneficiary: { accountLast4: "9821" }, requestSourceDomain: "meridian-global.co",
    invoiceContactPhone: INVOICE_PHONE, memo: "URGENT: pay today, call the number above to confirm",
    ...overrides,
  };
}

export function clean(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    id: "pay_18k", vendorId: "v_meridian", amountCents: 1_800_000, currency: "USD",
    beneficiary: { accountLast4: "4471" }, requestSourceDomain: "meridianglobal.com", ...overrides,
  };
}

/** Inline stand-in for fixtureProbe: returns fixed signals with the given origin. */
export function inlineProbe(id: string, signals: Array<Omit<ForensicSignal, "origin">>, origin: "live" | "fixture" = "live"): Probe {
  return {
    id,
    async run() {
      return { origin, signals: signals.map((s) => ({ ...s, origin })) };
    },
  };
}

/** RDAP says 3 days old; Tavily says the domain is unlinked and gives the registry number: CRITICAL 90. */
export const poisonedProbes = (origin: "live" | "fixture" = "live"): Probe[] => [
  inlineProbe("rdap", [{ key: "domain_age_days", value: 3, source: "rdap" }], origin),
  inlineProbe("tavily", [
    { key: "entity_match", value: false, source: "tavily" },
    { key: "verified_phone", value: REGISTRY_PHONE, source: "tavily" },
  ], origin),
];

export interface SpyRail extends Rail {
  releases: Array<{ payment: StoredPayment; idempotencyKey: string; ledgerAtRelease: string[] }>;
  setBeneficiary(last4: string): void;
  failNextRelease(): void;
}

export function spyRail(storageLedger: () => Promise<Array<{ event: string }>>, initialLast4: string): SpyRail {
  let last4 = initialLast4;
  let failNext = false;
  const releases: SpyRail["releases"] = [];
  return {
    id: "spy",
    environment: "test",
    releases,
    setBeneficiary: (v) => { last4 = v; },
    failNextRelease: () => { failNext = true; },
    async readBeneficiary() {
      return { accountLast4: last4 };
    },
    async release(payment, opts) {
      const ledgerAtRelease = (await storageLedger()).map((e) => e.event);
      releases.push({ payment, idempotencyKey: opts.idempotencyKey, ledgerAtRelease });
      if (failNext) {
        failNext = false;
        throw new Error("rail unavailable");
      }
      return { reference: `wire_${releases.length}`, status: "submitted" };
    },
  };
}

export function setup(overrides: Partial<EngineConfig> = {}) {
  const clock = fixedClock(T0);
  const storage = overrides.storage ?? memoryStorage({ now: clock.now });
  const starts: ChallengeRequest[] = [];
  const events: EngineEvent[] = [];
  const config: EngineConfig = {
    environment: "test",
    storage,
    vendors: { get: async (id) => (id === MERIDIAN.id ? structuredClone(MERIDIAN) : null) },
    challengers: [pendingChallenger((r) => starts.push(r))],
    probes: poisonedProbes(),
    secrets: { tokenPepper: PEPPER },
    payer: { name: "Acme Treasury" },
    principal: AGENT,
    allowTestChallengers: true,
    clock: clock.now,
    onEvent: (e) => { events.push(e); },
    ...overrides,
  };
  return { engine: createEngine(config), storage, clock, starts, events, config };
}

export const eventsOf = async (storage: { ledger(o?: { paymentId?: string }): Promise<Array<{ event: string }>> }, paymentId?: string) =>
  (await storage.ledger(paymentId ? { paymentId } : undefined)).map((e) => e.event);

export const code = (expected: string) => (err: unknown) => (err as { code?: string }).code === expected;
