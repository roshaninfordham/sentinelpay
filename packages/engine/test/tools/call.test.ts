import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage } from "../../src/adapters/memory";
import type { SentinelPay, Storage, Verification } from "../../src/core/types";
import { callTool, type ToolResult } from "../../src/tools";
import { AGENT, OPERATOR, clean, poisoned, setup } from "../core/helpers";

const errorOf = (r: ToolResult) => {
  assert.equal(r.ok, false, `expected an error, got ${JSON.stringify(r)}`);
  return (r as Extract<ToolResult, { ok: false }>).error;
};
const resultOf = (r: ToolResult) => {
  assert.equal(r.ok, true, `expected success, got ${JSON.stringify(r)}`);
  return (r as Extract<ToolResult, { ok: true }>).result;
};

/** memoryStorage whose every operation can be switched to fail with a raw adapter error. */
function flakyStorage() {
  const inner = memoryStorage();
  let down = false;
  const guard = <T>(fn: () => Promise<T>) => (down ? Promise.reject(new Error("ECONNREFUSED 10.0.0.7:5432")) : fn());
  const storage: Storage = {
    load: (k) => guard(() => inner.load(k)),
    commit: (n, v, e) => guard(() => inner.commit(n, v, e)),
    ledger: (o) => guard(() => inner.ledger(o)),
    list: (f) => guard(() => inner.list(f)),
  };
  return { storage, setDown: (v: boolean) => { down = v; } };
}

test("verify_payment succeeds with the principal from context, never from arguments", async () => {
  const s = setup();
  const v = resultOf(await callTool(s.engine, "verify_payment", { payment: poisoned() }, { principal: OPERATOR })) as Verification;
  assert.equal(v.decision, "WAIT");
  assert.equal(v.requestedBy, OPERATOR.id);
});

test("INVALID_INPUT carries a JSON pointer to the offending field", async () => {
  const s = setup();
  const cases: Array<[string, unknown, string]> = [
    ["verify_payment", { payment: clean({ beneficiary: { accountLast4: "44" } }) }, "/payment/beneficiary/accountLast4"],
    ["verify_payment", { payment: { ...clean(), vendorId: undefined } }, "/payment/vendorId"],
    ["verify_payment", { payment: { ...clean(), extra: "x" } }, "/payment/extra"],
    ["verify_payment", { payment: clean(), waitMs: 25_001 }, "/waitMs"],
    ["verify_payment", {}, "/payment"],
    ["get_verification", { paymentId: "bad id" }, "/paymentId"],
    ["block_payment", { paymentId: "pay_1", reason: "no" }, "/reason"],
    ["block_payment", { paymentId: "pay_1" }, "/reason"],
  ];
  for (const [name, args, path] of cases) {
    const error = errorOf(await callTool(s.engine, name, args));
    assert.equal(error.code, "INVALID_INPUT", `${name} ${JSON.stringify(args)}`);
    assert.equal(error.path, path, `${name} ${JSON.stringify(args)}`);
    assert.equal(error.retryable, false);
    assert.equal(error.nextActions[0].type, "DO_NOT_PAY");
  }
});

test("identity fields in arguments are refused by name, at any depth, even when null", async () => {
  const s = setup();
  const cases: Array<[string, unknown, string]> = [
    ["verify_payment", { payment: clean(), principal: OPERATOR }, "/principal"],
    ["verify_payment", { payment: { ...clean(), requestedBy: "human:ops" } }, "/payment/requestedBy"],
    ["block_payment", { paymentId: "pay_18k", reason: "fraud", resolvedBy: "human:ops" }, "/resolvedBy"],
    ["get_verification", { paymentId: "pay_18k", resolvedBy: null }, "/resolvedBy"],
  ];
  for (const [name, args, path] of cases) {
    const error = errorOf(await callTool(s.engine, name, args));
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(error.path, path);
  }
  assert.equal((await s.storage.ledger()).length, 0, "no refused call reached the engine");
});

test("null is normalized to absent before validation (OpenAI strict mode)", async () => {
  const s = setup();
  const payment = { ...clean(), invoiceContactPhone: null, memo: null, beneficiary: { accountLast4: "4471", accountNumber: null, routingNumber: null, railCounterpartyId: null } };
  const v = resultOf(await callTool(s.engine, "verify_payment", { payment, waitMs: null })) as Verification;
  assert.equal(v.decision, "PAY");
  assert.equal(v.untrusted.memo, undefined);
  const got = resultOf(await callTool(s.engine, "get_verification", { paymentId: "pay_18k", waitMs: 0, sinceVersion: null, includeReceipt: null })) as Verification;
  assert.equal(got.object, "verification");
});

test("unknown tool names and non-object arguments are INVALID_INPUT, and callTool never throws", async () => {
  const s = setup();
  assert.equal(errorOf(await callTool(s.engine, "submit_challenge_result", { verdict: "AUTHORIZED" })).code, "INVALID_INPUT");
  assert.equal(errorOf(await callTool(s.engine, "verify_payment", "not an object")).code, "INVALID_INPUT");
  assert.equal(errorOf(await callTool(s.engine, "verify_payment", [1, 2])).code, "INVALID_INPUT");
});

