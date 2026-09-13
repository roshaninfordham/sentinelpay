#!/usr/bin/env node
// Tarball smoke test for the two published packages (ENGINE_SPEC §7.5).
//
// Builds payfirewall and payfirewall-mcp, packs them with `pnpm pack` (so publishConfig and the workspace:*
// rewrite apply exactly as they will on `pnpm publish`), installs both tarballs with npm into a fresh project
// outside the workspace, and checks that a consumer can actually use them:
//   - ESM and CJS scripts run a changed-beneficiary payment to DO_NOT_PAY through a scripted denial
//   - every public subpath resolves, and all but the optional-peer libsql adapter import cleanly
//   - the package types resolve for a TypeScript consumer (moduleResolution node16)
//   - the payfirewall-mcp bin prints usage with --help and refuses to start without configuration
// The dist folders are removed afterwards. Set PACK_SMOKE_KEEP=1 to keep the temp project for inspection.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "packages/engine");
const mcpDir = join(root, "packages/mcp");
const work = mkdtempSync(join(process.env.PACK_SMOKE_DIR ?? tmpdir(), "payfirewall-pack-smoke-"));
const tarballs = join(work, "tarballs");
const project = join(work, "project");

const SUBPATHS = [
  "payfirewall",
  "payfirewall/tools",
  "payfirewall/http",
  "payfirewall/client",
  "payfirewall/testing",
  "payfirewall/adapters/memory",
  "payfirewall/adapters/rdap",
  "payfirewall/adapters/tavily",
  "payfirewall/adapters/fixtures",
  "payfirewall/adapters/column",
  "payfirewall/adapters/elevenlabs",
  "payfirewall-mcp",
];
// Needs the optional peer @libsql/client, which a fresh project does not have: resolve only.
const RESOLVE_ONLY = ["payfirewall/adapters/libsql"];

