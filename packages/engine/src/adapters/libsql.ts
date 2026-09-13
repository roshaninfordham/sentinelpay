import type { Client, InArgs, ResultSet, Transaction } from "@libsql/client";
import { GENESIS, hashEntry } from "../core/hash";
import {
  EngineError,
  type CaseRecord, type LedgerEvent, type Storage, type StorageKey, type StoredLedgerEntry, type Vendor, type VendorDirectory,
} from "../core/types";

// libSQL Storage. The ledger table and hash format are the app's existing chain, so old rows keep verifying.
// Every commit runs through one in-process queue: a libSQL client cannot hold two write transactions at once
// (an in-memory database has a single connection; a file database gives SQLITE_BUSY). The CAS itself is SQL.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  paymentId TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  idempotencyKey TEXT NOT NULL UNIQUE,
  challengeId TEXT UNIQUE,
  state TEXT NOT NULL,
  vendorId TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_state ON cases (state);
CREATE INDEX IF NOT EXISTS cases_vendor ON cases (vendorId);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  paymentId TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prevHash TEXT NOT NULL,
  entryHash TEXT NOT NULL,
  ts TEXT NOT NULL
);
`;

interface LedgerRow { seq: number; paymentId: string; event: string; payload_json: string; prevHash: string; entryHash: string; ts: string }

export interface LibsqlStorageOptions {
  /** Runs inside the commit transaction, after the case and ledger writes. A throw rolls the whole commit back. */
  onCommit?(tx: Transaction, next: CaseRecord): Promise<void>;
  now?: () => Date;
}

function rowsOf<T>(rs: ResultSet): T[] {
  return rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])) as T);
}

const isConstraintError = (err: unknown) => {
  const e = err as { code?: unknown; message?: unknown };
  return (typeof e?.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) ||
    (typeof e?.message === "string" && /constraint failed/i.test(e.message));
};

/** Runs one of the adapter's own statements; uniqueness violations are CAS conflicts by contract. */
async function exec(on: Client | Transaction, sql: string, args: InArgs = []): Promise<ResultSet> {
  try {
    return await on.execute({ sql, args });
  } catch (err) {
    if (isConstraintError(err)) throw new EngineError("VERSION_CONFLICT", "uniqueness violation (paymentId, idempotencyKey or challengeId)");
    throw err;
  }
}

const toEntry = (r: LedgerRow): StoredLedgerEntry => ({
  seq: Number(r.seq),
  paymentId: r.paymentId,
  event: r.event as LedgerEvent,
  payload: JSON.parse(r.payload_json),
  payloadJson: r.payload_json,
  prevHash: r.prevHash,
  entryHash: r.entryHash,
  ts: r.ts,
});

export function libsqlStorage(client: Client, opts: LibsqlStorageOptions = {}): Storage & { migrate(): Promise<void> } {
  const now = opts.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();

  async function applyCommit(next: CaseRecord, expectedVersion: number, events: Array<{ event: LedgerEvent; payload: unknown }>) {
    if (next.version !== expectedVersion + 1) throw new EngineError("VERSION_CONFLICT", `next version must be ${expectedVersion + 1}`);
    const tx = await client.transaction("write");
    try {
      const columns = [next.version, next.idempotencyKey, next.challenge?.challengeId ?? null, next.state, next.payment.vendorId, JSON.stringify(next)];
      if (expectedVersion === 0) {
        await exec(tx, `INSERT INTO cases (version, idempotencyKey, challengeId, state, vendorId, json, paymentId) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [...columns, next.paymentId]);
      } else {
        const rs = await exec(tx, `UPDATE cases SET version = ?, idempotencyKey = ?, challengeId = ?, state = ?, vendorId = ?, json = ? WHERE paymentId = ? AND version = ?`,
          [...columns, next.paymentId, expectedVersion]);
        if (rs.rowsAffected !== 1) throw new EngineError("VERSION_CONFLICT", `case ${next.paymentId} is not at version ${expectedVersion}`);
      }

      const [tail] = rowsOf<{ seq: number; entryHash: string }>(await exec(tx, `SELECT seq, entryHash FROM ledger ORDER BY seq DESC LIMIT 1`));
      let seq = Number(tail?.seq ?? 0);
      let prevHash = tail?.entryHash ?? GENESIS;
      const appended: StoredLedgerEntry[] = [];
      for (const { event, payload } of events) {
        seq += 1;
        const payloadJson = JSON.stringify(payload ?? null);
        const row: LedgerRow = {
          seq, paymentId: next.paymentId, event, payload_json: payloadJson, prevHash,
          entryHash: await hashEntry(seq, next.paymentId, event, payloadJson, prevHash), ts: now().toISOString(),
        };
        await exec(tx, `INSERT INTO ledger (seq, paymentId, event, payload_json, prevHash, entryHash, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [row.seq, row.paymentId, row.event, row.payload_json, row.prevHash, row.entryHash, row.ts]);
        appended.push(toEntry(row));
        prevHash = row.entryHash;
      }

      if (opts.onCommit) await opts.onCommit(tx, structuredClone(next));
      await tx.commit();
      return appended;
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    } finally {
      tx.close();
    }
  }

  return {
    async migrate() {
      await client.executeMultiple(SCHEMA);
    },

    async load(key: StorageKey) {
      const [column, value] = "paymentId" in key ? ["paymentId", key.paymentId]
        : "challengeId" in key ? ["challengeId", key.challengeId]
        : ["idempotencyKey", key.idempotencyKey];
      const [row] = rowsOf<{ json: string }>(await exec(client, `SELECT json FROM cases WHERE ${column} = ?`, [value]));
      return row ? (JSON.parse(row.json) as CaseRecord) : null;
    },

    commit(next, expectedVersion, events) {
      const run = queue.then(() => applyCommit(next, expectedVersion, events));
      queue = run.catch(() => undefined);
      return run;
    },

    async ledger(filter = {}) {
      const rs = filter.paymentId
        ? await exec(client, `SELECT * FROM ledger WHERE paymentId = ? ORDER BY seq`, [filter.paymentId])
        : await exec(client, `SELECT * FROM ledger ORDER BY seq`);
      return rowsOf<LedgerRow>(rs).map(toEntry);
    },

    async list(filter) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (filter.states) {
        if (filter.states.length === 0) return [];
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        args.push(...filter.states);
      }
      if (filter.vendorId) {
        where.push(`vendorId = ?`);
        args.push(filter.vendorId);
      }
      if (filter.staleBefore) {
        where.push(`json_extract(json, '$.updatedAt') < ?`);
        args.push(filter.staleBefore);
      }
      let sql = `SELECT json FROM cases${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
      if (filter.limit !== undefined) {
        sql += ` LIMIT ?`;
        args.push(filter.limit);
      }
      return rowsOf<{ json: string }>(await exec(client, sql, args)).map((r) => JSON.parse(r.json) as CaseRecord);
    },
  };
}

interface VendorRow {
  id: string; legalName: string; knownDomain: string; knownBankLast4: string;
  verifiedPhone?: string | null; knownAccountFingerprint?: string | null; verifiedPhoneProvenance?: string | null;
}

/** Read-only view over a host-owned `vendors` table. Optional columns are used when the table has them. */
export function libsqlVendors(client: Client): VendorDirectory {
  return {
    async get(vendorId) {
      const [r] = rowsOf<VendorRow>(await client.execute({ sql: `SELECT * FROM vendors WHERE id = ?`, args: [vendorId] }));
      if (!r) return null;
      const vendor: Vendor = { id: r.id, legalName: r.legalName, knownDomain: r.knownDomain, knownBankLast4: r.knownBankLast4 };
      if (r.knownAccountFingerprint) vendor.knownAccountFingerprint = r.knownAccountFingerprint;
      if (r.verifiedPhone) vendor.verifiedPhone = r.verifiedPhone;
      if (r.verifiedPhoneProvenance === "vendor_master" || r.verifiedPhoneProvenance === "registry") {
        vendor.verifiedPhoneProvenance = r.verifiedPhoneProvenance;
      }
      return vendor;
    },
  };
}
