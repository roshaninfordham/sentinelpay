import { EngineError, type NextAction, type PaymentInput, type Principal, type Receipt, type PayFirewall, type Verification } from "../core/types";
import { isEngineErrorCode } from "../tools/call";

// PayFirewall over the v1 HTTP contract. Identity comes from the API key; a per-call `principal` is ignored,
// because a remote caller can never choose who it is.

/** A non-engine HTTP failure (401 UNAUTHORIZED, a proxy error page, a network failure). Always means do not pay. */
export class PayFirewallHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly nextActions: NextAction[];

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "PayFirewallHttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.nextActions = [{ type: "DO_NOT_PAY", reason: "UNDER_INVESTIGATION", terminal: false }];
  }
}

export interface HttpClientOptions {
  /** e.g. "https://payfirewall.example.com/api/v1" */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

interface ErrorBody { error?: { code?: unknown; message?: unknown; path?: unknown; nextActions?: unknown } }

function toError(status: number, body: unknown): Error {
  const e = (body as ErrorBody | null)?.error;
  const message = typeof e?.message === "string" ? e.message : `HTTP ${status}`;
  if (e && isEngineErrorCode(e.code)) {
    return new EngineError(e.code, message, {
      ...(typeof e.path === "string" ? { path: e.path } : {}),
      ...(Array.isArray(e.nextActions) ? { nextActions: e.nextActions as NextAction[] } : {}),
    });
  }
  const code = typeof e?.code === "string" ? e.code : "HTTP_ERROR";
  return new PayFirewallHttpError(status, code, message, status >= 500 || status === 429);
}

export function createHttpClient(opts: HttpClientOptions): PayFirewall {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const id = (paymentId: string) => encodeURIComponent(paymentId);

  async function request<T>(method: "GET" | "POST", path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      throw new PayFirewallHttpError(0, "NETWORK_ERROR", `request failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) throw toError(res.status, body);
    if (body === undefined) throw new PayFirewallHttpError(res.status, "INVALID_RESPONSE", "response body is not JSON", true);
    return body as T;
  }

  const query = (params: Record<string, number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  return {
    verify(payment: PaymentInput, o: { idempotencyKey?: string; waitMs?: number; principal?: Principal } = {}) {
      return request<Verification>("POST", "/verifications", {
        body: { payment, ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}) },
        ...(o.idempotencyKey !== undefined ? { headers: { "idempotency-key": o.idempotencyKey } } : {}),
      });
    },
    get(paymentId, o = {}) {
      return request<Verification>("GET", `/verifications/${id(paymentId)}${query({ waitMs: o.waitMs, sinceVersion: o.sinceVersion })}`);
    },
    block(paymentId, o) {
      return request<Verification>("POST", `/verifications/${id(paymentId)}/block`, { body: { reason: o.reason } });
    },
    receipt(paymentId) {
      return request<Receipt>("GET", `/verifications/${id(paymentId)}/receipt`);
    },
  };
}
