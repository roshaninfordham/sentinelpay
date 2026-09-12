import Database from "better-sqlite3";
import path from "node:path";

// Server-only. Never import from a client component.

const DB_PATH = process.env.SENTINEL_DB_PATH ?? path.join(process.cwd(), "sentinel.db");

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
  memo TEXT
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

const globalForDb = globalThis as unknown as { __sentinelDb?: Database.Database };

export function getDb(): Database.Database {
  if (!globalForDb.__sentinelDb) {
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    migrate(db);
    globalForDb.__sentinelDb = db;
  }
  return globalForDb.__sentinelDb;
}

// Additive column migrations for databases created by earlier versions.
function migrate(db: Database.Database): void {
  const cols = new Set((db.prepare(`PRAGMA table_info(payments)`).all() as { name: string }[]).map((c) => c.name));
  for (const col of ["railCounterpartyId", "railReference"]) {
    if (!cols.has(col)) db.exec(`ALTER TABLE payments ADD COLUMN ${col} TEXT`);
  }
}
