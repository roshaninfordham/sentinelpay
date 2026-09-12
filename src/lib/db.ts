import { createClient, type Client, type InArgs, type ResultSet, type Transaction } from "@libsql/client";
import path from "node:path";

// Server-only. Never import from a client component.
//
// One async client for every environment:
//   TURSO_DATABASE_URL set  → hosted Turso (libSQL), shared by all Vercel function instances
//   otherwise               → local SQLite file (offline demo, tests)

function resolveUrl(): { url: string; authToken?: string } {
  if (process.env.TURSO_DATABASE_URL) {
    return { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  if (process.env.VERCEL) {
    // Serverless instances don't share a filesystem, so state would split across requests.
    console.error("[sentinelpay] TURSO_DATABASE_URL is not set on Vercel; using an ephemeral /tmp database.");
    return { url: "file:/tmp/sentinel.db" };
  }
  return { url: `file:${process.env.SENTINEL_DB_PATH ?? path.join(process.cwd(), "sentinel.db")}` };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  legalName TEXT NOT NULL,
  knownDomain TEXT NOT NULL,
  knownBankLast4 TEXT NOT NULL,
  verifiedPhone TEXT,
  registryUrl TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  vendorId TEXT NOT NULL REFERENCES vendors(id),
  amountCents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  claimedBankLast4 TEXT NOT NULL,
  requestSourceDomain TEXT NOT NULL,
  invoiceContactPhone TEXT,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  memo TEXT,
  railCounterpartyId TEXT,
  railReference TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  paymentId TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prevHash TEXT NOT NULL,
  entryHash TEXT NOT NULL,
  ts TEXT NOT NULL
);
-- UI-only event stream for the investigation terminal (not part of the audit chain)
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paymentId TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assessments (
  paymentId TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  paymentId TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
`;

const globalForDb = globalThis as unknown as { __sentinelDb?: Promise<Client> };

async function init(): Promise<Client> {
  const client = createClient(resolveUrl());
  await client.executeMultiple(SCHEMA);
  await migrate(client);
  return client;
}

export function getDb(): Promise<Client> {
  if (!globalForDb.__sentinelDb) {
    globalForDb.__sentinelDb = init().catch((err) => {
      globalForDb.__sentinelDb = undefined; // allow a retry on the next request
      throw err;
    });
  }
  return globalForDb.__sentinelDb;
}

// Additive column migrations for databases created by earlier versions.
async function migrate(client: Client): Promise<void> {
  const cols = new Set(rowsOf<{ name: string }>(await client.execute(`PRAGMA table_info(payments)`)).map((c) => c.name));
  for (const col of ["railCounterpartyId", "railReference"]) {
    if (!cols.has(col)) await client.execute(`ALTER TABLE payments ADD COLUMN ${col} TEXT`);
  }
}

/** libSQL rows are array-like; convert to plain objects keyed by column name. */
export function rowsOf<T>(rs: ResultSet): T[] {
  return rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])) as T);
}

type Executor = Client | Transaction;

export async function all<T>(sql: string, args: InArgs = [], on?: Executor): Promise<T[]> {
  return rowsOf<T>(await (on ?? (await getDb())).execute({ sql, args }));
}

export async function one<T>(sql: string, args: InArgs = [], on?: Executor): Promise<T | undefined> {
  return (await all<T>(sql, args, on))[0];
}

export async function run(sql: string, args: InArgs = [], on?: Executor): Promise<void> {
  await (on ?? (await getDb())).execute({ sql, args });
}

/** Serializable write transaction; commits on success, rolls back on throw. */
export async function writeTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await (await getDb()).transaction("write");
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    tx.close();
  }
}

/** Test helper: drop the cached client so a new SENTINEL_DB_PATH takes effect. */
export function resetDbForTests(): void {
  globalForDb.__sentinelDb = undefined;
}
