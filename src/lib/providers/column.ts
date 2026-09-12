import { getDb } from "../db";
import { appendLedger } from "../ledger";
import { emit } from "../timeline";
import type { Payment, PaymentStatus } from "../types";
import { ColumnClient } from "./column-client";
import type { ColumnSandboxConfig } from "./column-config";
import { MockPaymentSource } from "./mock";

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * PaymentSource backed by the Column sandbox rail.
 *
 * - The AP queue (amount, memo, request domain) stays in SQLite: that is the ERP/AP side.
 * - The beneficiary is read live from the Column counterparty the wire would pay, so the gate
 *   compares the vendor master against the rail's own record, not a copy.
 * - Enforcement is real on the sandbox: a CLEARED payment creates a Column wire; a QUARANTINED
 *   payment never creates one, so no funds leave the account.
 */
export class ColumnPaymentSource extends MockPaymentSource {
  constructor(private readonly client: ColumnClient, private readonly config: ColumnSandboxConfig) {
    super();
  }

  async get(id: string): Promise<Payment> {
    const payment = await super.get(id);
    const counterpartyId = payment.railCounterpartyId ?? this.config.paymentCounterparties[id];
    if (!counterpartyId || payment.status !== "RECEIVED") return payment;

    const cp = await this.client.getCounterparty(counterpartyId);
    const last4 = cp.account_number.slice(-4);
    if (last4 !== payment.claimedBankLast4 || payment.railCounterpartyId !== counterpartyId) {
      getDb()
        .prepare(`UPDATE payments SET claimedBankLast4 = ?, railCounterpartyId = ? WHERE id = ?`)
        .run(last4, counterpartyId, id);
    }
    return { ...payment, claimedBankLast4: last4, railCounterpartyId: counterpartyId };
  }

  async setStatus(id: string, status: PaymentStatus): Promise<void> {
    await super.setStatus(id, status);
    if (status === "CLEARED") await this.release(id);
    if (status === "QUARANTINED") {
      emit(id, "ok", `■ Column sandbox: no wire created, funds remain in account ${this.config.bankAccountId}`);
    }
  }

  private async release(id: string): Promise<void> {
    const payment = await super.get(id);
    if (payment.railReference) return;
    const counterpartyId = payment.railCounterpartyId ?? this.config.paymentCounterparties[id];
    if (!counterpartyId) {
      emit(id, "warn", `Column sandbox: no counterparty mapped for ${id}; release recorded locally only`);
      return;
    }
    try {
      const wire = await this.client.createWire(
        {
          bank_account_id: this.config.bankAccountId,
          counterparty_id: counterpartyId,
          amount: payment.amountCents,
          description: (payment.memo ?? `SentinelPay ${id}`).slice(0, 140),
        },
        `sentinelpay-${id}`,
      );
      getDb().prepare(`UPDATE payments SET railReference = ? WHERE id = ?`).run(wire.id, id);
      appendLedger("RAIL_RELEASED", id, { rail: "column-sandbox", wireId: wire.id, status: wire.status, amountCents: wire.amount });
      emit(id, "ok", `✔ Column sandbox wire ${wire.id} created for ${usd(payment.amountCents)} (status ${wire.status})`);
    } catch (err) {
      appendLedger("RAIL_ERROR", id, { rail: "column-sandbox", error: (err as Error).message });
      emit(id, "alert", `✖ Column sandbox release failed: ${(err as Error).message}`);
    }
  }
}