test("engine errors map to the §5.2 contract", async () => {
  const s = setup();
  const unknownVendor = errorOf(await callTool(s.engine, "verify_payment", { payment: clean({ vendorId: "v_ghost" }) }));
  assert.deepEqual({ code: unknownVendor.code, path: unknownVendor.path, retryable: unknownVendor.retryable }, { code: "VENDOR_UNKNOWN", path: "/payment/vendorId", retryable: false });

  resultOf(await callTool(s.engine, "verify_payment", { payment: poisoned() }));
  const conflict = errorOf(await callTool(s.engine, "verify_payment", { payment: poisoned({ beneficiary: { accountLast4: "0001" } }) }));
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(conflict.nextActions.map((a) => a.type), ["DO_NOT_PAY", "ESCALATE_TO_HUMAN"]);
  assert.deepEqual(conflict.nextActions[0], { type: "DO_NOT_PAY", reason: "BENEFICIARY_CHANGED", terminal: false });

  const hidden = errorOf(await callTool(s.engine, "get_verification", { paymentId: "pay_240k", waitMs: 0 }, { principal: { id: "agent:other", kind: "agent", roles: ["requester"] } }));
  assert.equal(hidden.code, "NOT_FOUND");
  assert.equal(hidden.path, undefined);
  assert.ok(!("path" in hidden), "path is omitted when absent");
});

test("storage outages are retryable DO_NOT_PAY errors with RETRY or POLL, never PAY", async () => {
  const flaky = flakyStorage();
  const s = setup({ storage: flaky.storage });
  resultOf(await callTool(s.engine, "verify_payment", { payment: clean() }, { principal: AGENT }));
  flaky.setDown(true);

  const verify = errorOf(await callTool(s.engine, "verify_payment", { payment: clean() }));
  assert.equal(verify.code, "STORAGE_UNAVAILABLE");
  assert.equal(verify.retryable, true);
  assert.deepEqual(verify.nextActions.map((a) => a.type), ["DO_NOT_PAY", "RETRY"]);

  const get = errorOf(await callTool(s.engine, "get_verification", { paymentId: "pay_18k", waitMs: 0 }));
  assert.deepEqual(get.nextActions.map((a) => a.type), ["DO_NOT_PAY", "POLL"]);
  assert.ok(!JSON.stringify([verify, get]).includes("ECONNREFUSED"), "adapter internals leaked");
});

test("a non-engine failure from the api is reported as a retryable outage without its message", async () => {
  const broken: SentinelPay = {
    verify: async () => { throw new Error("db password is hunter2"); },
    get: async () => { throw new TypeError("boom"); },
    block: async () => { throw "string thrown"; },
    receipt: async () => { throw null; },
  };
  for (const [name, args] of [["verify_payment", { payment: clean() }], ["get_verification", { paymentId: "p" }], ["block_payment", { paymentId: "p", reason: "fraud" }]] as const) {
    const error = errorOf(await callTool(broken, name, args));
    assert.equal(error.code, "STORAGE_UNAVAILABLE");
    assert.equal(error.retryable, true);
    assert.equal(error.nextActions[0].type, "DO_NOT_PAY");
    assert.ok(!error.message.includes("hunter2"));
  }
});

test("get_verification with includeReceipt returns both; block_payment freezes and replays unchanged", async () => {
  const s = setup();
  resultOf(await callTool(s.engine, "verify_payment", { payment: poisoned() }));
  const both = resultOf(await callTool(s.engine, "get_verification", { paymentId: "pay_240k", waitMs: 0, includeReceipt: true })) as { verification: Verification; receipt: { entries: unknown[] } };
  assert.equal(both.verification.paymentId, "pay_240k");
  assert.ok(both.receipt.entries.length >= 1);

  const blocked = resultOf(await callTool(s.engine, "block_payment", { paymentId: "pay_240k", reason: "looks like BEC" })) as Verification;
  assert.equal(blocked.decision, "DO_NOT_PAY");
  assert.equal(blocked.reason, "BLOCKED_BY_PRINCIPAL");
  const again = resultOf(await callTool(s.engine, "block_payment", { paymentId: "pay_240k", reason: "again" })) as Verification;
  assert.equal(again.version, blocked.version);
});

test("the responder token never appears in any tool result", async () => {
  const s = setup();
  const outputs: ToolResult[] = [];
  outputs.push(await callTool(s.engine, "verify_payment", { payment: poisoned() }));
  await s.engine.advance("pay_240k");
  const token = s.starts.at(-1)!.responderToken;
  outputs.push(await callTool(s.engine, "get_verification", { paymentId: "pay_240k", waitMs: 0, includeReceipt: true }));
  outputs.push(await callTool(s.engine, "block_payment", { paymentId: "pay_240k", reason: "stop it" }));
  outputs.push(await callTool(s.engine, "get_verification", { paymentId: "pay_240k", waitMs: 0, includeReceipt: true }));
  assert.ok(!JSON.stringify(outputs).includes(token));
});
