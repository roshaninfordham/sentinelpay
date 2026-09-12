import type { Payment, Vendor } from "./types";
import { getDb } from "./db";

// The one scenario the whole demo hangs on (CLAUDE.md §Seed data),
// plus a clean control payment that the gate releases untouched.

export const VENDORS: Vendor[] = [
  {
    id: "v_meridian",
    legalName: "Meridian Global Logistics LLC",
    knownDomain: "meridianglobal.com",      // real registry history (RDAP: registered 1999)
    knownBankLast4: "4471",
    registryUrl: "https://opencorporates.com/companies?q=Meridian+Global+Logistics",
  },
  {
    id: "v_northwind",
    legalName: "Northwind Freight Partners Inc.",
    knownDomain: "northwindfreight.com",
    knownBankLast4: "2208",
    registryUrl: "https://opencorporates.com/companies?q=Northwind+Freight+Partners",
  },
];

export function seedPayments(now = Date.now()): Payment[] {
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  return [
    {
      id: "pay_240k",
      vendorId: "v_meridian",
      amountCents: 24000000,                     // $240,000.00
      currency: "USD",
      claimedBankLast4: "9821",                  // CHANGED → triggers the gate
      requestSourceDomain: "meridian-global.co", // lookalike of meridianglobal.com
      invoiceContactPhone: "+1-000-000-0000",    // attacker's footer number — never trusted
      status: "RECEIVED",
      createdAt: iso(14),
      memo: "INV-88412 · Q3 ocean freight · \"URGENT: updated remittance details\"",
    },
    {
      id: "pay_18k",
      vendorId: "v_northwind",
      amountCents: 1845000,                      // $18,450.00
      currency: "USD",
      claimedBankLast4: "2208",                  // matches vendor master
      requestSourceDomain: "northwindfreight.com",
      invoiceContactPhone: "+1-206-555-0143",
      status: "RECEIVED",
      createdAt: iso(41),
      memo: "INV-20931 · drayage, Port of Seattle",
    },
  ];
}

/** Wipes all state and writes the demo scenario. Used by `pnpm seed` and the reset button. */
export function reseed(): void {
  const db = getDb();
  const insertVendor = db.prepare(
    `INSERT INTO vendors (id, legalName, knownDomain, knownBankLast4, verifiedPhone, registryUrl)
     VALUES (@id, @legalName, @knownDomain, @knownBankLast4, @verifiedPhone, @registryUrl)`,
  );
  const insertPayment = db.prepare(
    `INSERT INTO payments (id, vendorId, amountCents, currency, claimedBankLast4, requestSourceDomain,
                           invoiceContactPhone, status, createdAt, memo)
     VALUES (@id, @vendorId, @amountCents, @currency, @claimedBankLast4, @requestSourceDomain,
             @invoiceContactPhone, @status, @createdAt, @memo)`,
  );
  db.transaction(() => {
    for (const t of ["timeline", "assessments", "calls", "ledger", "payments", "vendors"]) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.exec(`DELETE FROM sqlite_sequence WHERE name = 'timeline'`);
    for (const v of VENDORS) insertVendor.run({ verifiedPhone: null, registryUrl: null, ...v });
    for (const p of seedPayments()) insertPayment.run({ invoiceContactPhone: null, memo: null, ...p });
  })();
}
