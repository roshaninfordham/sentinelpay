import { ConfigError, type Rail, type StoredPayment } from "../core/types";

// Column (column.com) SANDBOX rail. Auth is HTTP Basic with an empty username and the API key as password;
// bodies are form-encoded, matching Column's documented curl examples.
// The beneficiary is read from the counterparty the wire would pay, so the gate compares the vendor master
// against the rail's own record, and release pays exactly that counterparty.

export const COLUMN_BASE = "https://api.column.com";
const TIMEOUT_MS = 10_000;

export interface ColumnRailOptions {
  apiKey: `test_${string}`;
  bankAccountId: string;
  /** Counterparty id keyed by payment id; a payment's own railCounterpartyId takes precedence. */
  counterparties: Record<string, string>;
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

  const counterpartyFor = (p: StoredPayment) => {
    const id = p.beneficiary.railCounterpartyId ?? opts.counterparties[p.id];
    if (!id) throw new Error(`no Column counterparty mapped for ${p.id}`);
    return id;
  };

  return {
    id: "column-sandbox",
    environment: "sandbox",

    async readBeneficiary(p) {
      const cp = await request<{ account_number?: string }>("GET", `/counterparties/${encodeURIComponent(counterpartyFor(p))}`);
      if (typeof cp.account_number !== "string" || !/^\d{4,}$/.test(cp.account_number)) {
        throw new Error("Column counterparty has no readable account number");
      }
      return { accountLast4: cp.account_number.slice(-4) };
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
