import type { Principal, SentinelPay } from "../../src/core/types";
import { createHandler, type HandlerOptions } from "../../src/http";
import { AGENT, APPROVER, OPERATOR } from "../core/helpers";

export const OTHER: Principal = { id: "agent:other-bot", kind: "agent", roles: ["requester"] };
export const BASE = "https://sentinelpay.test/api/v1";

const API_KEYS: Record<string, Principal> = { sk_agent: AGENT, sk_ops: OPERATOR, sk_other: OTHER };
const SESSIONS: Record<string, Principal> = { approver: APPROVER, agent: AGENT };

/** API keys in the bearer header; approver sessions in a cookie, as the /approve page would carry them. */
export async function authenticate(req: Request): Promise<Principal | null> {
  const bearer = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer && API_KEYS[bearer]) return API_KEYS[bearer];
  const session = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return session ? SESSIONS[session] ?? null : null;
}

export function handlerFor(api: SentinelPay, opts: Partial<HandlerOptions> = {}) {
  const handler = createHandler(api, { authenticate, ...opts });
  return async function call(method: string, path: string, init: { key?: string; bearer?: string; cookie?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    const bearer = init.bearer ?? init.key;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (init.cookie) headers.cookie = init.cookie;
    const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handler(new Request(`${BASE}${path}`, { method, headers, body }));
    const text = await res.text();
    return { res, status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : undefined };
  };
}
