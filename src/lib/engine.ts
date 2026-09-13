import type { Client, Transaction } from "@libsql/client";
import {
  ConfigError, createEngine, humanApprovalChallenger,
  type CaseRecord, type Challenger, type Engine, type EngineEvent, type Environment, type Principal, type Probe, type Rail, type RiskAssessment,
} from "@sentinelpay/engine";
import { columnRail } from "@sentinelpay/engine/adapters/column";
import { fixtureProbe, withFallback } from "@sentinelpay/engine/adapters/fixtures";
import { libsqlStorage, libsqlVendors } from "@sentinelpay/engine/adapters/libsql";
import { rdapProbe } from "@sentinelpay/engine/adapters/rdap";
import { tavilyProbe } from "@sentinelpay/engine/adapters/tavily";
import type { HealthInfo } from "@sentinelpay/engine/http";
import rdapFixtures from "../../fixtures/rdap.json";
import tavilyFixtures from "../../fixtures/tavily.json";
import { getDb } from "./db";
import { loadColumnConfig, type ColumnSandboxConfig } from "./providers/column-config";
import { emit as writeTimeline } from "./timeline";
import { formatEvent } from "./timeline-format";
import type { DemoMode, PaymentRail } from "./types";
import { browserVoiceChallenger } from "./voice/browser-challenger";

// The app's engine factory and the ONLY place app code reads configuration from the environment.
// Lazy and resettable: tests set process.env before their first dynamic import, and nothing is built until used.

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Principal for payments submitted from the dashboard AP queue and the legacy routes. */
export const APP_REQUESTER: Principal = { id: "app:ap-queue", kind: "system", roles: ["requester"] };
/** Principal for the dashboard's own reads and its "Freeze now" action. */
export const APP_OPERATOR: Principal = { id: "app:operator-console", kind: "human", roles: ["operator"] };

export interface AppSettings {
  environment: Environment;
  demoMode: DemoMode;
  paceMs: number;
  payerName: string;
  rail: { name: PaymentRail; note?: string };
  column: { apiKey: `test_${string}`; config: ColumnSandboxConfig } | null;
  tavilyApiKey?: string;
  elevenLabs: { apiKey: string; agentId: string } | null;
  approvalBaseUrl: string | null;
  tokenPepper: string;
  apiKeys: Array<{ key: string; principal: Principal }>;
}

export interface AppRuntime {
  settings: AppSettings;
  client: Client;
  engine: Engine;
  loadCase(key: { paymentId: string } | { challengeId: string }): Promise<CaseRecord | null>;
  listCases(): Promise<CaseRecord[]>;
  authenticate(req: Request): Promise<Principal | null>;
  health: HealthInfo;
}

type Env = Record<string, string | undefined>;

const ENVIRONMENTS: Environment[] = ["production", "sandbox", "test"];

function readEnvironment(env: Env): Environment {
  const raw = env.SENTINELPAY_ENVIRONMENT ?? "sandbox";
  if (!ENVIRONMENTS.includes(raw as Environment)) throw new ConfigError(`SENTINELPAY_ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}`);
  return raw as Environment;
}

function readPaceMs(env: Env): number {
  const v = Number(env.DEMO_PACE_MS);
  return env.DEMO_PACE_MS !== undefined && Number.isFinite(v) && v >= 0 ? v : 900;
}

// PAYMENT_SOURCE=mock|column. Column falls back to the mock AP queue, with the reason shown in the dashboard.
function readRail(env: Env, demoMode: DemoMode): Pick<AppSettings, "rail" | "column"> {
  if (env.PAYMENT_SOURCE !== "column") return { rail: { name: "mock" }, column: null };
  const mock = (note: string) => ({ rail: { name: "mock" as const, note }, column: null });
  if (demoMode === "cache") return mock("PAYMENT_SOURCE=column ignored in DEMO_MODE=cache");
  const apiKey = env.COLUMN_API_KEY;
  if (!apiKey) return mock("COLUMN_API_KEY not set");
  if (!apiKey.startsWith("test_")) return mock("COLUMN_API_KEY is not a sandbox (test_) key");
  const config = loadColumnConfig({ json: env.COLUMN_SANDBOX_CONFIG, file: env.COLUMN_CONFIG_PATH });
  if (!config) return mock("run `pnpm column:setup` first");
  return { rail: { name: "column" }, column: { apiKey: apiKey as `test_${string}`, config } };
}

