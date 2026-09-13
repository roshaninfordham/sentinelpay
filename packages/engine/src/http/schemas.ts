import { toolDefinitions, type JSONSchema7, type ToolName } from "../tools/definitions";

// HTTP-only schemas. Request bodies for the requester routes are derived from the tool input schemas,
// so HTTP validation and the agent tools can never drift apart.

const inputOf = (name: ToolName) => toolDefinitions.find((d) => d.name === name)!.inputSchema;

function pick(schema: JSONSchema7, keys: string[]): JSONSchema7 {
  const properties = Object.fromEntries(keys.map((k) => [k, schema.properties![k]]));
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: (schema.required ?? []).filter((k) => keys.includes(k)),
  };
}

export const verifyBodySchema: JSONSchema7 = inputOf("verify_payment");
export const blockBodySchema: JSONSchema7 = pick(inputOf("block_payment"), ["reason"]);
export const paymentIdSchema: JSONSchema7 = inputOf("get_verification").properties!.paymentId;
const pollQuery = pick(inputOf("get_verification"), ["waitMs", "sinceVersion"]);
/** Same bounds as get_verification, but a plain HTTP GET answers immediately unless waitMs is given. */
export const pollQuerySchema: JSONSchema7 = {
  ...pollQuery,
  properties: { ...pollQuery.properties, waitMs: { ...pollQuery.properties!.waitMs, default: 0 } },
};
export const challengeIdSchema: JSONSchema7 = { type: "string", minLength: 1, maxLength: 128 };
export const idempotencyKeySchema: JSONSchema7 = { type: "string", minLength: 1, maxLength: 255 };

/** Responder route body. The responder token travels only in the Authorization header, never in a body. */
export const challengeResultBodySchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["AUTHORIZED", "DENIED", "INCONCLUSIVE"], description: "AUTHORIZED requires `Authorization: Bearer <responderToken>`." },
    answers: {
      type: "object",
      additionalProperties: false,
      properties: {
        authorizedChange: { type: "string", enum: ["yes", "no", "unclear", "no_answer"] },
        beneficiaryLast4ReadBack: { type: "string", maxLength: 32 },
        amountConfirmed: { type: "boolean" },
      },
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        transcript: { type: "string", maxLength: 100_000 },
        durationSec: { type: "number", minimum: 0 },
        tool: { type: ["string", "null"], enum: ["approve_payment", "freeze_payment", null] },
      },
    },
  },
};

const nextActionsSchema = toolDefinitions[0].outputSchema.properties!.nextActions;

export const errorSchema: JSONSchema7 = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "retryable", "nextActions"],
      properties: {
        code: { type: "string", description: "An EngineError code, or UNAUTHORIZED when no valid API key was presented." },
        message: { type: "string" },
        retryable: { type: "boolean" },
        path: { type: "string", description: "JSON pointer to the offending input (INVALID_INPUT)." },
        nextActions: nextActionsSchema,
      },
    },
  },
};

export const ledgerVerificationSchema: JSONSchema7 = {
  type: "object",
  required: ["ok", "length"],
  properties: { ok: { type: "boolean" }, brokenAt: { type: "integer" }, length: { type: "integer", minimum: 0 } },
};

export const healthSchema: JSONSchema7 = {
  type: "object",
  required: ["environment", "storage", "rail", "probes", "challengers"],
  properties: {
    environment: { type: "string" },
    storage: { type: "string" },
    rail: { type: "string" },
    probes: { type: "array", items: { type: "object", required: ["id", "origin"], properties: { id: { type: "string" }, origin: { type: "string" } } } },
    challengers: {
      type: "array",
      items: { type: "object", required: ["channel", "assurance"], properties: { channel: { type: "string" }, assurance: { type: "string" } } },
    },
  },
};
