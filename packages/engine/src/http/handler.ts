import { EngineError, type ChallengeAnswers, type ChallengeEvidence, type Engine, type Principal, type PayFirewall, type Verdict, type Verification } from "../core/types";
import { invalidInput, parseArgs, toToolError } from "../tools/call";
import { toolDefinitions, type JSONSchema7 } from "../tools/definitions";
import { validateSchema } from "../tools/validate";
import { DEFAULT_BASE_PATH, openApiDocument } from "./openapi";
import {
  blockBodySchema, challengeIdSchema, challengeResultBodySchema, idempotencyKeySchema, paymentIdSchema, pollQuerySchema, verifyBodySchema,
} from "./schemas";

// HTTP contract v1 (§5.5): Web Request -> Response, mountable in any fetch-style runtime.

export interface HealthInfo {
  environment: string;
  storage: string;
  rail: string;
  probes: Array<{ id: string; origin: string }>;
  challengers: Array<{ channel: string; assurance: string }>;
}

export interface HandlerOptions {
  /** Default "/api/v1". */
  basePath?: string;
  /**
   * Maps the request's credentials (bearer API key, or a host session) to a Principal; null means 401.
   * Must be side-effect free: the result route also calls it with a header-only copy of the request minus
   * Authorization, to tell an API-key bearer from a responder token. A request carrying both an API key and a
   * session has its bearer treated as the responder token.
   */
  authenticate(req: Request): Promise<Principal | null>;
  /** Runs work after the response is sent (Next.js: `after`). Without it, pending steps advance lazily on GET. */
  schedule?(work: Promise<unknown>): void;
  /** Supplies GET /health. The engine does not expose its configuration, so the host describes it. */
  health?(): HealthInfo | Promise<HealthInfo>;
}

const MAX_BODY_BYTES = 64_000;

const UNKNOWN_HEALTH: HealthInfo = { environment: "unknown", storage: "unknown", rail: "unknown", probes: [], challengers: [] };

class Unauthorized extends Error {}

const isEngine = (api: PayFirewall): api is Engine =>
  typeof (api as Partial<Engine>).resolveChallenge === "function" && typeof (api as Partial<Engine>).verifyLedger === "function";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof Unauthorized) {
    return json(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "a valid API key is required",
        retryable: false,
        nextActions: [{ type: "DO_NOT_PAY", reason: "UNDER_INVESTIGATION", terminal: false }],
      },
    }, { "www-authenticate": 'Bearer realm="payfirewall"' });
  }
  const error = toToolError(err);
  return json(new EngineError(error.code, error.message).httpStatus, { error });
}

const etagOf = (v: Verification) => `"${v.version}"`;

function verificationHeaders(v: Verification): Record<string, string> {
  const headers: Record<string, string> = { etag: etagOf(v) };
  if (v.decision === "WAIT") {
    const first = v.nextActions[0];
    const afterMs = first && "afterMs" in first ? first.afterMs : 1000;
    headers["retry-after"] = String(Math.max(1, Math.ceil(afterMs / 1000)));
  }
  return headers;
}

const bearerOf = (req: Request): string | undefined => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return match?.[1];
};

/** Only the three Principal fields travel into the engine, whatever the host's authenticate returns. */
const normalizePrincipal = (p: Principal): Principal => ({ id: p.id, kind: p.kind, roles: [...p.roles] });

async function tryAuthenticate(authenticate: HandlerOptions["authenticate"], req: Request): Promise<Principal | null> {
  try {
    const p = await authenticate(req);
    return p ? normalizePrincipal(p) : null;
  } catch {
    return null;
  }
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw invalidInput("", "request body is too large");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw invalidInput("", "request body is not valid JSON");
  }
}

function checkParam(schema: JSONSchema7, value: unknown, path: string): void {
  const issue = validateSchema(schema, value, path);
  if (issue) throw invalidInput(issue.path, issue.message);
}

function intQuery(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw invalidInput(`/${name}`, `${name} must be a non-negative integer`);
  return Number(raw);
}

/** Parses If-None-Match into version numbers; `*` matches any version. */
function ifNoneMatch(req: Request): { any: boolean; versions: number[] } {
  const header = req.headers.get("if-none-match");
  if (!header) return { any: false, versions: [] };
  const parts = header.split(",").map((s) => s.trim());
  const versions = parts.map((p) => /^(?:W\/)?"(\d+)"$/.exec(p)?.[1]).filter((v): v is string => v !== undefined).map(Number);
  return { any: parts.includes("*"), versions };
}

