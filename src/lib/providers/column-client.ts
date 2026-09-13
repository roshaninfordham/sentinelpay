// Minimal Column (column.com) API client used by `pnpm column:setup` to create sandbox objects.
// Reading beneficiaries and releasing wires is the engine's columnRail adapter.
// Auth is HTTP Basic with an empty username and the API key as password (`curl -u :<key>`).
// Bodies are form-encoded, matching Column's documented curl examples.

export const COLUMN_BASE = "https://api.column.com";

export interface ColumnCounterparty {
  id: string;
  account_number: string;
  routing_number: string;
  name?: string;
  description?: string;
}

export interface ColumnBankAccount {
  id: string;
  default_account_number_id: string;
  default_account_number?: string;
  routing_number?: string;
}

export class ColumnError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class ColumnClient {
  constructor(private readonly apiKey: string, private readonly base = COLUMN_BASE) {
    // Prototype guardrail: this app must never move real money.
    if (!apiKey.startsWith("test_")) {
      throw new ColumnError("COLUMN_API_KEY must be a sandbox key (prefix test_); live keys are refused", 400);
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, string | number | boolean>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`:${this.apiKey}`).toString("base64")}`,
    };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string; code?: string };
    if (!res.ok) throw new ColumnError(`Column ${method} ${path} → ${res.status} ${json.message ?? json.code ?? ""}`.trim(), res.status);
    return json;
  }

  /** Wires need a beneficiary name and address on the counterparty; Column rejects the wire otherwise. */
  createCounterparty(input: {
    routing_number: string;
    account_number: string;
    name: string;
    description?: string;
    address: { line_1: string; city: string; state: string; postal_code: string; country_code: string };
  }) {
    const { address, ...rest } = input;
    return this.request<ColumnCounterparty>("POST", "/counterparties", {
      routing_number_type: "aba",
      account_type: "checking",
      ...rest,
      // Form-encoded nested fields use bracket notation, as in Column's curl examples.
      ...Object.fromEntries(Object.entries(address).map(([k, v]) => [`address[${k}]`, v])),
    });
  }

  createBankAccount(input: { entity_id: string; description: string }) {
    return this.request<ColumnBankAccount>("POST", "/bank-accounts", input);
  }

  /** Sandbox payer entity for fresh sandboxes. Column auto-verifies sandbox entities. JSON body, per Column's docs. */
  async createBusinessEntity(input: { business_name: string; website: string }) {
    const res = await fetch(`${this.base}/entities/business`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`:${this.apiKey}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...input,
        ein: "123456789",
        legal_type: "corporation",
        industry: "Software",
        address: { line_1: "1 Market Street", city: "San Francisco", state: "CA", postal_code: "94105", country_code: "US" },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !json.id) throw new ColumnError(`Column POST /entities/business → ${res.status} ${json.message ?? ""}`.trim(), res.status);
    return json as { id: string };
  }

  getBankAccount(id: string) {
    return this.request<ColumnBankAccount & { balances?: { available_amount: number } }>("GET", `/bank-accounts/${encodeURIComponent(id)}`);
  }

  listEntities() {
    return this.request<{ entities?: { id: string; type?: string }[] }>("GET", "/entities?limit=10");
  }

  /** Sandbox-only: credits the account so released wires have funds. */
  simulateReceiveWire(input: { destination_account_number_id: string; amount: number }) {
    return this.request<unknown>("POST", "/simulate/receive-wire", { currency_code: "USD", ...input });
  }
}
