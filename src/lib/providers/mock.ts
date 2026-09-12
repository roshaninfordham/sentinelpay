import { getDb } from "../db";
import type { Payment, PaymentSource, PaymentStatus, Vendor, VendorDirectory } from "../types";

type Nullable<T> = { [K in keyof T]: T[K] | null };

// SQLite returns NULL for absent optional columns; the contracts use `undefined`.
function stripNulls<T extends object>(row: Nullable<T>): T {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)) as T;
}

export class MockPaymentSource implements PaymentSource {
  async listPending(): Promise<Payment[]> {
    return this.listAll().filter((p) => p.status !== "CLEARED" && p.status !== "QUARANTINED");
  }

  listAll(): Payment[] {
    const rows = getDb().prepare(`SELECT * FROM payments ORDER BY createdAt DESC`).all() as Nullable<Payment>[];
    return rows.map((r) => stripNulls<Payment>(r));
  }

  async get(id: string): Promise<Payment> {
    const row = getDb().prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as Nullable<Payment> | undefined;
    if (!row) throw new Error(`payment ${id} not found`);
    return stripNulls<Payment>(row);
  }

  async setStatus(id: string, status: PaymentStatus): Promise<void> {
    getDb().prepare(`UPDATE payments SET status = ? WHERE id = ?`).run(status, id);
  }

  /** Webhook ingest: insert or replace the disbursement as it arrived. */
  upsert(p: Payment): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO payments (id, vendorId, amountCents, currency, claimedBankLast4, requestSourceDomain,
                                          invoiceContactPhone, status, createdAt, memo)
         VALUES (@id, @vendorId, @amountCents, @currency, @claimedBankLast4, @requestSourceDomain,
                 @invoiceContactPhone, @status, @createdAt, @memo)`,
      )
      .run({ invoiceContactPhone: null, memo: null, ...p });
  }
}

export class MockVendorDirectory implements VendorDirectory {
  async get(vendorId: string): Promise<Vendor> {
    const row = getDb().prepare(`SELECT * FROM vendors WHERE id = ?`).get(vendorId) as Nullable<Vendor> | undefined;
    if (!row) throw new Error(`vendor ${vendorId} not found`);
    return stripNulls<Vendor>(row);
  }

  listAll(): Vendor[] {
    return (getDb().prepare(`SELECT * FROM vendors`).all() as Nullable<Vendor>[]).map((r) => stripNulls<Vendor>(r));
  }
}
