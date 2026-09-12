import { all, one, run } from "../db";
import type { Payment, PaymentSource, PaymentStatus, Vendor, VendorDirectory } from "../types";

type Nullable<T> = { [K in keyof T]: T[K] | null };

// SQLite returns NULL for absent optional columns; the contracts use `undefined`.
function stripNulls<T extends object>(row: Nullable<T>): T {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)) as T;
}

const toPayment = (r: Nullable<Payment>): Payment => {
  const p = stripNulls<Payment>(r);
  return { ...p, amountCents: Number(p.amountCents) };
};

export class MockPaymentSource implements PaymentSource {
  async listPending(): Promise<Payment[]> {
    return (await this.listAll()).filter((p) => p.status !== "CLEARED" && p.status !== "QUARANTINED");
  }

  async listAll(): Promise<Payment[]> {
    return (await all<Nullable<Payment>>(`SELECT * FROM payments ORDER BY createdAt DESC`)).map(toPayment);
  }

  async get(id: string): Promise<Payment> {
    const row = await one<Nullable<Payment>>(`SELECT * FROM payments WHERE id = ?`, [id]);
    if (!row) throw new Error(`payment ${id} not found`);
    return toPayment(row);
  }

  async setStatus(id: string, status: PaymentStatus): Promise<void> {
    await run(`UPDATE payments SET status = ? WHERE id = ?`, [status, id]);
  }

  /** Webhook ingest: insert or replace the disbursement as it arrived. */
  async upsert(p: Payment): Promise<void> {
    await run(
      `INSERT OR REPLACE INTO payments (id, vendorId, amountCents, currency, claimedBankLast4, requestSourceDomain,
                                        invoiceContactPhone, status, createdAt, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.vendorId, p.amountCents, p.currency, p.claimedBankLast4, p.requestSourceDomain, p.invoiceContactPhone ?? null, p.status, p.createdAt, p.memo ?? null],
    );
  }
}

export class MockVendorDirectory implements VendorDirectory {
  async get(vendorId: string): Promise<Vendor> {
    const row = await one<Nullable<Vendor>>(`SELECT * FROM vendors WHERE id = ?`, [vendorId]);
    if (!row) throw new Error(`vendor ${vendorId} not found`);
    return stripNulls<Vendor>(row);
  }

  async listAll(): Promise<Vendor[]> {
    return (await all<Nullable<Vendor>>(`SELECT * FROM vendors`)).map((r) => stripNulls<Vendor>(r));
  }
}
