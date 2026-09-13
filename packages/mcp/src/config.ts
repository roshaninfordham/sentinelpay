// Command-line parsing for the payfirewall-mcp bin. Pure: the bin passes argv and env in, so this module
// never reads process state and can be tested without spawning anything.

export type LaunchMode =
  | { mode: "remote"; url: string; apiKey: string }
  | { mode: "embedded"; configPath: string }
  | { mode: "help" };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `Usage:
  payfirewall-mcp                      remote mode: set PAYFIREWALL_URL and PAYFIREWALL_API_KEY
  payfirewall-mcp --config <module>    embedded mode: the module's default export is an EngineConfig

Remote mode is recommended: challengers, rails, storage and secrets stay with the host.`;

/** Reads only PAYFIREWALL_URL and PAYFIREWALL_API_KEY. */
export type LaunchEnv = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The API key travels in a bearer header, so plain http is refused except on loopback. */
function remoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`PAYFIREWALL_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new UsageError("PAYFIREWALL_URL must use https (http is allowed only for localhost)");
  }
  return raw;
}

export function resolveLaunch(argv: readonly string[], env: LaunchEnv): LaunchMode {
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { mode: "help" };
    if (arg === "--config") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new UsageError("--config needs a module path");
      configPath = value;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      if (!configPath) throw new UsageError("--config needs a module path");
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  const url = env.PAYFIREWALL_URL?.trim();
  const apiKey = env.PAYFIREWALL_API_KEY?.trim();

  // Both modes at once is ambiguous about where decisions are made, so neither is guessed.
  if (configPath && (url || apiKey)) {
    throw new UsageError("use either --config (embedded) or PAYFIREWALL_URL/PAYFIREWALL_API_KEY (remote), not both");
  }
  if (configPath) return { mode: "embedded", configPath };
  if (url && apiKey) return { mode: "remote", url: remoteUrl(url), apiKey };
  if (url || apiKey) throw new UsageError("remote mode needs both PAYFIREWALL_URL and PAYFIREWALL_API_KEY");
  throw new UsageError("no configuration: set PAYFIREWALL_URL and PAYFIREWALL_API_KEY, or pass --config <module>");
}

/**
 * Wraps fetch for remote mode so a rejected API key or an unreachable PAYFIREWALL_URL is reported once per kind
 * through `log`. Tool results still carry the fixed error envelope; responses and errors pass through unchanged.
 */
export function reportingFetch(log: (message: string) => void, inner: typeof fetch): typeof fetch {
  const reported = new Set<string>();
  const once = (kind: string, message: string) => {
    if (reported.has(kind)) return;
    reported.add(kind);
    log(message);
  };
  return async (input, init) => {
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (err) {
      once("network", `could not reach PAYFIREWALL_URL: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    // Only 401: a 403 or 404 can also be an engine answer (a payment this key cannot see, an operator-only action).
    if (res.status === 401) once("auth", "PAYFIREWALL_API_KEY was rejected (HTTP 401)");
    return res;
  };
}
