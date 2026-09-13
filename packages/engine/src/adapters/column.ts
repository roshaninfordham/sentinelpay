import { fingerprintAccount } from "../core/hash";
import { ConfigError, type Rail, type StoredPayment } from "../core/types";

// Column (column.com) SANDBOX rail. Auth is HTTP Basic with an empty username and the API key as password;
// bodies are form-encoded, matching Column's documented curl examples.
// The beneficiary is read from the counterparty the wire would pay, so the gate compares the vendor master
// against the rail's own record, and release pays exactly that counterparty. Only the host picks the counterparty:
// a payment's railCounterpartyId can agree with the host mapping but never choose or override it.

export const COLUMN_BASE = "https://api.column.com";
const TIMEOUT_MS = 10_000;

export interface ColumnRailOptions {
  apiKey: `test_${string}`;
  bankAccountId: string;
  /** Counterparty id keyed by payment id. Checked first. */
  counterparties: Record<string, string>;
  /** Counterparty id of each vendor's account on file, used for payments with no entry in `counterparties`. */
  vendorCounterparties?: Record<string, string>;
  /**
   * The engine's secrets.fingerprintKey. When set, readBeneficiary also returns HMAC(routing|account) of the
   * counterparty, so a vendor's knownAccountFingerprint catches an account that only shares the last 4 digits.
   */
  fingerprintKey?: string;
  fetch?: typeof fetch;
}

export function columnRail(opts: ColumnRailOptions): Rail {
  // This package must never move real money: only sandbox keys are accepted.
  if (typeof opts.apiKey !== "string" || !opts.apiKey.startsWith("test_")) {
    throw new ConfigError("columnRail requires a Column sandbox key (prefix test_); live keys are refused");
  }
  if (!opts.bankAccountId) throw new ConfigError("columnRail requires bankAccountId");
  const authorization = `Basic ${btoa(`:${opts.apiKey}`)}`;

  async function request<T>(method: "GET" | "POST", path: string, body?: Record<string, string | number>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: authorization };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const doFetch = opts.fetch ?? globalThis.fetch;
    const res = await doFetch(`${COLUMN_BASE}${path}`, {
      method,
      headers,
      body: body ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string; code?: string };
    if (!res.ok) throw new Error(`Column ${method} ${path} -> ${res.status} ${json.message ?? json.code ?? ""}`.trim());
    return json;
  }

  const own = (map: Record<string, string> | undefined, key: string) => (map && Object.hasOwn(map, key) ? map[key] : undefined);

  const counterpartyFor = (p: StoredPayment) => {
    const id = own(opts.counterparties, p.id) ?? own(opts.vendorCounterparties, p.vendorId);
    if (!id) throw new Error(`no Column counterparty mapped for ${p.id}`);
    // The engine turns this throw into BENEFICIARY_CHANGED at the gate and a failed release at settlement.
    const claimed = p.beneficiary.railCounterpartyId;
    if (claimed !== undefined && claimed !== id) throw new Error(`railCounterpartyId for ${p.id} does not match the mapped Column counterparty`);
    return id;
  };

  return {
    id: "column-sandbox",
    environment: "sandbox",

    async readBeneficiary(p) {
      const cp = await request<{ account_number?: string; routing_number?: string }>("GET", `/counterparties/${encodeURIComponent(counterpartyFor(p))}`);
      if (typeof cp.account_number !== "string" || !/^\d{4,}$/.test(cp.account_number)) {
        throw new Error("Column counterparty has no readable account number");
      }
      const accountLast4 = cp.account_number.slice(-4);
      if (!opts.fingerprintKey) return { accountLast4 };
      const routing = typeof cp.routing_number === "string" ? cp.routing_number : "";
      return { accountLast4, accountFingerprint: await fingerprintAccount(opts.fingerprintKey, routing, cp.account_number) };
    },

    async release(p, { idempotencyKey }) {
      const wire = await request<{ id?: string; status?: string }>("POST", "/transfers/wire", {
        currency_code: "USD",
        bank_account_id: opts.bankAccountId,
        counterparty_id: counterpartyFor(p),
        amount: p.amountCents,
        description: (p.memo ?? `PayFirewall ${p.id}`).slice(0, 140),
      }, idempotencyKey);
      // Never report a reference the rail did not return.
      if (!wire.id) throw new Error("Column wire response has no id");
      return { reference: wire.id, status: wire.status ?? "unknown" };
    },
  };
}
