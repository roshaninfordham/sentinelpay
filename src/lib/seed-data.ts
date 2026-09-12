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
export async function reseed(): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      ...["timeline", "assessments", "calls", "ledger", "payments", "vendors"].map((t) => `DELETE FROM ${t}`),
      `DELETE FROM sqlite_sequence WHERE name = 'timeline'`,
      ...VENDORS.map((v) => ({
        sql: `INSERT INTO vendors (id, legalName, knownDomain, knownBankLast4, verifiedPhone, registryUrl) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [v.id, v.legalName, v.knownDomain, v.knownBankLast4, v.verifiedPhone ?? null, v.registryUrl ?? null],
      })),
      ...seedPayments().map((p) => ({
        sql: `INSERT INTO payments (id, vendorId, amountCents, currency, claimedBankLast4, requestSourceDomain,
                                   invoiceContactPhone, status, createdAt, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [p.id, p.vendorId, p.amountCents, p.currency, p.claimedBankLast4, p.requestSourceDomain, p.invoiceContactPhone ?? null, p.status, p.createdAt, p.memo ?? null],
      })),
    ],
    "write",
  );
}
