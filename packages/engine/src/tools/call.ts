import { EngineError, type EngineErrorCode, type NextAction, type Principal, type Receipt, type SentinelPay, type Verification } from "../core/types";
import { toolDefinition, type JSONSchema7 } from "./definitions";
import { stripNulls, validateSchema } from "./validate";

export interface ToolError {
  code: EngineErrorCode;
  message: string;
  retryable: boolean;
  path?: string;
  nextActions: NextAction[];
}

export type ToolResult =
  | { ok: true; result: Verification | { verification: Verification; receipt: Receipt } }
  | { ok: false; error: ToolError };

const ERROR_CODES: readonly EngineErrorCode[] = [
  "INVALID_INPUT", "NOT_FOUND", "VENDOR_UNKNOWN", "IDEMPOTENCY_CONFLICT", "INVALID_TRANSITION",
  "RESPONDER_TOKEN_REQUIRED", "RESPONDER_TOKEN_INVALID", "SELF_APPROVAL_FORBIDDEN", "CHALLENGE_EXPIRED",
  "REVERIFY_REQUIRES_OPERATOR", "STORAGE_UNAVAILABLE", "VERSION_CONFLICT",
];

/** Identity comes from authentication, never from arguments (§4.3 rule 2). */
export const FORBIDDEN_BODY_FIELDS = ["principal", "requestedBy", "resolvedBy"] as const;

export const isEngineErrorCode = (v: unknown): v is EngineErrorCode => ERROR_CODES.includes(v as EngineErrorCode);

/** Error contract (§5.2). Anything that is not a coded engine error is reported as a retryable outage, never as success. */
export function toToolError(err: unknown): ToolError {
  const e = err as Partial<EngineError> | null;
  if (e && isEngineErrorCode(e.code)) {
    const nextActions = Array.isArray(e.nextActions) && e.nextActions.length
      ? e.nextActions
      : new EngineError(e.code, "").nextActions;
    return {
      code: e.code,
      message: typeof e.message === "string" ? e.message : e.code,
      retryable: typeof e.retryable === "boolean" ? e.retryable : e.code === "STORAGE_UNAVAILABLE" || e.code === "VERSION_CONFLICT",
      ...(e.path !== undefined ? { path: e.path } : {}),
      nextActions,
    };
  }
  // The underlying message is withheld: it may carry adapter internals. A transport error's own retryable flag
  // (false for a rejected API key) is kept so an agent does not retry forever.
  return {
    code: "STORAGE_UNAVAILABLE",
    message: "verification service unavailable",
    retryable: typeof e?.retryable === "boolean" ? e.retryable : true,
    nextActions: [{ type: "DO_NOT_PAY", reason: "STORAGE_UNAVAILABLE", terminal: false }],
  };
}

export function invalidInput(path: string, message: string): EngineError {
  return new EngineError("INVALID_INPUT", message, { path });
}

/** Finds a forbidden identity field at any depth and returns its JSON pointer. */
export function findForbiddenField(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenField(value[i], `${path}/${i}`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, child] of Object.entries(value)) {
    if ((FORBIDDEN_BODY_FIELDS as readonly string[]).includes(key)) return `${path}/${key}`;
    const hit = findForbiddenField(child, `${path}/${key}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Refuses identity fields by name, then validates against the schema. Throws INVALID_INPUT.
 * Tool calls normalize null to absent first (strict function calling sends null for omitted optionals).
 */
export function parseArgs<T>(schema: JSONSchema7, raw: unknown, opts: { nullAsAbsent?: boolean } = {}): T {
  // Checked before null-stripping, so `"resolvedBy": null` is refused too.
  const forbidden = findForbiddenField(raw);
  if (forbidden) throw invalidInput(forbidden, `${forbidden.split("/").pop()} is set from authentication and cannot be supplied`);
  const args = (opts.nullAsAbsent ?? true) ? stripNulls(raw ?? {}) : raw;
  const issue = validateSchema(schema, args);
  if (issue) throw invalidInput(issue.path, issue.message);
  return args as T;
}

interface VerifyArgs { payment: Parameters<SentinelPay["verify"]>[0]; waitMs?: number }
interface GetArgs { paymentId: string; waitMs?: number; sinceVersion?: number; includeReceipt?: boolean }
interface BlockArgs { paymentId: string; reason: string }

/** Default long-poll for get_verification when the caller omits waitMs (§5.1). */
const GET_DEFAULT_WAIT_MS = 10_000;

/** Runs one requester tool. Never throws: every failure becomes the §5.2 error envelope. */
export async function callTool(api: SentinelPay, name: string, args: unknown, ctx: { principal?: Principal } = {}): Promise<ToolResult> {
  try {
    const def = toolDefinition(name);
    if (!def) throw invalidInput("", `unknown tool ${name}`);
    const principal = ctx.principal;

    switch (def.name) {
      case "verify_payment": {
        const a = parseArgs<VerifyArgs>(def.inputSchema, args);
        return { ok: true, result: await api.verify(a.payment, { waitMs: a.waitMs ?? 0, principal }) };
      }
      case "get_verification": {
        const a = parseArgs<GetArgs>(def.inputSchema, args);
        const verification = await api.get(a.paymentId, { waitMs: a.waitMs ?? GET_DEFAULT_WAIT_MS, sinceVersion: a.sinceVersion, principal });
        if (!a.includeReceipt) return { ok: true, result: verification };
        return { ok: true, result: { verification, receipt: await api.receipt(a.paymentId, { principal }) } };
      }
      case "block_payment": {
        const a = parseArgs<BlockArgs>(def.inputSchema, args);
        return { ok: true, result: await api.block(a.paymentId, { reason: a.reason, principal }) };
      }
    }
  } catch (err) {
    return { ok: false, error: toToolError(err) };
  }
}
