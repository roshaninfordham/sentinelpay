import { GENESIS, hashEntry } from "../core/hash";
import {
  EngineError,
  type CaseRecord, type LedgerEntry, type LedgerEvent, type Storage, type StorageKey, type StoredLedgerEntry, type Vendor, type VendorDirectory,
} from "../core/types";

// In-process Storage. Every commit runs through one promise queue, so the CAS check, the async
// hash computation and the write of both case and ledger happen as one indivisible step.

export function memoryStorage(opts: { now?: () => Date } = {}): Storage {
  const now = opts.now ?? (() => new Date());
  const cases = new Map<string, CaseRecord>();
  const byIdempotencyKey = new Map<string, string>();
  const byChallengeId = new Map<string, string>();
  const chain: StoredLedgerEntry[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  const clone = <T>(v: T): T => structuredClone(v);
  const conflict = (msg: string) => new EngineError("VERSION_CONFLICT", msg);

  async function applyCommit(next: CaseRecord, expectedVersion: number, events: Array<{ event: LedgerEvent; payload: unknown }>) {
    const current = cases.get(next.paymentId);
    if (expectedVersion === 0 ? current : current?.version !== expectedVersion) {
      throw conflict(`case ${next.paymentId} is not at version ${expectedVersion}`);
    }
    if (next.version !== expectedVersion + 1) throw conflict(`next version must be ${expectedVersion + 1}`);
    const keyOwner = byIdempotencyKey.get(next.idempotencyKey);
    if (keyOwner && keyOwner !== next.paymentId) throw conflict(`idempotency key already used by another case`);
    const challengeId = next.challenge?.challengeId;
    const challengeOwner = challengeId ? byChallengeId.get(challengeId) : undefined;
    if (challengeOwner && challengeOwner !== next.paymentId) throw conflict(`challenge id already used by another case`);

    // Compute the whole append before mutating anything, so a failure leaves no trace.
    const appended: StoredLedgerEntry[] = [];
    let prev = chain.at(-1);
    for (const { event, payload } of events) {
      const seq = (prev?.seq ?? 0) + 1;
      const prevHash = prev?.entryHash ?? GENESIS;
      const payloadJson = JSON.stringify(payload ?? null);
      const entry: StoredLedgerEntry = {
        seq, paymentId: next.paymentId, event, payload: JSON.parse(payloadJson), payloadJson,
        prevHash, entryHash: await hashEntry(seq, next.paymentId, event, payloadJson, prevHash), ts: now().toISOString(),
      };
      appended.push(entry);
      prev = entry;
    }

    const stored = clone(next);
    if (current && current.idempotencyKey !== stored.idempotencyKey) byIdempotencyKey.delete(current.idempotencyKey);
    if (current?.challenge && current.challenge.challengeId !== challengeId) byChallengeId.delete(current.challenge.challengeId);
    cases.set(stored.paymentId, stored);
    byIdempotencyKey.set(stored.idempotencyKey, stored.paymentId);
    if (challengeId) byChallengeId.set(challengeId, stored.paymentId);
    chain.push(...appended);
    return clone(appended);
  }

  return {
    async load(key: StorageKey) {
      const paymentId = "paymentId" in key ? key.paymentId
        : "challengeId" in key ? byChallengeId.get(key.challengeId)
        : byIdempotencyKey.get(key.idempotencyKey);
      const found = paymentId ? cases.get(paymentId) : undefined;
      return found ? clone(found) : null;
    },

    commit(next, expectedVersion, events): Promise<LedgerEntry[]> {
      const run = queue.then(() => applyCommit(next, expectedVersion, events));
      queue = run.catch(() => undefined);
      return run;
    },

    async ledger(opts = {}) {
      return clone(opts.paymentId ? chain.filter((e) => e.paymentId === opts.paymentId) : chain);
    },

    async list(filter) {
      const out: CaseRecord[] = [];
      for (const c of cases.values()) {
        if (filter.states && !filter.states.includes(c.state)) continue;
        if (filter.vendorId && c.payment.vendorId !== filter.vendorId) continue;
        if (filter.staleBefore && !(c.updatedAt < filter.staleBefore)) continue;
        out.push(clone(c));
        if (filter.limit !== undefined && out.length >= filter.limit) break;
      }
      return out;
    },
  };
}

export function memoryVendors(vendors: Vendor[]): VendorDirectory {
  const byId = new Map(vendors.map((v) => [v.id, structuredClone(v)]));
  return {
    async get(vendorId) {
      const v = byId.get(vendorId);
      return v ? structuredClone(v) : null;
    },
  };
}