function readTokenPepper(env: Env, environment: Environment): string {
  if (env.SENTINELPAY_TOKEN_PEPPER) return env.SENTINELPAY_TOKEN_PEPPER; // createEngine enforces >= 32 bytes
  if (environment === "production") throw new ConfigError("SENTINELPAY_TOKEN_PEPPER is required in production");
  console.warn("[sentinelpay] SENTINELPAY_TOKEN_PEPPER is not set; using a derived development pepper. Never do this in production.");
  // Stable per database, so open challenges survive a restart of the dev server.
  return `sentinelpay-development-token-pepper:${env.TURSO_DATABASE_URL ?? env.SENTINEL_DB_PATH ?? "local"}`;
}

// APPROVAL_DELIVERY=log prints the approval link to the server log. It is the only delivery the app ships, and it
// is refused in production: a log the requester can read is not an out-of-band channel.
function readApprovalBaseUrl(env: Env, environment: Environment): string | null {
  const delivery = env.APPROVAL_DELIVERY;
  if (!delivery) return null;
  if (delivery !== "log") throw new ConfigError(`APPROVAL_DELIVERY=${delivery} is not supported (only "log")`);
  if (environment === "production") throw new ConfigError("APPROVAL_DELIVERY=log is refused in production");
  if (env.APPROVAL_BASE_URL) return env.APPROVAL_BASE_URL;
  return env.VERCEL_URL ? `https://${env.VERCEL_URL}/approve` : `http://localhost:${env.PORT ?? 3000}/approve`;
}

const KINDS: Principal["kind"][] = ["agent", "human", "system"];
const ROLES: Principal["roles"][number][] = ["requester", "operator"];

/** SENTINELPAY_API_KEYS="sk_a:agent:ap-bot:requester,sk_b:human:jdoe:operator" (roles may be joined with "+"). */
export function parseApiKeys(raw: string | undefined): AppSettings["apiKeys"] {
  const entries: AppSettings["apiKeys"] = [];
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, kind, id, roleList] = item.split(":");
    const roles = (roleList ?? "").split("+") as Principal["roles"];
    if (!key || !id || !KINDS.includes(kind as Principal["kind"]) || !roles.every((r) => ROLES.includes(r))) {
      console.error("[sentinelpay] ignoring a malformed SENTINELPAY_API_KEYS entry (expected key:kind:id:role)");
      continue;
    }
    entries.push({ key, principal: { id, kind: kind as Principal["kind"], roles } });
  }
  return entries;
}

export function readSettings(env: Env = process.env): AppSettings {
  const environment = readEnvironment(env);
  const demoMode: DemoMode = env.DEMO_MODE === "cache" ? "cache" : "live";
  return {
    environment,
    demoMode,
    paceMs: readPaceMs(env),
    payerName: env.PAYER_COMPANY_NAME || "Acme Corp",
    ...readRail(env, demoMode),
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    elevenLabs: env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID ? { apiKey: env.ELEVENLABS_API_KEY, agentId: env.ELEVENLABS_AGENT_ID } : null,
    approvalBaseUrl: readApprovalBaseUrl(env, environment),
    tokenPepper: readTokenPepper(env, environment),
    apiKeys: parseApiKeys(env.SENTINELPAY_API_KEYS),
  };
}

