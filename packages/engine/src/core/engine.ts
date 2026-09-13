import { resolveConfig, type Settings } from "./config";
import { evaluateGate } from "./gate";
import { fingerprintAccount, sha256Hex, verifyEntries } from "./hash";
import { decisionFor, errorNextActions, toPaymentInput } from "./next-actions";
import { assessRisk, withMissingSignalsAdverse } from "./policy";
import { isTerminal, transition } from "./state";
import { hashResponderToken, newChallengeId, newResponderToken, responderTokenMatches } from "./token";
import {
  EngineError,
  type CaseChallenge, type CaseRecord, type ChallengeAnswers, type ChallengeRequest, type Challenger, type Engine, type EngineConfig,
  type EngineEvent, type ForensicSignal, type LedgerEntry, type LedgerEvent, type Mismatch, type PaymentInput, type Principal, type ReasonCode,
  type ResolveChallengeInput, type RiskAssessment, type Storage, type StorageKey, type StoredPayment,
  type Verdict, type Verification,
} from "./types";
import {
  validateBlockReason, validateIdempotencyKey, validatePaymentId, validatePaymentInput, validateResolveInput,
} from "./validate";
import { callbackPhoneFor, toVerification } from "./view";

type Events = Array<{ event: LedgerEvent; payload: unknown }>;
type Draft = Omit<CaseRecord, "version" | "updatedAt">;

const MAX_WAIT_MS = 25_000;
const POLL_INTERVAL_MS = 250;
const MAX_START_ATTEMPTS = 3;
const MAX_CAS_RETRIES = 25;
const VERDICT_SEVERITY: Record<Verdict, number> = { AUTHORIZED: 0, INCONCLUSIVE: 1, DENIED: 2 };

const isVersionConflict = (err: unknown) => (err as { code?: unknown })?.code === "VERSION_CONFLICT";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isOperator = (p: Principal) => p.roles.includes("operator");
const channelPrincipalId = (channel: string) => `channel:${channel}`;

/** Wraps a Storage so any adapter failure that is not a coded engine error surfaces as STORAGE_UNAVAILABLE (§4.6 rule 7). */
function guardStorage(s: Storage): Storage {
  const guard = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      if (err instanceof EngineError || isVersionConflict(err)) throw err;
      throw new EngineError("STORAGE_UNAVAILABLE", "storage unavailable", { nextActions: errorNextActions("STORAGE_UNAVAILABLE") });
    }
  };
  return {
    load: (key) => guard(() => s.load(key)),
    commit: (next, expected, events) => guard(() => s.commit(next, expected, events)),
    ledger: (opts) => guard(() => s.ledger(opts)),
    list: (filter) => guard(() => s.list(filter)),
  };
}

/** Re-runs a load -> decide -> commit step until it commits or observes that another writer already did the work. */
async function casLoop<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isVersionConflict(err) || attempt >= MAX_CAS_RETRIES) throw err;
    }
  }
}

/** Rethrows STORAGE_UNAVAILABLE with nextActions specific to the call that failed. */
async function inContext<T>(ctx: { payment?: PaymentInput; paymentId?: string }, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof EngineError && err.code === "STORAGE_UNAVAILABLE") {
      throw new EngineError("STORAGE_UNAVAILABLE", err.message, { nextActions: errorNextActions("STORAGE_UNAVAILABLE", ctx) });
    }
    throw err;
  }
}

export function createEngine(config: EngineConfig): Engine {
  return buildEngine(resolveConfig(config));
}

