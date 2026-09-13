import { ConfigError, type Challenger, type EngineConfig, type Environment, type Principal } from "./types";

// createEngine refuses any configuration that would weaken a fail-closed guarantee (§4.6 rule 8).

export const DEFAULT_PRINCIPAL: Principal = { id: "system:local", kind: "system", roles: ["requester"] };

export interface Settings {
  config: EngineConfig;
  environment: Environment;
  principal: Principal;
  challengeTtlMs: number;
  probeTimeoutMs: number;
  stepLeaseMs: number;
  maxTokenAttempts: number;
  allowFixtureData: boolean;
  now: () => Date;
}

const ENVIRONMENTS: readonly Environment[] = ["production", "sandbox", "test"];

const byteLength = (s: string) => new TextEncoder().encode(s).length;

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new ConfigError(`${name} must be a positive integer`);
  return value;
}

const isTestChallenger = (c: Challenger) => c.assurance === "test" || c.channel === "scripted";

export function resolveConfig(config: EngineConfig): Settings {
  if (!config || typeof config !== "object") throw new ConfigError("config is required");
  const { environment } = config;
  if (!ENVIRONMENTS.includes(environment)) throw new ConfigError("environment is required: production, sandbox or test");
  const production = environment === "production";

  const s = config.storage;
  if (!s || typeof s.load !== "function" || typeof s.commit !== "function" || typeof s.ledger !== "function" || typeof s.list !== "function") {
    throw new ConfigError("storage must implement load, commit, ledger and list");
  }
  if (!config.vendors || typeof config.vendors.get !== "function") throw new ConfigError("vendors must implement get");
  if (!Array.isArray(config.challengers)) throw new ConfigError("challengers must be an array");
  if (config.probes !== undefined && !Array.isArray(config.probes)) throw new ConfigError("probes must be an array");
  if (!config.payer || typeof config.payer.name !== "string" || !config.payer.name.trim()) throw new ConfigError("payer.name is required");

  const pepper = config.secrets?.tokenPepper;
  if (typeof pepper !== "string" || byteLength(pepper) < 32) throw new ConfigError("secrets.tokenPepper must be at least 32 bytes");
  const fpKey = config.secrets.fingerprintKey;
  if (fpKey !== undefined && (typeof fpKey !== "string" || byteLength(fpKey) < 32)) {
    throw new ConfigError("secrets.fingerprintKey must be at least 32 bytes");
  }

  for (const c of config.challengers) {
    if (isTestChallenger(c)) {
      if (production) throw new ConfigError(`test challenger "${c.channel}" is refused in production`);
      if (config.allowTestChallengers !== true) throw new ConfigError(`test challenger "${c.channel}" requires allowTestChallengers: true`);
    }
    if (production && c.channel === "voice_browser" && c.operatorAuth !== true) {
      throw new ConfigError("voice_browser challenger in production requires operatorAuth: true");
    }
  }
  if (production && config.allowTestChallengers === true) throw new ConfigError("allowTestChallengers is refused in production");

  if (config.rail) {
    if (config.rail.environment !== environment) {
      throw new ConfigError(`rail "${config.rail.id}" environment ${config.rail.environment} does not match engine environment ${environment}`);
    }
    if (typeof config.rail.release !== "function") throw new ConfigError("rail must implement release");
  }

  return {
    config,
    environment,
    principal: config.principal ?? DEFAULT_PRINCIPAL,
    challengeTtlMs: positiveInt(config.challengeTtlMs, 900_000, "challengeTtlMs"),
    probeTimeoutMs: positiveInt(config.probeTimeoutMs, 8_000, "probeTimeoutMs"),
    stepLeaseMs: positiveInt(config.stepLeaseMs, 60_000, "stepLeaseMs"),
    maxTokenAttempts: positiveInt(config.maxTokenAttempts, 5, "maxTokenAttempts"),
    allowFixtureData: config.allowFixtureData ?? !production,
    now: config.clock ?? (() => new Date()),
  };
}
