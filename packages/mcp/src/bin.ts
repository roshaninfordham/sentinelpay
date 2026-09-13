#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEngine, type EngineConfig, type PayFirewall } from "payfirewall";
import { createHttpClient } from "payfirewall/client";
import { resolveLaunch, USAGE, UsageError, type LaunchMode } from "./config";
import { createMcpServer, DEFAULT_SWEEP_INTERVAL_MS, type McpServerOptions } from "./server";

// The only place in payfirewall-mcp that reads the environment. stdout carries the MCP protocol,
// so every diagnostic goes to stderr.

const log = (message: string) => process.stderr.write(`payfirewall-mcp: ${message}\n`);

async function loadEngineConfig(configPath: string): Promise<EngineConfig> {
  const mod = (await import(pathToFileURL(resolve(configPath)).href)) as { default?: unknown };
  const config = mod.default;
  if (typeof config !== "object" || config === null) {
    throw new UsageError(`${configPath} must default-export an EngineConfig object`);
  }
  return config as EngineConfig;
}

async function build(launch: Exclude<LaunchMode, { mode: "help" }>): Promise<{ api: PayFirewall; opts: McpServerOptions }> {
  if (launch.mode === "remote") {
    return { api: createHttpClient({ baseUrl: launch.url, apiKey: launch.apiKey }), opts: {} };
  }
  // createEngine refuses any configuration that would weaken a fail-closed guarantee.
  const engine = createEngine(await loadEngineConfig(launch.configPath));
  return {
    api: engine,
    opts: { sweep: { intervalMs: DEFAULT_SWEEP_INTERVAL_MS, onError: (err) => log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`) } },
  };
}

async function main() {
  const launch = resolveLaunch(process.argv.slice(2), process.env);
  if (launch.mode === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const { api, opts } = await build(launch);
  const server = createMcpServer(api, opts);
  await server.connect(new StdioServerTransport());
  log(`ready (${launch.mode} mode)`);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    log(err.message);
    process.stderr.write(`\n${USAGE}\n`);
    process.exit(2);
  }
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
