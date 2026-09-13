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

  createCounterparty(input: { routing_number: string; account_number: string; name: string; description?: string }) {
    return this.request<ColumnCounterparty>("POST", "/counterparties", {
      routing_number_type: "aba",
      account_type: "checking",
      ...input,
    });
  }

  createBankAccount(input: { entity_id: string; description: string }) {
    return this.request<ColumnBankAccount>("POST", "/bank-accounts", input);
  }

  listEntities() {
    return this.request<{ entities?: { id: string; type?: string }[] }>("GET", "/entities?limit=10");
  }

  /** Sandbox-only: credits the account so released wires have funds. */
  simulateReceiveWire(input: { destination_account_number_id: string; amount: number }) {
    return this.request<unknown>("POST", "/simulate/receive-wire", { currency_code: "USD", ...input });
  }
}
