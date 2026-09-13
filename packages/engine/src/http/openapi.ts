import { receiptSchema, verificationSchema, verificationWithReceiptSchema, type JSONSchema7 } from "../tools/definitions";
import {
  blockBodySchema, challengeIdSchema, challengeResultBodySchema, errorSchema, healthSchema, idempotencyKeySchema,
  ledgerVerificationSchema, paymentIdSchema, pollQuerySchema, verifyBodySchema,
} from "./schemas";

// OpenAPI 3.1 for the v1 HTTP contract (§5.5), generated from the same schema objects the tools use.

export const DEFAULT_BASE_PATH = "/api/v1";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: unknown) => ({ "application/json": { schema } });

const errorResponse = (description: string) => ({ description, content: jsonContent(ref("Error")) });

const verificationHeaders = {
  ETag: { description: 'Quoted version, e.g. "4".', schema: { type: "string" } },
  "Retry-After": { description: "Seconds to wait before polling again. Present when decision is WAIT.", schema: { type: "integer" } },
};

const verificationResponse = (description: string) => ({ description, headers: verificationHeaders, content: jsonContent(ref("Verification")) });

const pathParam = (name: string, schema: JSONSchema7) => ({ name, in: "path", required: true, schema });

const API_KEY = [{ apiKey: [] }];
const COMMON_ERRORS = { 401: errorResponse("Missing or invalid API key (code UNAUTHORIZED)"), 503: errorResponse("STORAGE_UNAVAILABLE") };

export function openApiDocument(opts: { basePath?: string; serverUrl?: string } = {}) {
  return {
    openapi: "3.1.0",
    info: {
      title: "SentinelPay API",
      version: "v1",
      description:
        "Fail-closed verification for vendor bank-change payments. Pay only when decision is PAY; do nextActions[0]. " +
        "Additive changes only within v1.",
    },
    servers: [{ url: opts.serverUrl ?? opts.basePath ?? DEFAULT_BASE_PATH }],
    paths: {
      "/verifications": {
        post: {
          operationId: "verifyPayment",
          summary: "Verify a payment before sending it",
          security: API_KEY,
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: idempotencyKeySchema }],
          requestBody: { required: true, content: jsonContent(ref("VerifyPaymentRequest")) },
          responses: {
            200: verificationResponse("Existing verification for the same key and request"),
            201: verificationResponse("Verification created"),
            400: errorResponse("INVALID_INPUT"),
            404: errorResponse("VENDOR_UNKNOWN"),
            409: errorResponse("IDEMPOTENCY_CONFLICT"),
            ...COMMON_ERRORS,
          },
        },
      },
      "/verifications/{paymentId}": {
        get: {
          operationId: "getVerification",
          summary: "Get (and long-poll) a verification",
          security: API_KEY,
          parameters: [
            pathParam("paymentId", paymentIdSchema),
            { name: "waitMs", in: "query", required: false, schema: pollQuerySchema.properties!.waitMs },
            { name: "sinceVersion", in: "query", required: false, schema: pollQuerySchema.properties!.sinceVersion },
            { name: "If-None-Match", in: "header", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: verificationResponse("Current verification"),
            304: { description: "Version unchanged since If-None-Match", headers: verificationHeaders },
            400: errorResponse("INVALID_INPUT"),
            404: errorResponse("NOT_FOUND"),
            ...COMMON_ERRORS,
          },
        },
      },
      "/verifications/{paymentId}/block": {
        post: {
          operationId: "blockPayment",
          summary: "Block a payment (always moves toward DO_NOT_PAY)",
          security: API_KEY,
          parameters: [pathParam("paymentId", paymentIdSchema)],
          requestBody: { required: true, content: jsonContent(ref("BlockPaymentRequest")) },
          responses: {
            200: verificationResponse("Blocked, or the unchanged terminal verification"),
            400: errorResponse("INVALID_INPUT"),
            404: errorResponse("NOT_FOUND"),
            ...COMMON_ERRORS,
          },
        },
      },
      "/verifications/{paymentId}/receipt": {
        get: {
          operationId: "getReceipt",
          summary: "Tamper-evident receipt with the hash-chained ledger",
          security: API_KEY,
          parameters: [pathParam("paymentId", paymentIdSchema)],
          responses: { 200: { description: "Receipt", content: jsonContent(ref("Receipt")) }, 404: errorResponse("NOT_FOUND"), ...COMMON_ERRORS },
        },
      },
      "/challenges/{challengeId}/result": {
        post: {
          operationId: "submitChallengeResult",
          summary: "Responder channel ingress. Not an agent tool.",
          description:
            "AUTHORIZED requires `Authorization: Bearer <responderToken>` from the delivered link. " +
            "DENIED and INCONCLUSIVE require an API key. The responder identity comes from authentication, never from the body.",
          security: [{ responderToken: [] }, { apiKey: [] }],
          parameters: [pathParam("challengeId", challengeIdSchema)],
          requestBody: { required: true, content: jsonContent(ref("ChallengeResultRequest")) },
          responses: {
            200: verificationResponse("Resolved, or the unchanged terminal verification"),
            400: errorResponse("INVALID_INPUT"),
            401: errorResponse("RESPONDER_TOKEN_INVALID, or UNAUTHORIZED without an API key"),
            403: errorResponse("RESPONDER_TOKEN_REQUIRED or SELF_APPROVAL_FORBIDDEN"),
            404: errorResponse("NOT_FOUND"),
            409: errorResponse("INVALID_TRANSITION"),
            410: errorResponse("CHALLENGE_EXPIRED"),
            503: errorResponse("STORAGE_UNAVAILABLE"),
          },
        },
      },
      "/ledger/verify": {
        get: {
          operationId: "verifyLedger",
          summary: "Verify the whole hash chain",
          security: API_KEY,
          responses: { 200: { description: "Chain verification", content: jsonContent(ref("LedgerVerification")) }, ...COMMON_ERRORS },
        },
      },
      "/tools": {
        get: {
          operationId: "listTools",
          summary: "Requester tool definitions (the responder route is not a tool)",
          security: [],
          responses: { 200: { description: "Tool definitions", content: jsonContent({ type: "array", items: { type: "object" } }) } },
        },
      },
      "/openapi.json": {
        get: { operationId: "openApi", summary: "This document", security: [], responses: { 200: { description: "OpenAPI 3.1 document" } } },
      },
      "/health": {
        get: {
          operationId: "health",
          summary: "Environment, storage, rail, probes and challengers",
          security: [],
          responses: { 200: { description: "Health", content: jsonContent(ref("Health")) } },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "API key mapped to a principal by the host." },
        responderToken: { type: "http", scheme: "bearer", description: "Responder token from the out-of-band link. Never held by the requester." },
      },
      schemas: {
        VerifyPaymentRequest: verifyBodySchema,
        BlockPaymentRequest: blockBodySchema,
        ChallengeResultRequest: challengeResultBodySchema,
        Verification: verificationSchema,
        Receipt: receiptSchema,
        VerificationWithReceipt: verificationWithReceiptSchema,
        LedgerVerification: ledgerVerificationSchema,
        Health: healthSchema,
        Error: errorSchema,
      },
    },
  };
}