/** Constant-time for equal lengths; compares every configured key so timing does not reveal which one matched. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

function authenticator(apiKeys: AppSettings["apiKeys"]) {
  return async (req: Request): Promise<Principal | null> => {
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!bearer) return null;
    let match: Principal | null = null;
    for (const entry of apiKeys) {
      if (sameSecret(entry.key, bearer)) match = entry.principal;
    }
    return match;
  };
}

// ── probes ──

const PROBE_LABELS: Record<string, string> = { rdap: "RDAP", tavily: "Tavily" };

function withNote(probe: Probe, note: string): Probe {
  return {
    id: probe.id,
    async run(ctx) {
      const r = await probe.run(ctx);
      return { ...r, note: r.note ? `${note}; ${r.note}` : note };
    },
  };
}

/**
 * Demo continuity outside production: the scenario vendor is fictional, so a live search that finds no registry
 * phone falls back to the recorded capture instead of ending the demo at NO_CHALLENGE_CHANNEL.
 */
function requireRegistryPhone(probe: Probe): Probe {
  return {
    id: probe.id,
    async run(ctx) {
      const r = await probe.run(ctx);
      if (!r.contactCandidate) throw new Error("live search found no registry phone");
      return r;
    },
  };
}

function buildProbes(s: AppSettings): Probe[] {
  const rdapFixture = fixtureProbe("rdap", rdapFixtures);
  const tavilyFixture = fixtureProbe("tavily", tavilyFixtures);
  if (s.demoMode === "cache") return [rdapFixture, tavilyFixture];
  let tavily = withNote(tavilyFixture, "TAVILY_API_KEY not set");
  if (s.tavilyApiKey) {
    const live = tavilyProbe({ apiKey: s.tavilyApiKey });
    tavily = withFallback(s.environment === "production" ? live : requireRegistryPhone(live), tavilyFixture);
  }
  return [withFallback(rdapProbe(), rdapFixture), tavily];
}

// ── build ──

function buildChallengers(s: AppSettings, client: Client): Challenger[] {
  const challengers: Challenger[] = [];
  if (s.approvalBaseUrl) {
    const approval = humanApprovalChallenger({
      approvalBaseUrl: s.approvalBaseUrl,
      async deliver(msg) {
        // Sandbox delivery: the link (with its token) goes to the server log only, never to the shared timeline.
        console.info(`[sentinelpay] approval link for ${msg.to}: ${msg.url}\n  ${msg.summary}`);
      },
    });
    challengers.push({
      ...approval,
      async start(req) {
        const started = await approval.start(req);
        await writeTimeline(req.facts.paymentId, "call", "☎ Challenge  approval link delivered to an internal approver (sandbox: server log)");
        return started;
      },
    });
  }
  // In production /api/voice/token requires an operator API key, which is what operatorAuth attests.
  challengers.push(browserVoiceChallenger(client, { operatorAuth: s.environment === "production" }));
  return challengers;
}

/** Keeps the dashboard's payments row in step with the case, inside the commit transaction (ENGINE_SPEC §8 step 2). */
async function syncPaymentRow(tx: Transaction, c: CaseRecord): Promise<void> {
  const p = c.payment;
  await tx.execute({
    sql: `INSERT INTO payments (id, vendorId, amountCents, currency, claimedBankLast4, requestSourceDomain, invoiceContactPhone,
                                status, createdAt, memo, railCounterpartyId, railReference)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, claimedBankLast4 = excluded.claimedBankLast4,
                                        railReference = excluded.railReference`,
    args: [
      p.id, p.vendorId, p.amountCents, p.currency, p.beneficiary.accountLast4, p.requestSourceDomain, p.invoiceContactPhone ?? null,
      c.state, c.updatedAt, p.memo ?? null, p.beneficiary.railCounterpartyId ?? null, c.rail.reference ?? null,
    ],
  });
}