function buildEngine(settings: Settings, bound?: Principal): Engine {
  const { config, environment, now } = settings;
  const storage = guardStorage(config.storage);
  const probes = config.probes ?? [];
  const rail = config.rail;
  const iso = () => now().toISOString();

  const principalFor = (explicit?: Principal) => explicit ?? bound ?? settings.principal;

  async function emit(events: EngineEvent[]) {
    if (!config.onEvent) return;
    for (const e of events) {
      try {
        await config.onEvent(e);
      } catch {
        // Event sinks are observability only; they never affect a decision.
      }
    }
  }

  async function commit(prev: CaseRecord | null, draft: Draft, events: Events, extra: EngineEvent[] = []): Promise<CaseRecord> {
    const next: CaseRecord = { ...draft, version: (prev?.version ?? 0) + 1, updatedAt: iso() };
    await storage.commit(next, prev?.version ?? 0, events);
    const from = prev?.state ?? "RECEIVED";
    const stateEvent: EngineEvent[] = from !== next.state ? [{ type: "state", paymentId: next.paymentId, from, to: next.state, ts: iso() }] : [];
    await emit([...extra, ...stateEvent]);
    return next;
  }

  async function mustLoad(key: StorageKey): Promise<CaseRecord> {
    const c = await storage.load(key);
    if (!c) throw new EngineError("NOT_FOUND", "verification not found");
    return c;
  }

  async function view(c: CaseRecord): Promise<Verification> {
    const entries = await storage.ledger({ paymentId: c.paymentId });
    return toVerification(c, { headHash: entries.at(-1)?.entryHash ?? null, length: entries.length }, { railReadsBeneficiary: Boolean(rail?.readBeneficiary) });
  }

  function assertCanRead(p: Principal, c: CaseRecord) {
    // Same 404 as a missing case, so existence, amounts and untrusted text do not leak (§4.5 rule 5).
    if (c.requestedBy !== p.id && !isOperator(p)) throw new EngineError("NOT_FOUND", "verification not found");
  }

  const challengerFor = (channel: string): Challenger | undefined => config.challengers.find((ch) => ch.channel === channel);

  const fixtureBlocksClear = (risk?: RiskAssessment) =>
    Boolean(risk?.reasons.includes("FIXTURE_DATA")) ||
    (environment === "production" && !settings.allowFixtureData && Boolean(risk?.signals.some((s) => s.origin === "fixture")));

  // ── verify ──

  async function storedPaymentFor(p: PaymentInput): Promise<StoredPayment> {
    const { accountNumber, ...rest } = p.beneficiary;
    const beneficiary: StoredPayment["beneficiary"] = { ...rest };
    if (accountNumber !== undefined) {
      const key = config.secrets.fingerprintKey;
      if (!key) {
        throw new EngineError("INVALID_INPUT", "accountNumber is not accepted: no fingerprintKey is configured", { path: "/payment/beneficiary/accountNumber" });
      }
      beneficiary.accountFingerprint = await fingerprintAccount(key, rest.routingNumber ?? "", accountNumber);
    }
    return { ...p, beneficiary };
  }

  const requestFingerprintFor = (p: StoredPayment) =>
    sha256Hex(JSON.stringify([
      p.vendorId, p.amountCents, p.currency,
      p.beneficiary.accountLast4, p.beneficiary.accountFingerprint ?? "", p.beneficiary.railCounterpartyId ?? "",
      p.requestSourceDomain, p.invoiceContactPhone ?? "",
      // Appended only when present, so fingerprints of cases stored before routing was compared stay identical.
      ...(p.beneficiary.routingNumber ? [p.beneficiary.routingNumber] : []),
    ]));

  /**
   * Whether an incoming request is the one the case was opened for: the original submission, or the case's own
   * RETRY args. Those are rebuilt from the verified payment, so they carry the rail's last4 and no accountNumber.
   */
  const sameRequest = async (existing: CaseRecord, fingerprint: string) =>
    existing.requestFingerprint === fingerprint || (await requestFingerprintFor(toPaymentInput(existing.payment))) === fingerprint;

  const sameBeneficiary = (a: StoredPayment["beneficiary"], b: StoredPayment["beneficiary"]) =>
    a.accountFingerprint && b.accountFingerprint ? a.accountFingerprint === b.accountFingerprint : a.accountLast4 === b.accountLast4;

  /** §4.3 rule 7: a QUARANTINED case of the same vendor whose changed beneficiary equals this payment's. */
  const deniesBeneficiary = (q: CaseRecord, paymentId: string, p: StoredPayment) =>
    q.state === "QUARANTINED" && q.paymentId !== paymentId && q.payment.vendorId === p.vendorId &&
    q.mismatches.some((m) => m.code === "BENEFICIARY_CHANGED") && sameBeneficiary(q.payment.beneficiary, p.beneficiary);

  /**
   * A sibling case with the same beneficiary that was frozen after this case opened. Earlier denials were already
   * applied when the case was created (and only an operator gets past them), so they do not count again here.
   */
  async function deniedSinceOpened(c: CaseRecord): Promise<CaseRecord | undefined> {
    const siblings = (await storage.list({ states: ["QUARANTINED"], vendorId: c.payment.vendorId }))
      .filter((q) => q.reason !== "BENEFICIARY_PREVIOUSLY_DENIED" && deniesBeneficiary(q, c.paymentId, c.payment));
    if (siblings.length === 0) return undefined;
    const openedSeq = (await storage.ledger({ paymentId: c.paymentId }))[0]?.seq ?? 0;
    for (const q of siblings) {
      const frozen = (await storage.ledger({ paymentId: q.paymentId })).find((e) => e.event === "FROZEN");
      if (frozen && frozen.seq > openedSeq) return q;
    }
    return undefined;
  }

  async function conflict(existing: CaseRecord, detail: Record<string, unknown>): Promise<never> {
    await commit(existing, existing, [{ event: "IDEMPOTENCY_CONFLICT", payload: detail }]);
    throw new EngineError("IDEMPOTENCY_CONFLICT", "a different request already uses this payment id or idempotency key", {
      nextActions: errorNextActions("IDEMPOTENCY_CONFLICT"),
    });
  }

  async function createCase(input: PaymentInput, stored: StoredPayment, key: string, fingerprint: string, principal: Principal): Promise<CaseRecord> {
    const vendor = await config.vendors.get(input.vendorId);
    if (!vendor) throw new EngineError("VENDOR_UNKNOWN", "vendor is not in the vendor master", { path: "/payment/vendorId" });

    const payment: StoredPayment = { ...stored, beneficiary: { ...stored.beneficiary } };
    let railReadFailed = false;
    if (rail?.readBeneficiary) {
      try {
        const actual = await rail.readBeneficiary(payment);
        // The rail is the source of truth; a caller fingerprint the rail did not confirm must not survive.
        payment.beneficiary.accountLast4 = actual.accountLast4;
        delete payment.beneficiary.accountFingerprint;
        if (actual.accountFingerprint) payment.beneficiary.accountFingerprint = actual.accountFingerprint;
      } catch {
        railReadFailed = true;
      }
    }

    let mismatches: Mismatch[] = evaluateGate(payment, vendor);
    if (railReadFailed) {
      mismatches = [
        { code: "BENEFICIARY_CHANGED", onFile: vendor.knownBankLast4, claimed: "unknown" },
        ...mismatches.filter((m) => m.code !== "BENEFICIARY_CHANGED"),
      ];
    }

    const base: Draft = {
      paymentId: input.id, idempotencyKey: key, requestFingerprint: fingerprint, requestedBy: principal.id,
      payment, vendorSnapshot: vendor, state: "RECEIVED", reason: "UNDER_INVESTIGATION", mismatches,
      rail: { status: rail ? "NOT_SENT" : "NOT_CONFIGURED" },
    };
    const gateEvent: EngineEvent = { type: "gate", paymentId: input.id, mismatches, ts: iso() };

    if (mismatches.length === 0) {
      return commit(null, { ...base, state: transition("RECEIVED", "GATE_MATCH"), reason: "BENEFICIARY_MATCHES_VENDOR_MASTER" },
        [{ event: "CLEARED", payload: { reason: "BENEFICIARY_MATCHES_VENDOR_MASTER" } }], [gateEvent]);
    }

    const intercepted = {
      event: "INTERCEPTED" as const,
      payload: {
        mismatches,
        onFile: { bankLast4: vendor.knownBankLast4, domain: vendor.knownDomain },
        claimed: { bankLast4: payment.beneficiary.accountLast4, domain: payment.requestSourceDomain },
      },
    };

    if (mismatches.some((m) => m.code === "BENEFICIARY_CHANGED") && !isOperator(principal)) {
      const quarantined = await storage.list({ states: ["QUARANTINED"], vendorId: input.vendorId });
      const denied = quarantined.find((q) => deniesBeneficiary(q, input.id, payment));
      if (denied) {
        return commit(null, { ...base, state: transition("RECEIVED", "PREVIOUSLY_DENIED"), reason: "BENEFICIARY_PREVIOUSLY_DENIED" },
          [intercepted, { event: "FROZEN", payload: { reason: "BENEFICIARY_PREVIOUSLY_DENIED", deniedPaymentId: denied.paymentId } }], [gateEvent]);
      }
    }

    return commit(null, { ...base, state: transition("RECEIVED", "GATE_MISMATCH"), reason: "UNDER_INVESTIGATION" }, [intercepted], [gateEvent]);
  }

  // ── investigation ──

  async function runProbes(c: CaseRecord): Promise<ForensicSignal[]> {
    const results = await Promise.all(probes.map(async (probe) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`probe ${probe.id} timed out after ${settings.probeTimeoutMs}ms`));
        }, settings.probeTimeoutMs);
      });
      try {
        const r = await Promise.race([probe.run({ payment: c.payment, vendor: c.vendorSnapshot, signal: controller.signal, now: now() }), timeout]);
        // A fixture-origin result taints every signal it carries, whatever the probe claims per signal.
        const signals = r.signals.map((s) => ({ ...s, origin: r.origin === "fixture" ? ("fixture" as const) : s.origin }));
        return { probe: probe.id, signals, origin: r.origin, note: r.note };
      } catch (err) {
        const signals: ForensicSignal[] = [{ key: "probe_error", value: probe.id, source: probe.id, origin: "live", detail: errorMessage(err) }];
        return { probe: probe.id, signals, origin: "error" as const, note: errorMessage(err) };
      } finally {
        clearTimeout(timer);
      }
    }));
    await emit(results.map((r) => ({
      type: "probe" as const, paymentId: c.paymentId, probe: r.probe, signals: r.signals, origin: r.origin,
      ...(r.note !== undefined ? { note: r.note } : {}), ts: iso(),
    })));
    return results.flatMap((r) => r.signals);
  }

  function score(c: CaseRecord, signals: ForensicSignal[]): RiskAssessment {
    const risk = assessRisk(withMissingSignalsAdverse(signals), c.payment.invoiceContactPhone);
    if (environment === "production" && !settings.allowFixtureData && risk.signals.some((s) => s.origin === "fixture")) {
      risk.reasons.push("FIXTURE_DATA");
    }
    return risk;
  }

  async function investigate(c: CaseRecord): Promise<CaseRecord> {
    const vendor = (await config.vendors.get(c.payment.vendorId)) ?? c.vendorSnapshot;
    let leased: CaseRecord;
    try {
      leased = await commit(c, {
        ...c, vendorSnapshot: vendor, state: transition(c.state, "TAKE_LEASE"),
        stepLeaseUntil: new Date(now().getTime() + settings.stepLeaseMs).toISOString(),
      }, [{ event: "INVESTIGATION_STARTED", payload: { status: "INVESTIGATING" } }]);
    } catch (err) {
      if (isVersionConflict(err)) return mustLoad({ paymentId: c.paymentId });
      throw err;
    }

    const risk = score(leased, await runProbes(leased));
    await emit([{ type: "risk", paymentId: c.paymentId, risk, ts: iso() }]);
    const callbackPhone = callbackPhoneFor({ ...leased, risk });
    const challenger = config.challengers.find((ch) =>
      ch.canHandle({ callbackPhone, environment, amountCents: leased.payment.amountCents }));

    try {
      if (!challenger) {
        return await commit(leased, {
          ...leased, risk, state: transition(leased.state, "NO_CHALLENGE_CHANNEL"), reason: "NO_CHALLENGE_CHANNEL", stepLeaseUntil: undefined,
        }, [{ event: "FORENSICS", payload: risk }, { event: "FROZEN", payload: { reason: "NO_CHALLENGE_CHANNEL", amountCents: leased.payment.amountCents } }]);
      }
      const token = newResponderToken();
      const challenge: CaseChallenge = {
        challengeId: config.ids?.() ?? newChallengeId(),
        channel: challenger.channel,
        assurance: challenger.assurance,
        status: "OPEN",
        expiresAt: new Date(now().getTime() + settings.challengeTtlMs).toISOString(),
        responderTokenHash: await hashResponderToken(config.secrets.tokenPepper, token),
        badTokenAttempts: 0,
        startAttempts: 1,
      };
      // CHALLENGE_STARTED is committed before start() so a crash can never leave an unrecorded open challenge.
      const opened = await commit(leased, {
        ...leased, risk, challenge, state: transition(leased.state, "OPEN_CHALLENGE"), reason: "AWAITING_OUT_OF_BAND_CONFIRMATION", stepLeaseUntil: undefined,
      }, [
        { event: "FORENSICS", payload: risk },
        { event: "CHALLENGE_STARTED", payload: { dial: callbackPhone, challengeId: challenge.challengeId, channel: challenge.channel, assurance: challenge.assurance, expiresAt: challenge.expiresAt } },
      ], [{ type: "challenge", paymentId: c.paymentId, challengeId: challenge.challengeId, channel: challenge.channel, status: "OPEN", ts: iso() }]);
      return await startChallenge(opened, challenger, token);
    } catch (err) {
      if (isVersionConflict(err)) return mustLoad({ paymentId: c.paymentId });
      throw err;
    }
  }

  async function startChallenge(c: CaseRecord, challenger: Challenger, token: string): Promise<CaseRecord> {
    const ch = c.challenge!;
    const vendor = c.vendorSnapshot;
    const req: ChallengeRequest = {
      challengeId: ch.challengeId,
      responderToken: token,
      expiresAt: ch.expiresAt,
      callbackPhone: callbackPhoneFor(c),
      facts: {
        payerName: config.payer.name, vendorLegalName: vendor.legalName, amountCents: c.payment.amountCents, currency: "USD",
        onFileLast4: vendor.knownBankLast4, paymentId: c.paymentId, requestSourceDomain: c.payment.requestSourceDomain,
      },
      requestedBy: c.requestedBy,
    };

    let started;
    try {
      started = await challenger.start(req);
    } catch {
      return casLoop(() => recordStartFailure(ch.challengeId));
    }
    if (started.status === "resolved") {
      return casLoop(() => resolveOnce({ challengeId: ch.challengeId, verdict: started.verdict, answers: started.answers, evidence: started.evidence }, "channel"));
    }
    if (started.externalRef) {
      const ref = started.externalRef;
      return casLoop(async () => {
        const cur = await mustLoad({ paymentId: c.paymentId });
        if (cur.state !== "CHALLENGING" || cur.challenge?.challengeId !== ch.challengeId) return cur;
        return commit(cur, { ...cur, challenge: { ...cur.challenge, externalRef: ref } }, []);
      });
    }
    return c;
  }

  async function recordStartFailure(challengeId: string): Promise<CaseRecord> {
    const c = await mustLoad({ challengeId });
    const ch = c.challenge!;
    if (c.state !== "CHALLENGING" || ch.status !== "OPEN") return c;
    if (ch.startAttempts >= MAX_START_ATTEMPTS) {
      return commit(c, {
        ...c, state: transition(c.state, "INCONCLUSIVE"), reason: "CHALLENGE_INCONCLUSIVE",
        challenge: { ...ch, responderTokenHash: "", status: "RESOLVED", verdict: "INCONCLUSIVE", resolvedBy: "engine", resolvedAt: iso() },
      }, [
        { event: "CALL_RESULT", payload: { challengeId, verdict: "INCONCLUSIVE", reason: "CHALLENGE_INCONCLUSIVE", detail: "challenger could not start", resolvedBy: "engine" } },
        { event: "FROZEN", payload: { verdict: "INCONCLUSIVE", reason: "CHALLENGE_INCONCLUSIVE", amountCents: c.payment.amountCents } },
      ], [{ type: "challenge", paymentId: c.paymentId, challengeId, channel: ch.channel, status: "RESOLVED", ts: iso() }]);
    }
    // An empty hash means no live token exists; the next advance mints a fresh one and retries start().
    return commit(c, { ...c, challenge: { ...ch, responderTokenHash: "" } }, []);
  }

  async function retryStart(c: CaseRecord): Promise<CaseRecord> {
    const ch = c.challenge!;
    const challenger = challengerFor(ch.channel);
    if (!challenger) return c;
    const token = newResponderToken();
    let rearmed: CaseRecord;
    try {
      rearmed = await commit(c, {
        ...c, challenge: { ...ch, responderTokenHash: await hashResponderToken(config.secrets.tokenPepper, token), startAttempts: ch.startAttempts + 1 },
      }, []);
    } catch (err) {
      if (isVersionConflict(err)) return mustLoad({ paymentId: c.paymentId });
      throw err;
    }
    return startChallenge(rearmed, challenger, token);
  }

  // ── challenge resolution ──

  const expired = (c: CaseRecord) => c.state === "CHALLENGING" && c.challenge?.status === "OPEN" && now().getTime() >= Date.parse(c.challenge.expiresAt);

  async function expire(c: CaseRecord, rejected?: { event: LedgerEvent; payload: unknown }): Promise<CaseRecord> {
    const ch = c.challenge!;
    const next = await commit(c, {
      ...c, state: transition(c.state, "EXPIRE"), reason: "CHALLENGE_EXPIRED", challenge: { ...ch, status: "EXPIRED" },
    }, [
      ...(rejected ? [rejected] : []),
      { event: "CALL_RESULT", payload: { challengeId: ch.challengeId, verdict: "INCONCLUSIVE", reason: "CHALLENGE_EXPIRED" } },
      { event: "FROZEN", payload: { verdict: "INCONCLUSIVE", reason: "CHALLENGE_EXPIRED", amountCents: c.payment.amountCents } },
    ], [{ type: "challenge", paymentId: c.paymentId, challengeId: ch.challengeId, channel: ch.channel, status: "EXPIRED", ts: iso() }]);
    await cancelChallenge(next);
    return next;
  }

  async function cancelChallenge(c: CaseRecord) {
    const challenger = c.challenge && challengerFor(c.challenge.channel);
    try {
      await challenger?.cancel?.(c.challenge!);
    } catch {
      // Cancellation is best effort; the case is already terminal.
    }
  }

  function downgrade(verdict: Verdict, answers: ChallengeAnswers | undefined, readBack: { required: boolean; last4: string }): Verdict {
    let v = verdict;
    const atLeast = (to: Verdict) => {
      if (VERDICT_SEVERITY[to] > VERDICT_SEVERITY[v]) v = to;
    };
    if (answers?.authorizedChange === "no") atLeast("DENIED");
    if (answers?.authorizedChange === "unclear" || answers?.authorizedChange === "no_answer") atLeast("INCONCLUSIVE");
    if (answers?.amountConfirmed === false) atLeast("INCONCLUSIVE");
    if (v === "AUTHORIZED" && readBack.required && answers?.beneficiaryLast4ReadBack !== readBack.last4) atLeast("DENIED");
    return v;
  }

  /**
   * One resolution attempt. `ingress` is the token-bound responder route (in-process resolveChallenge);
   * `channel` is a result the challenger itself produced through start() or poll(), which authenticates itself.
   */
  async function resolveOnce(input: ResolveChallengeInput, source: "ingress" | "channel"): Promise<CaseRecord> {
    const wantsAuthorize = input.verdict === "AUTHORIZED";
    let c = await storage.load({ challengeId: input.challengeId });
    if (!c?.challenge) {
      // An unknown challenge answers exactly like a bad token, so the route is not an existence oracle.
      if (source === "ingress" && wantsAuthorize) throw new EngineError("RESPONDER_TOKEN_INVALID", "responder token is invalid");
      throw new EngineError("NOT_FOUND", "challenge not found");
    }
    if (expired(c)) c = await expire(c);
    const ch = c.challenge!;

    if (source === "ingress" && wantsAuthorize) {
      const valid = await responderTokenMatches(config.secrets.tokenPepper, input.responderToken ?? "", ch.responderTokenHash);
      if (!valid) {
        if (c.state === "CHALLENGING" && ch.status === "OPEN") {
          const attempts = ch.badTokenAttempts + 1;
          const rejected = { event: "RESPONDER_TOKEN_REJECTED" as const, payload: { challengeId: ch.challengeId, reason: "RESPONDER_TOKEN_INVALID", attempts } };
          const counted = { ...c, challenge: { ...ch, badTokenAttempts: attempts } };
          if (attempts >= settings.maxTokenAttempts) await expire(counted, rejected);
          else await commit(c, counted, [rejected]);
        }
        throw new EngineError("RESPONDER_TOKEN_INVALID", "responder token is invalid");
      }
    }

    if (isTerminal(c.state)) {
      if (wantsAuthorize && ch.status === "EXPIRED") throw new EngineError("CHALLENGE_EXPIRED", "the challenge expired and the payment was frozen");
      return c; // first writer wins; replays and late verdicts see the terminal case unchanged
    }
    if (c.state !== "CHALLENGING" || ch.status !== "OPEN") throw new EngineError("INVALID_TRANSITION", `case is ${c.state}; no open challenge`);

    const challenger = challengerFor(ch.channel);
    const responder = input.responder;
    const personAuthenticated = Boolean(responder && !responder.id.startsWith("channel:"));

    if (wantsAuthorize) {
      if (personAuthenticated && responder!.id === c.requestedBy) {
        await commit(c, c, [{ event: "RESPONDER_TOKEN_REJECTED", payload: { challengeId: ch.challengeId, reason: "SELF_APPROVAL_FORBIDDEN", responder: responder!.id } }]);
        throw new EngineError("SELF_APPROVAL_FORBIDDEN", "the requester cannot approve its own payment");
      }
      const requireSession = challenger?.requireApproverSession ?? environment === "production";
      if (source === "ingress" && requireSession && !personAuthenticated) {
        throw new EngineError("RESPONDER_TOKEN_REQUIRED", "this channel requires an authenticated approver session to authorize");
      }
    }

    const readBackRequired = challenger?.requireReadBack ?? ch.channel === "human_approval";
    const verdict = downgrade(input.verdict, input.answers, { required: readBackRequired, last4: c.payment.beneficiary.accountLast4 });
    if (verdict === "AUTHORIZED" && fixtureBlocksClear(c.risk)) {
      throw new EngineError("INVALID_TRANSITION", "fixture data cannot clear a payment in production");
    }

    const resolvedBy = responder?.id ?? channelPrincipalId(ch.channel);
    const callResult = {
      challengeId: ch.challengeId, verdict, requestedVerdict: input.verdict, answers: input.answers ?? null, evidence: input.evidence ?? null,
      requestedBy: c.requestedBy, resolvedBy, authorizedWithToken: source === "ingress" && wantsAuthorize,
    };
    const challengeEvent: EngineEvent = { type: "challenge", paymentId: c.paymentId, challengeId: ch.challengeId, channel: ch.channel, status: "RESOLVED", ts: iso() };

    // §4.3 rule 7 for cases opened in parallel: a sibling denied while this challenge was open stops it clearing.
    const sibling = verdict === "AUTHORIZED" && c.mismatches.some((m) => m.code === "BENEFICIARY_CHANGED") && !(responder && isOperator(responder))
      ? await deniedSinceOpened(c)
      : undefined;
    if (sibling) {
      const frozen = await commit(c, {
        ...c,
        state: transition(c.state, "PREVIOUSLY_DENIED"),
        reason: "BENEFICIARY_PREVIOUSLY_DENIED",
        challenge: { ...ch, status: "RESOLVED", verdict: "DENIED", resolvedBy, resolvedAt: iso(), evidence: input.evidence },
      }, [
        { event: "CALL_RESULT", payload: { ...callResult, verdict: "DENIED", reason: "BENEFICIARY_PREVIOUSLY_DENIED", deniedPaymentId: sibling.paymentId } },
        { event: "FROZEN", payload: { verdict: "DENIED", reason: "BENEFICIARY_PREVIOUSLY_DENIED", deniedPaymentId: sibling.paymentId, amountCents: c.payment.amountCents } },
      ], [challengeEvent]);
      await cancelChallenge(frozen);
      return frozen;
    }

    const reason: ReasonCode = verdict === "AUTHORIZED" ? "VENDOR_CONFIRMED_CHANGE" : verdict === "DENIED" ? "VENDOR_DENIED_CHANGE" : "CHALLENGE_INCONCLUSIVE";
    const resolved = await commit(c, {
      ...c,
      state: transition(c.state, verdict === "AUTHORIZED" ? "AUTHORIZE" : verdict === "DENIED" ? "DENY" : "INCONCLUSIVE"),
      reason,
      challenge: { ...ch, status: "RESOLVED", verdict, resolvedBy, resolvedAt: iso(), evidence: input.evidence },
    }, [
      { event: "CALL_RESULT", payload: callResult },
      verdict === "AUTHORIZED"
        ? { event: "CLEARED", payload: { verdict, challengeId: ch.challengeId, reason } }
        : { event: "FROZEN", payload: { verdict, reason, amountCents: c.payment.amountCents } },
    ], [challengeEvent]);
    if (verdict !== "AUTHORIZED") await cancelChallenge(resolved);
    return resolved;
  }

  async function progressChallenge(c: CaseRecord): Promise<CaseRecord> {
    if (expired(c)) return casLoop(async () => {
      const cur = await mustLoad({ paymentId: c.paymentId });
      return expired(cur) ? expire(cur) : cur;
    });
    const ch = c.challenge;
    if (!ch || ch.status !== "OPEN") return c;
    if (ch.responderTokenHash === "") return retryStart(c);

    const challenger = challengerFor(ch.channel);
    if (!challenger?.poll) return c;
    let polled;
    try {
      polled = await challenger.poll(ch);
    } catch {
      return c; // a failing poll leaves the challenge open; expiry still fails it closed
    }
    if (!polled) return c;
    const result = polled;
    return casLoop(() => resolveOnce({ ...result, challengeId: ch.challengeId }, "channel"));
  }

  // ── settlement ──

  async function recordRail(paymentId: string, update: { rail: CaseRecord["rail"]; reason: ReasonCode }, event: { event: LedgerEvent; payload: unknown }, railEvent: EngineEvent) {
    await casLoop(async () => {
      const cur = await mustLoad({ paymentId });
      if (cur.rail.status === "RELEASED") return cur;
      return commit(cur, { ...cur, ...update }, [event], [railEvent]);
    });
  }

  /** Runs after CLEARED is committed: re-reads the beneficiary at the rail, then releases (§4.5). */
  async function settle(paymentId: string, opts: { retryFailed: boolean }) {
    if (!rail) return;
    const c = await mustLoad({ paymentId });
    if (c.state !== "CLEARED" || c.rail.status === "RELEASED" || c.rail.status === "NOT_CONFIGURED") return;
    if (c.rail.status === "FAILED" && (!opts.retryFailed || c.reason === "RAIL_BENEFICIARY_DRIFT")) return;

    const fail = (reason: "RAIL_RELEASE_FAILED" | "RAIL_BENEFICIARY_DRIFT", payload: Record<string, unknown>, error: string) =>
      recordRail(paymentId, { rail: { status: "FAILED" }, reason }, { event: "RAIL_ERROR", payload: { reason, ...payload } },
        { type: "rail", paymentId, status: "FAILED", error, ts: iso() });

    if (rail.readBeneficiary) {
      let actual;
      try {
        actual = await rail.readBeneficiary(c.payment);
      } catch (err) {
        return fail("RAIL_RELEASE_FAILED", { error: `beneficiary re-read failed: ${errorMessage(err)}` }, errorMessage(err));
      }
      const verified = c.payment.beneficiary;
      const drifted = actual.accountLast4 !== verified.accountLast4 ||
        Boolean(actual.accountFingerprint && verified.accountFingerprint && actual.accountFingerprint !== verified.accountFingerprint);
      if (drifted) {
        return fail("RAIL_BENEFICIARY_DRIFT", { verifiedLast4: verified.accountLast4, railLast4: actual.accountLast4 }, "beneficiary changed at the rail after verification");
      }
    }

    let released;
    try {
      released = await rail.release(c.payment, { idempotencyKey: `${settings.railIdempotencyPrefix}-${paymentId}` });
    } catch (err) {
      return fail("RAIL_RELEASE_FAILED", { error: errorMessage(err) }, errorMessage(err));
    }
    await recordRail(paymentId, { rail: { status: "RELEASED", reference: released.reference }, reason: "RAIL_RELEASED" },
      { event: "RAIL_RELEASED", payload: { reference: released.reference, status: released.status } },
      { type: "rail", paymentId, status: "RELEASED", reference: released.reference, ts: iso() });
  }

  /** Recomputes the global chain, optionally only up to and including `throughSeq`. */
  async function checkChain(throughSeq?: number) {
    // Adapters return the exact hashed payloadJson; re-serializing is only a fallback for adapters that do not.
    const entries = (await storage.ledger()) as Array<LedgerEntry & { payloadJson?: string }>;
    const scoped = throughSeq === undefined ? entries : entries.filter((e) => e.seq <= throughSeq);
    return verifyEntries(scoped.map((e) => ({ ...e, payloadJson: e.payloadJson ?? JSON.stringify(e.payload ?? null) })));
  }

  // ── lazy stepping ──

  /** One idempotent step: lease + investigate, expiry, start retries, poll, pending settlement. */
  async function step(paymentId: string): Promise<CaseRecord> {
    let c = await mustLoad({ paymentId });
    const leaseExpired = c.state === "INVESTIGATING" && (!c.stepLeaseUntil || now().getTime() >= Date.parse(c.stepLeaseUntil));
    // A challenge opened in this step is not progressed again until the next step, so each step makes at most one start() attempt.
    if (c.state === "PENDING_REVIEW" || leaseExpired) c = await investigate(c);
    else if (c.state === "CHALLENGING") c = await progressChallenge(c);
    if (c.state === "CLEARED" && c.rail.status === "NOT_SENT") {
      await settle(paymentId, { retryFailed: false });
      c = await mustLoad({ paymentId });
    }
    return c;
  }

  async function waitFor(paymentId: string, c: CaseRecord, waitMs: number | undefined, sinceVersion: number | undefined): Promise<CaseRecord> {
    const deadline = Date.now() + Math.min(Math.max(waitMs ?? 0, 0), MAX_WAIT_MS);
    while (decisionFor(c) === "WAIT" && (sinceVersion === undefined || c.version <= sinceVersion) && Date.now() < deadline) {
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
      c = await step(paymentId);
    }
    return c;
  }

  // ── public surface ──

  const engine: Engine = {
    async verify(raw, opts = {}) {
      const input = validatePaymentInput(raw);
      const principal = principalFor(opts.principal);
      const key = opts.idempotencyKey === undefined ? input.id : validateIdempotencyKey(opts.idempotencyKey);
      return inContext({ payment: input }, async () => {
        const stored = await storedPaymentFor(input);
        const fingerprint = await requestFingerprintFor(stored);

        let c = await casLoop(async () => {
          const byKey = await storage.load({ idempotencyKey: key });
          const existing = byKey ?? (await storage.load({ paymentId: input.id }));
          if (!existing) return createCase(input, stored, key, fingerprint, principal);
          const detail = { paymentId: input.id, requestedBy: principal.id, claimedLast4: input.beneficiary.accountLast4 };
          if (existing.idempotencyKey !== key || existing.paymentId !== input.id) return conflict(existing, { ...detail, cause: "KEY_MISMATCH" });
          if (!(await sameRequest(existing, fingerprint))) return conflict(existing, { ...detail, cause: "REQUEST_CHANGED" });
          if (existing.requestedBy !== principal.id && !isOperator(principal)) return conflict(existing, { ...detail, cause: "PRINCIPAL_MISMATCH" });
          return existing;
        });

        if (c.state === "CLEARED") {
          await settle(c.paymentId, { retryFailed: true });
          c = await mustLoad({ paymentId: c.paymentId });
        }
        return view(await waitFor(c.paymentId, c, opts.waitMs, undefined));
      });
    },

    async get(rawId, opts = {}) {
      const paymentId = validatePaymentId(rawId);
      const principal = principalFor(opts.principal);
      return inContext({ paymentId }, async () => {
        assertCanRead(principal, await mustLoad({ paymentId }));
        const c = await step(paymentId);
        return view(await waitFor(paymentId, c, opts.waitMs, opts.sinceVersion));
      });
    },

    async block(rawId, opts) {
      const paymentId = validatePaymentId(rawId);
      const note = validateBlockReason(opts?.reason);
      const principal = principalFor(opts.principal);
      return inContext({ paymentId }, async () => {
        const c = await casLoop(async () => {
          let cur = await mustLoad({ paymentId });
          if (expired(cur)) cur = await expire(cur);
          if (isTerminal(cur.state)) return cur;
          const ch = cur.challenge;
          const blocked = await commit(cur, {
            ...cur,
            state: transition(cur.state, "BLOCK"),
            reason: "BLOCKED_BY_PRINCIPAL",
            stepLeaseUntil: undefined,
            ...(ch ? { challenge: { ...ch, status: "RESOLVED" as const, verdict: "DENIED" as const, resolvedBy: principal.id, resolvedAt: iso() } } : {}),
          }, [
            { event: "CALL_RESULT", payload: { challengeId: ch?.challengeId ?? null, verdict: "DENIED", tool: null, requestedBy: cur.requestedBy, resolvedBy: principal.id, reason: "BLOCKED_BY_PRINCIPAL", note } },
            { event: "FROZEN", payload: { verdict: "DENIED", reason: "BLOCKED_BY_PRINCIPAL", amountCents: cur.payment.amountCents } },
          ]);
          if (ch) await cancelChallenge(blocked);
          return blocked;
        });
        // The block stands, but a non-owner learns no more than from a missing case (§4.5 rule 5).
        assertCanRead(principal, c);
        return view(c);
      });
    },

    async receipt(rawId, opts = {}) {
      const paymentId = validatePaymentId(rawId);
      const principal = principalFor(opts.principal);
      return inContext({ paymentId }, async () => {
        assertCanRead(principal, await mustLoad({ paymentId }));
        const c = await step(paymentId);
        const entries = (await storage.ledger({ paymentId })).map(({ seq, paymentId: id, event, payload, prevHash, entryHash, ts }) =>
          ({ seq, paymentId: id, event, payload, prevHash, entryHash, ts }));
        const chain = await checkChain(entries.at(-1)?.seq ?? 0);
        return {
          incidentId: `INC-${paymentId.toUpperCase()}`,
          generatedAt: iso(),
          verification: await view(c),
          vendor: c.vendorSnapshot,
          entries,
          headHash: entries.at(-1)?.entryHash ?? null,
          // Scoped to this payment: the chain prefix its entries hang from, and its own entry count.
          chain: { ...chain, length: entries.length },
        };
      });
    },

    async advance(rawId) {
      const paymentId = validatePaymentId(rawId);
      return inContext({ paymentId }, async () => view(await step(paymentId)));
    },

    async retryRelease(rawId) {
      const paymentId = validatePaymentId(rawId);
      return inContext({ paymentId }, async () => {
        await settle(paymentId, { retryFailed: true });
        return view(await mustLoad({ paymentId }));
      });
    },

    async sweep(opts = {}) {
      const open = await storage.list({ states: ["PENDING_REVIEW", "INVESTIGATING", "CHALLENGING"], limit: opts.limit });
      let advanced = 0;
      let expiredCount = 0;
      for (const before of open) {
        try {
          const after = await step(before.paymentId);
          if (after.state === "QUARANTINED" && after.reason === "CHALLENGE_EXPIRED") expiredCount++;
          else if (after.version !== before.version) advanced++;
        } catch {
          // One failing case must not stop the sweep; it stays held and is retried next time.
        }
      }
      return { advanced, expired: expiredCount };
    },

    async resolveChallenge(raw) {
      const input = validateResolveInput(raw);
      if (input.verdict === "AUTHORIZED" && !input.responderToken) {
        throw new EngineError("RESPONDER_TOKEN_REQUIRED", "AUTHORIZED requires the responder token");
      }
      const c = await casLoop(() => resolveOnce(input, "ingress"));
      if (c.state === "CLEARED") await settle(c.paymentId, { retryFailed: false });
      return view(await mustLoad({ paymentId: c.paymentId }));
    },

    verifyLedger() {
      return checkChain();
    },

    withPrincipal(p) {
      return buildEngine(settings, p);
    },
  };

  return engine;
}
