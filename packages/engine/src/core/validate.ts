import { EngineError, type PaymentInput, type Principal, type ResolveChallengeInput } from "./types";

// Runtime input validation for the in-process surface. Mirrors the tool schemas (§5.1) so a host that
// bypasses the tool layer gets the same refusals. Unknown fields are refused, never ignored.

type Obj = Record<string, unknown>;

export const PAYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A bare DNS hostname: labels of letters, digits and inner hyphens, at least one dot. */
export const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const invalid = (path: string, message: string) => new EngineError("INVALID_INPUT", message, { path });

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function object(v: unknown, path: string, allowed: readonly string[]): Obj {
  if (!isObj(v)) throw invalid(path, `${path || "input"} must be an object`);
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) throw invalid(`${path}/${key}`, `unexpected field ${key}`);
  }
  return v;
}

function str(o: Obj, key: string, path: string, rule: { required?: boolean; pattern?: RegExp; min?: number; max?: number }): string | undefined {
  const v = o[key];
  const p = `${path}/${key}`;
  if (v === undefined) {
    if (rule.required) throw invalid(p, `${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw invalid(p, `${key} must be a string`);
  if (rule.pattern && !rule.pattern.test(v)) throw invalid(p, `${key} has an invalid format`);
  if (rule.min !== undefined && v.length < rule.min) throw invalid(p, `${key} is too short`);
  if (rule.max !== undefined && v.length > rule.max) throw invalid(p, `${key} is too long`);
  return v;
}

const optional = <K extends string, V>(key: K, v: V | undefined) => (v === undefined ? {} : { [key]: v }) as Partial<Record<K, V>>;

export function validatePaymentInput(raw: unknown): PaymentInput {
  const p = object(raw, "/payment", ["id", "vendorId", "amountCents", "currency", "beneficiary", "requestSourceDomain", "invoiceContactPhone", "memo"]);
  const id = str(p, "id", "/payment", { required: true, pattern: PAYMENT_ID })!;
  const vendorId = str(p, "vendorId", "/payment", { required: true, min: 1, max: 128 })!;
  if (typeof p.amountCents !== "number" || !Number.isSafeInteger(p.amountCents) || p.amountCents < 1) {
    throw invalid("/payment/amountCents", "amountCents must be an integer >= 1");
  }
  if (p.currency !== "USD") throw invalid("/payment/currency", "currency must be USD");

  const b = object(p.beneficiary, "/payment/beneficiary", ["accountLast4", "accountNumber", "routingNumber", "railCounterpartyId"]);
  const bp = "/payment/beneficiary";
  const accountLast4 = str(b, "accountLast4", bp, { required: true, pattern: /^[0-9]{4}$/ })!;
  const accountNumber = str(b, "accountNumber", bp, { pattern: /^[0-9]{4,17}$/ });
  if (accountNumber !== undefined && !accountNumber.endsWith(accountLast4)) {
    throw invalid(`${bp}/accountNumber`, "accountNumber must end with accountLast4");
  }
  const routingNumber = str(b, "routingNumber", bp, { pattern: /^[0-9]{9}$/ });
  const railCounterpartyId = str(b, "railCounterpartyId", bp, { max: 128 });

  return {
    id,
    vendorId,
    amountCents: p.amountCents,
    currency: "USD",
    beneficiary: {
      accountLast4,
      ...optional("accountNumber", accountNumber),
      ...optional("routingNumber", routingNumber),
      ...optional("railCounterpartyId", railCounterpartyId),
    },
    requestSourceDomain: str(p, "requestSourceDomain", "/payment", { required: true, max: 253, pattern: HOSTNAME })!.toLowerCase(),
    ...optional("invoiceContactPhone", str(p, "invoiceContactPhone", "/payment", { max: 32 })),
    ...optional("memo", str(p, "memo", "/payment", { max: 280 })),
  };
}

export function validatePaymentId(paymentId: unknown): string {
  if (typeof paymentId !== "string" || !PAYMENT_ID.test(paymentId)) throw invalid("/paymentId", "paymentId has an invalid format");
  return paymentId;
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 255) throw invalid("/idempotencyKey", "idempotencyKey must be 1-255 characters");
  return key;
}

export function validateBlockReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.length < 3 || reason.length > 500) throw invalid("/reason", "reason must be 3-500 characters");
  return reason;
}

function validatePrincipal(v: unknown, path: string): Principal {
  const o = object(v, path, ["id", "kind", "roles"]);
  const id = str(o, "id", path, { required: true, min: 1, max: 256 })!;
  if (o.kind !== "agent" && o.kind !== "human" && o.kind !== "system") throw invalid(`${path}/kind`, "kind must be agent, human or system");
  if (!Array.isArray(o.roles) || !o.roles.every((r) => r === "requester" || r === "operator")) {
    throw invalid(`${path}/roles`, "roles must be a list of requester/operator");
  }
  return { id, kind: o.kind, roles: [...o.roles] };
}

const VERDICTS = ["AUTHORIZED", "DENIED", "INCONCLUSIVE"] as const;

export function validateResolveInput(raw: unknown): ResolveChallengeInput {
  // principal/requestedBy/resolvedBy are refused by name: identity comes from the ingress's own auth.
  const o = object(raw, "", ["challengeId", "verdict", "responderToken", "responder", "answers", "evidence"]);
  const challengeId = str(o, "challengeId", "", { required: true, min: 1, max: 128 })!;
  if (!VERDICTS.includes(o.verdict as (typeof VERDICTS)[number])) throw invalid("/verdict", "verdict must be AUTHORIZED, DENIED or INCONCLUSIVE");
  const responderToken = str(o, "responderToken", "", { min: 1, max: 256 });

  let answers: ResolveChallengeInput["answers"];
  if (o.answers !== undefined) {
    const a = object(o.answers, "/answers", ["authorizedChange", "beneficiaryLast4ReadBack", "amountConfirmed"]);
    if (a.authorizedChange !== undefined && !["yes", "no", "unclear", "no_answer"].includes(a.authorizedChange as string)) {
      throw invalid("/answers/authorizedChange", "authorizedChange must be yes, no, unclear or no_answer");
    }
    if (a.amountConfirmed !== undefined && typeof a.amountConfirmed !== "boolean") throw invalid("/answers/amountConfirmed", "amountConfirmed must be a boolean");
    answers = {
      ...optional("authorizedChange", a.authorizedChange as NonNullable<ResolveChallengeInput["answers"]>["authorizedChange"]),
      ...optional("beneficiaryLast4ReadBack", str(a, "beneficiaryLast4ReadBack", "/answers", { max: 32 })),
      ...optional("amountConfirmed", a.amountConfirmed as boolean | undefined),
    };
  }

  let evidence: ResolveChallengeInput["evidence"];
  if (o.evidence !== undefined) {
    const e = object(o.evidence, "/evidence", ["transcript", "durationSec", "tool"]);
    if (e.durationSec !== undefined && (typeof e.durationSec !== "number" || !(e.durationSec >= 0))) {
      throw invalid("/evidence/durationSec", "durationSec must be a number >= 0");
    }
    if (e.tool !== undefined && e.tool !== null && e.tool !== "approve_payment" && e.tool !== "freeze_payment") {
      throw invalid("/evidence/tool", "tool must be approve_payment, freeze_payment or null");
    }
    evidence = {
      ...optional("transcript", str(e, "transcript", "/evidence", { max: 100_000 })),
      ...optional("durationSec", e.durationSec as number | undefined),
      ...optional("tool", e.tool as "approve_payment" | "freeze_payment" | null | undefined),
    };
  }

  return {
    challengeId,
    verdict: o.verdict as ResolveChallengeInput["verdict"],
    ...optional("responderToken", responderToken),
    ...optional("responder", o.responder === undefined ? undefined : validatePrincipal(o.responder, "/responder")),
    ...optional("answers", answers),
    ...optional("evidence", evidence),
  };
}