export function createHandler(api: Engine | PayFirewall, opts: HandlerOptions): (req: Request) => Promise<Response> {
  const basePath = (opts.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");

  async function principalOf(req: Request): Promise<Principal> {
    const p = await tryAuthenticate(opts.authenticate, req);
    if (!p) throw new Unauthorized();
    return p;
  }

  function scheduleAdvance(v: Verification) {
    if (v.decision !== "WAIT" || !opts.schedule || !isEngine(api)) return;
    // A failed background step leaves the case held; the next GET retries it.
    opts.schedule(api.advance(v.paymentId).catch(() => undefined));
  }

  async function postVerification(req: Request): Promise<Response> {
    const principal = await principalOf(req);
    const body = parseArgs<{ payment: Parameters<PayFirewall["verify"]>[0]; waitMs?: number }>(verifyBodySchema, await readJson(req), { nullAsAbsent: false });
    const headerKey = req.headers.get("idempotency-key") ?? undefined;
    if (headerKey !== undefined) checkParam(idempotencyKeySchema, headerKey, "/idempotencyKey");

    // 201 vs 200: a case this principal cannot see is reported as new; verify then refuses it with 409 anyway.
    // Any other lookup failure is left to verify, so the error carries verify's nextActions.
    let existed = true;
    try {
      await api.get(body.payment.id, { waitMs: 0, principal });
    } catch (err) {
      existed = (err as { code?: string }).code !== "NOT_FOUND";
    }

    const v = await api.verify(body.payment, { idempotencyKey: headerKey, waitMs: body.waitMs ?? 0, principal });
    scheduleAdvance(v);
    const headers = verificationHeaders(v);
    if (!existed) headers.location = `${basePath}/verifications/${encodeURIComponent(v.paymentId)}`;
    return json(existed ? 200 : 201, v, headers);
  }

  async function getVerification(req: Request, url: URL, paymentId: string): Promise<Response> {
    const principal = await principalOf(req);
    checkParam(paymentIdSchema, paymentId, "/paymentId");
    const query = { waitMs: intQuery(url, "waitMs"), sinceVersion: intQuery(url, "sinceVersion") };
    parseArgs(pollQuerySchema, Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)), { nullAsAbsent: false });

    const conditional = ifNoneMatch(req);
    // A conditional long-poll waits for a version newer than the one the client already holds.
    const sinceVersion = query.sinceVersion ?? (conditional.versions.length ? Math.max(...conditional.versions) : undefined);
    const v = await api.get(paymentId, { waitMs: query.waitMs ?? 0, sinceVersion, principal });
    const headers = verificationHeaders(v);
    if (conditional.any || conditional.versions.includes(v.version)) return new Response(null, { status: 304, headers });
    return json(200, v, headers);
  }

  async function blockPayment(req: Request, paymentId: string): Promise<Response> {
    const principal = await principalOf(req);
    checkParam(paymentIdSchema, paymentId, "/paymentId");
    const body = parseArgs<{ reason: string }>(blockBodySchema, await readJson(req), { nullAsAbsent: false });
    const v = await api.block(paymentId, { reason: body.reason, principal });
    return json(200, v, verificationHeaders(v));
  }

  async function receipt(req: Request, paymentId: string): Promise<Response> {
    const principal = await principalOf(req);
    checkParam(paymentIdSchema, paymentId, "/paymentId");
    return json(200, await api.receipt(paymentId, { principal }));
  }

  /**
   * Responder ingress (§4.3). The bearer credential is an API key when `authenticate` accepts the request only
   * because of its Authorization header; otherwise it is the responder token, and any principal the host still
   * recognizes without that header (an approver session) is the person-authenticated responder.
   */
  async function challengeResult(engine: Engine, req: Request, challengeId: string): Promise<Response> {
    checkParam(challengeIdSchema, challengeId, "/challengeId");
    const withAuth = await tryAuthenticate(opts.authenticate, req);
    const headers = new Headers(req.headers);
    for (const name of ["authorization", "content-length", "content-type"]) headers.delete(name);
    const session = await tryAuthenticate(opts.authenticate, new Request(req.url, { method: "GET", headers }));
    const bearer = bearerOf(req);
    const body = parseArgs<{ verdict: Verdict; answers?: ChallengeAnswers; evidence?: ChallengeEvidence }>(
      challengeResultBodySchema, await readJson(req), { nullAsAbsent: false },
    );

    let v: Verification;
    if (body.verdict === "AUTHORIZED") {
      const bearerIsApiKey = withAuth !== null && session === null;
      if (!bearer || bearerIsApiKey) {
        throw new EngineError("RESPONDER_TOKEN_REQUIRED", "AUTHORIZED requires the responder token in the Authorization header");
      }
      v = await engine.resolveChallenge({
        challengeId, verdict: "AUTHORIZED", responderToken: bearer,
        ...(session ? { responder: session } : {}),
        ...(body.answers ? { answers: body.answers } : {}),
        ...(body.evidence ? { evidence: body.evidence } : {}),
      });
    } else {
      const responder = withAuth ?? session;
      if (!responder) throw new Unauthorized();
      v = await engine.resolveChallenge({
        challengeId, verdict: body.verdict, responder,
        ...(body.answers ? { answers: body.answers } : {}),
        ...(body.evidence ? { evidence: body.evidence } : {}),
      });
    }
    return json(200, v, verificationHeaders(v));
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) throw new EngineError("NOT_FOUND", "route not found");
    let segments: string[];
    try {
      segments = url.pathname.slice(basePath.length).split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      throw invalidInput("", "malformed path");
    }
    const method = req.method.toUpperCase();
    const [a, b, c, extra] = segments;

    if (method === "GET" && segments.length === 1) {
      if (a === "tools") return json(200, toolDefinitions, { "cache-control": "public, max-age=300" });
      if (a === "openapi.json") return json(200, openApiDocument({ basePath }), { "cache-control": "public, max-age=300" });
      if (a === "health") return json(200, (await opts.health?.()) ?? UNKNOWN_HEALTH);
    }
    if (extra === undefined && a === "verifications") {
      if (method === "POST" && b === undefined) return postVerification(req);
      if (method === "GET" && b !== undefined && c === undefined) return getVerification(req, url, b);
      if (method === "POST" && b !== undefined && c === "block") return blockPayment(req, b);
      if (method === "GET" && b !== undefined && c === "receipt") return receipt(req, b);
    }
    if (isEngine(api)) {
      if (method === "POST" && a === "challenges" && b !== undefined && c === "result" && extra === undefined) return challengeResult(api, req, b);
      if (method === "GET" && a === "ledger" && b === "verify" && c === undefined) {
        await principalOf(req);
        return json(200, await api.verifyLedger());
      }
    }
    throw new EngineError("NOT_FOUND", "route not found");
  }

  return async (req) => {
    try {
      return await route(req);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