function step(label) {
  process.stdout.write(`\n▶ ${label}\n`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  if (!opts.allowFailure && r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}${opts.capture ? `\n${r.stdout}\n${r.stderr}` : ""}`);
  }
  return r;
}

function check(ok, label) {
  if (!ok) throw new Error(`check failed: ${label}`);
  process.stdout.write(`  ✓ ${label}\n`);
}

const scenario = `
const vendors = [{ id: "v_meridian", legalName: "Meridian Global Logistics LLC", knownDomain: "meridianglobal.com", knownBankLast4: "4471" }];
const payment = {
  id: "pay_smoke", vendorId: "v_meridian", amountCents: 24000000, currency: "USD",
  beneficiary: { accountLast4: "9821" }, requestSourceDomain: "meridian-global.co",
};
const config = () => ({
  environment: "test",
  storage: memoryStorage(),
  vendors: memoryVendors(vendors),
  challengers: [scriptedChallenger("DENIED")],
  allowTestChallengers: true,
  secrets: { tokenPepper: "pack-smoke-pepper-0123456789abcdef0123456789" },
  payer: { name: "Acme Corp" },
});
const fail = (msg) => { throw new Error(msg); };
async function scenarioRun(label) {
  const engine = createEngine(config());
  const v = await engine.verify(payment, { waitMs: 5000 });
  if (v.decision !== "DO_NOT_PAY") fail(label + ": expected DO_NOT_PAY, got " + v.decision + " (" + v.reason + ")");
  if (v.reason !== "VENDOR_DENIED_CHANGE") fail(label + ": expected VENDOR_DENIED_CHANGE, got " + v.reason);
  if (v.nextActions[0].type !== "DO_NOT_PAY") fail(label + ": nextActions[0] is " + v.nextActions[0].type);
  const receipt = await engine.receipt(payment.id);
  if (!receipt.chain.ok || receipt.entries.length !== 6) fail(label + ": receipt chain " + JSON.stringify(receipt.chain));
  const tool = await callTool(engine, "get_verification", { paymentId: payment.id, waitMs: 0 });
  if (!tool.ok || tool.result.decision !== "DO_NOT_PAY") fail(label + ": callTool did not return DO_NOT_PAY");
  if (toOpenAITools().length !== 3 || toAnthropicTools().length !== 3) fail(label + ": expected 3 tools");
  let refused = false;
  try { createEngine({ ...config(), allowTestChallengers: false }); } catch (err) { refused = err instanceof ConfigError; }
  if (!refused) fail(label + ": scripted challenger was not refused without allowTestChallengers");
  console.log("  ✓ " + label + ": " + v.state + " " + v.decision + " " + v.reason + ", chain ok (" + receipt.entries.length + " entries)");
}
`;

const esm = `
import { ConfigError, createEngine } from "payfirewall";
import { memoryStorage, memoryVendors } from "payfirewall/adapters/memory";
import { scriptedChallenger } from "payfirewall/testing";
import { callTool, toAnthropicTools, toOpenAITools } from "payfirewall/tools";
${scenario}
await scenarioRun("ESM");
for (const s of ${JSON.stringify(SUBPATHS)}) {
  const mod = await import(s);
  if (Object.keys(mod).length === 0) fail("ESM import " + s + " has no exports");
}
for (const s of ${JSON.stringify(RESOLVE_ONLY)}) import.meta.resolve(s);
console.log("  ✓ ESM: imported ${SUBPATHS.length} subpaths, resolved ${RESOLVE_ONLY.join(", ")}");
`;

// payfirewall-mcp is ESM-only, so the CJS consumer covers the engine's subpaths.
const cjsSubpaths = SUBPATHS.filter((s) => !s.startsWith("payfirewall-mcp"));
const cjs = `
const { ConfigError, createEngine } = require("payfirewall");
const { memoryStorage, memoryVendors } = require("payfirewall/adapters/memory");
const { scriptedChallenger } = require("payfirewall/testing");
const { callTool, toAnthropicTools, toOpenAITools } = require("payfirewall/tools");
${scenario}
(async () => {
  await scenarioRun("CJS");
  for (const s of ${JSON.stringify(cjsSubpaths)}) {
    if (Object.keys(require(s)).length === 0) fail("CJS require " + s + " has no exports");
  }
  for (const s of ${JSON.stringify(RESOLVE_ONLY)}) require.resolve(s);
  console.log("  ✓ CJS: required ${cjsSubpaths.length} subpaths, resolved ${RESOLVE_ONLY.join(", ")}");
})().catch((err) => { console.error(err); process.exit(1); });
`;

const typesProbe = `
import { createEngine, type Verification } from "payfirewall";
import { memoryStorage, memoryVendors } from "payfirewall/adapters/memory";
import { humanApprovalChallenger } from "payfirewall";
import { toOpenAITools } from "payfirewall/tools";
import { createHttpClient } from "payfirewall/client";
import { createHandler } from "payfirewall/http";
import { createMcpServer } from "payfirewall-mcp";

const engine = createEngine({
  environment: "sandbox",
  storage: memoryStorage(),
  vendors: memoryVendors([]),
  challengers: [humanApprovalChallenger({ approvalBaseUrl: "https://example.com/approve", deliver: async () => {} })],
  secrets: { tokenPepper: "x".repeat(32) },
  payer: { name: "Acme" },
});
const decision: Verification["decision"] = "WAIT";
export const surface = [engine, decision, toOpenAITools(), createHttpClient({ baseUrl: "https://x", apiKey: "k" }),
  createHandler(engine, { authenticate: async () => null }), createMcpServer(engine)];
`;

let failed = false;
try {
  step("Build both packages");
  run("pnpm", ["--filter", "payfirewall", "run", "build"], { cwd: root });
  run("pnpm", ["--filter", "payfirewall-mcp", "run", "build"], { cwd: root });

  step("Check the engine's main entry has no framework, libsql or node: imports");
  for (const file of ["index.js", "index.cjs"]) {
    const src = readFileSync(join(engineDir, "dist", file), "utf8");
    const chunks = [...src.matchAll(/from\s+["'](\.\/[^"']+)["']|require\(["'](\.\/[^"']+)["']\)/g)].map((m) => m[1] ?? m[2]);
    const bodies = [src, ...chunks.map((c) => readFileSync(join(engineDir, "dist", c), "utf8"))];
    const bad = bodies.some((b) => /(?:from\s+|require\()["'](?:next|react|@libsql\/client|node:[^"']+)["']/.test(b));
    check(!bad, `dist/${file} and its chunks import nothing from next, react, @libsql/client or node:`);
  }

  step("Pack with pnpm (applies publishConfig and rewrites workspace:*)");
  mkdirSync(tarballs, { recursive: true });
  run("pnpm", ["pack", "--pack-destination", tarballs], { cwd: engineDir });
  run("pnpm", ["pack", "--pack-destination", tarballs], { cwd: mcpDir });
  const tgz = readdirSync(tarballs).filter((f) => f.endsWith(".tgz")).map((f) => join(tarballs, f));
  check(tgz.length === 2, `two tarballs in ${tarballs}`);
  const tgzOf = (name) => tgz.find((f) => new RegExp(`/${name}-\\d[^/]*\\.tgz$`).test(f));

  step("Lint the packages (publint) and their published types (attw, on the pnpm tarballs)");
  const devBin = (name) => join(engineDir, "node_modules/.bin", name);
  run(devBin("publint"), [], { cwd: engineDir });
  run(devBin("publint"), [], { cwd: mcpDir });
  // npm pack (what `attw --pack` uses) ignores publishConfig, so attw reads the pnpm tarballs instead.
  // node16 profile: node10 has no subpath exports. payfirewall-mcp is ESM-only.
  run(devBin("attw"), [tgzOf("payfirewall"), "--profile", "node16", "--format", "table-flipped"], { cwd: work });
  run(devBin("attw"), [tgzOf("payfirewall-mcp"), "--profile", "esm-only"], { cwd: work });
  check(true, "publint and attw report no problems");

  step(`Install the tarballs with npm in a fresh project (${project})`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "payfirewall-pack-smoke", private: true, version: "0.0.0" }, null, 2));
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tgz], { cwd: project });
  const mcpManifest = JSON.parse(readFileSync(join(project, "node_modules/payfirewall-mcp/package.json"), "utf8"));
  check(!String(mcpManifest.dependencies?.payfirewall).startsWith("workspace:"), `payfirewall-mcp depends on payfirewall@${mcpManifest.dependencies?.payfirewall}`);
  check(!existsSync(join(project, "node_modules/payfirewall/src")), "payfirewall tarball ships dist only");

  step("ESM consumer");
  writeFileSync(join(project, "smoke.mjs"), esm);
  run("node", ["smoke.mjs"], { cwd: project });

  step("CJS consumer");
  writeFileSync(join(project, "smoke.cjs"), cjs);
  run("node", ["smoke.cjs"], { cwd: project });

  step("TypeScript consumer (module node16)");
  writeFileSync(join(project, "types.mts"), typesProbe);
  const tsc = join(engineDir, "node_modules/.bin/tsc");
  run(tsc, ["--noEmit", "--strict", "--skipLibCheck", "--module", "node16", "--moduleResolution", "node16", "--target", "es2022", "--types", "node", "--typeRoots", join(engineDir, "node_modules/@types"), "types.mts"], { cwd: project });
  check(true, "types resolve for payfirewall, its subpaths and payfirewall-mcp");

  step("payfirewall-mcp bin");
  const bin = join(project, "node_modules/.bin/payfirewall-mcp");
  const help = run(bin, ["--help"], { cwd: project, capture: true });
  check(help.status === 0 && /Usage:/.test(help.stdout), "payfirewall-mcp --help exits 0 and prints usage");
  const env = { ...process.env };
  delete env.PAYFIREWALL_URL;
  delete env.PAYFIREWALL_API_KEY;
  const bare = run(bin, [], { cwd: project, capture: true, allowFailure: true, env, input: "" });
  check(bare.status === 2 && /no configuration/.test(bare.stderr) && bare.stdout === "", "without configuration it exits 2, stdout untouched");

  process.stdout.write("\n✓ pack smoke passed\n");
} catch (err) {
  failed = true;
  process.stderr.write(`\n✗ pack smoke failed: ${err instanceof Error ? err.message : String(err)}\n`);
} finally {
  rmSync(join(engineDir, "dist"), { recursive: true, force: true });
  rmSync(join(mcpDir, "dist"), { recursive: true, force: true });
  if (process.env.PACK_SMOKE_KEEP) process.stdout.write(`kept ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