async function build(): Promise<AppRuntime> {
  const settings = readSettings();
  const client = await getDb();
  const storage = libsqlStorage(client, { onCommit: syncPaymentRow });
  await storage.migrate();

  const probes = buildProbes(settings);
  const challengers = buildChallengers(settings, client);
  const column = settings.column;
  const rail: Rail | undefined = column
    ? columnRail({ apiKey: column.apiKey, bankAccountId: column.config.bankAccountId, counterparties: column.config.paymentCounterparties })
    : undefined;

  const formatContext = {
    probeLabels: probes.map((p) => PROBE_LABELS[p.id] ?? p.id),
    appPrincipalId: APP_REQUESTER.id,
    ...(column ? { railLabel: "Column sandbox", railFrozenNote: `Column sandbox: no wire created, funds remain in account ${column.config.bankAccountId}` } : {}),
  };

  // The vendor master is written here, by the app, never by a probe (§4.6 rule 4). Only registry evidence counts,
  // fixture evidence never does in production, and a vendor_master number is never overwritten.
  async function recordRegistryPhone(c: CaseRecord, risk: RiskAssessment) {
    const phone = risk.verifiedCallbackPhone;
    if (!phone) return;
    const signal = risk.signals.find((s) => s.key === "verified_phone" && s.value === phone);
    if (settings.environment === "production" && signal?.origin !== "live") return;
    await client.execute({
      sql: `UPDATE vendors SET verifiedPhone = ?, verifiedPhoneProvenance = 'registry'
            WHERE id = ? AND COALESCE(verifiedPhoneProvenance, '') <> 'vendor_master'`,
      args: [phone, c.vendorSnapshot.id],
    });
  }

  async function onEvent(e: EngineEvent) {
    try {
      const c = await storage.load({ paymentId: e.paymentId });
      for (const line of formatEvent(e, { ...formatContext, case: c })) {
        if (line.pace && settings.paceMs) await sleep(line.pace * settings.paceMs);
        await writeTimeline(e.paymentId, line.kind, line.text);
      }
      if (e.type === "risk" && c) await recordRegistryPhone(c, e.risk);
    } catch (err) {
      console.error("[sentinelpay] timeline sink failed:", (err as Error).message);
    }
  }

  const engine = createEngine({
    environment: settings.environment,
    storage,
    vendors: libsqlVendors(client),
    challengers,
    probes,
    rail,
    secrets: { tokenPepper: settings.tokenPepper },
    payer: { name: settings.payerName },
    principal: APP_REQUESTER,
    // Live Tavily "advanced" searches can take longer than the 8 s default.
    ...(settings.demoMode === "live" ? { probeTimeoutMs: 15_000 } : {}),
    onEvent,
  });

  return {
    settings,
    client,
    engine,
    loadCase: (key) => storage.load(key),
    listCases: () => storage.list({}),
    authenticate: authenticator(settings.apiKeys),
    health: {
      environment: settings.environment,
      storage: "libsql",
      rail: rail ? rail.id : "none (host pays on PAY)",
      probes: probes.map((p) => ({ id: p.id, origin: settings.demoMode === "cache" ? "fixture" : "live" })),
      challengers: challengers.map((c) => ({ channel: c.channel, assurance: c.assurance })),
    },
  };
}

const globalForEngine = globalThis as unknown as { __sentinelRuntime?: Promise<AppRuntime> };

export function getRuntime(): Promise<AppRuntime> {
  if (!globalForEngine.__sentinelRuntime) {
    globalForEngine.__sentinelRuntime = build().catch((err) => {
      globalForEngine.__sentinelRuntime = undefined; // a fixed configuration takes effect on the next request
      throw err;
    });
  }
  return globalForEngine.__sentinelRuntime;
}

export async function getEngine(): Promise<Engine> {
  return (await getRuntime()).engine;
}

/** Drops the cached engine so changed env takes effect (tests, config reload). */
export function resetEngine(): void {
  globalForEngine.__sentinelRuntime = undefined;
}
