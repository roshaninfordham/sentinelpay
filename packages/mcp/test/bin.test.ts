import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Verification } from "@sentinelpay/engine";
import { resolveLaunch, UsageError } from "../src/config";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const EMBEDDED_CONFIG = fileURLToPath(new URL("./fixtures/sentinelpay.config.ts", import.meta.url));
/** Runs the TypeScript bin with the same tsx loader as this test process. */
const nodeArgs = () => [...process.execArgv.filter((a) => !a.startsWith("--test")), BIN];

test("resolveLaunch picks remote or embedded mode and refuses anything ambiguous or incomplete", () => {
  const remote = { SENTINELPAY_URL: "https://sentinelpay.example/api/v1", SENTINELPAY_API_KEY: "sk_test" };
  assert.deepEqual(resolveLaunch([], remote), { mode: "remote", url: remote.SENTINELPAY_URL, apiKey: "sk_test" });
  assert.deepEqual(resolveLaunch([], { SENTINELPAY_URL: "http://localhost:3000/api/v1", SENTINELPAY_API_KEY: "k" }).mode, "remote");
  assert.deepEqual(resolveLaunch(["--config", "./sentinelpay.config.mjs"], {}), { mode: "embedded", configPath: "./sentinelpay.config.mjs" });
  assert.deepEqual(resolveLaunch(["--config=cfg.mjs"], {}), { mode: "embedded", configPath: "cfg.mjs" });
  assert.deepEqual(resolveLaunch(["--help"], {}), { mode: "help" });

  const refuses = (argv: string[], env: Record<string, string>, message: RegExp) =>
    assert.throws(() => resolveLaunch(argv, env), (err: unknown) => err instanceof UsageError && message.test(err.message));
  refuses([], {}, /no configuration/);
  refuses([], { SENTINELPAY_URL: remote.SENTINELPAY_URL }, /needs both/);
  refuses([], { SENTINELPAY_API_KEY: "sk_test" }, /needs both/);
  refuses([], { SENTINELPAY_URL: "  ", SENTINELPAY_API_KEY: "sk_test" }, /needs both/);
  refuses([], { SENTINELPAY_URL: "http://sentinelpay.example/api/v1", SENTINELPAY_API_KEY: "k" }, /https/);
  refuses([], { SENTINELPAY_URL: "not a url", SENTINELPAY_API_KEY: "k" }, /not a valid URL/);
  refuses(["--config", "cfg.mjs"], remote, /not both/);
  refuses(["--config"], {}, /needs a module path/);
  refuses(["--config", "--help"], {}, /needs a module path/);
  refuses(["--verbose"], {}, /unknown argument/);
});

test("the bin exits non-zero without configuration and never starts the server", () => {
  const env = { ...process.env };
  delete env.SENTINELPAY_URL;
  delete env.SENTINELPAY_API_KEY;
  const run = spawnSync(process.execPath, nodeArgs(), {
    env, input: "", encoding: "utf8", timeout: 20_000,
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /no configuration/);
  assert.equal(run.stdout, "", "stdout is reserved for the MCP protocol");
  assert.doesNotMatch(run.stderr, /ready/);
});

test("embedded mode over stdio: verify then block reaches DO_NOT_PAY", async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [...nodeArgs(), "--config", EMBEDDED_CONFIG], stderr: "pipe" });
  const client = new Client({ name: "stdio-smoke", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["verify_payment", "get_verification", "block_payment"]);

  const payment = {
    id: "pay_stdio", vendorId: "v_meridian", amountCents: 24_000_000, currency: "USD",
    beneficiary: { accountLast4: "9821" }, requestSourceDomain: "meridian-global.co",
  };
  const verified = await client.callTool({ name: "verify_payment", arguments: { payment } });
  const v = verified.structuredContent as unknown as Verification;
  assert.deepEqual([verified.isError ?? false, v.decision, v.requestedBy], [false, "WAIT", "agent:stdio-smoke"]);

  const blocked = await client.callTool({ name: "block_payment", arguments: { paymentId: "pay_stdio", reason: "suspected BEC" } });
  const b = blocked.structuredContent as unknown as Verification;
  assert.deepEqual([b.decision, b.reason, b.terminal], ["DO_NOT_PAY", "BLOCKED_BY_PRINCIPAL", true]);
  assert.equal((blocked.content as Array<{ text: string }>)[0].text, "decision=DO_NOT_PAY reason=BLOCKED_BY_PRINCIPAL next=DO_NOT_PAY");
});
