import assert from "node:assert/strict";
import { test } from "node:test";
import type { Verification } from "../../src/core/types";
import {
  STRICT_UNSUPPORTED_KEYWORDS, toAiSdkTools, toAnthropicTools, toOpenAITools, toStrictSchema, toolDefinitions, type JSONSchema7,
} from "../../src/tools";
import { OPERATOR, clean, poisoned, setup } from "../core/helpers";
import { compile, walkSchema } from "./helpers";

test("OpenAI strict lint: closed objects, every property required, no unsupported keyword or composition", () => {
  const tools = toOpenAITools();
  assert.deepEqual(tools.map((t) => t.function.name), ["verify_payment", "get_verification", "block_payment"]);
  for (const t of tools) {
    assert.equal(t.type, "function");
    assert.equal(t.function.strict, true);
    walkSchema(t.function.parameters, (s, at) => {
      const where = `${t.function.name} ${at}`;
      if (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object")) || s.properties) {
        assert.equal(s.additionalProperties, false, `${where} is not closed`);
        assert.deepEqual([...(s.required ?? [])].sort(), Object.keys(s.properties ?? {}).sort(), `${where} has optional properties`);
      }
      for (const keyword of [...STRICT_UNSUPPORTED_KEYWORDS, "oneOf", "allOf", "$ref"]) {
        assert.ok(!(keyword in s), `${where} still has ${keyword}`);
      }
    });
  }
});

test("the strict transform makes optionals nullable, restates removed keywords, and never mutates the definitions", () => {
  const before = JSON.stringify(toolDefinitions);
  const get = toOpenAITools().find((t) => t.function.name === "get_verification")!.function.parameters;
  assert.deepEqual(get.properties!.paymentId.type, "string");
  assert.deepEqual(get.properties!.waitMs.type, ["integer", "null"]);
  assert.match(get.properties!.waitMs.description!, /\(default 10000; min 0; max 25000\)$/);
  assert.deepEqual(get.properties!.includeReceipt.type, ["boolean", "null"]);

  const verify = toOpenAITools()[0].function.parameters;
  const payment = verify.properties!.payment;
  assert.equal(payment.properties!.currency.type, "string", "required enum stays non-null");
  assert.deepEqual(payment.properties!.memo.type, ["string", "null"]);
  assert.match(payment.properties!.memo.description!, /max length 280/);
  assert.equal(payment.properties!.id.pattern, undefined);
  assert.match(payment.properties!.id.description!, /\(pattern "\^\[A-Za-z0-9_-\]\{1,128\}\$"\)$/);

  const enumSchema: JSONSchema7 = { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } };
  assert.deepEqual(toStrictSchema(enumSchema).properties!.mode, { type: ["string", "null"], enum: ["a", "b", null] });
  assert.equal(JSON.stringify(toolDefinitions), before);
  assert.ok(Object.isFrozen(toolDefinitions[0].inputSchema.properties!.payment));
});

test("a strict-mode call (nulls for every optional) validates against the strict schema and succeeds through callTool", async () => {
  const s = setup();
  const strictVerify = compile(toOpenAITools()[0].function.parameters);
  const args = {
    payment: {
      ...clean(), invoiceContactPhone: null, memo: null,
      beneficiary: { accountLast4: "4471", accountNumber: null, routingNumber: null, railCounterpartyId: null },
    },
    waitMs: null,
  };
  assert.ok(strictVerify(args).ok, strictVerify(args).errors);
  const tools = toAiSdkTools(s.engine);
  const r = await tools.verify_payment.execute(args);
  assert.ok(r.ok);
});

test("toAnthropicTools uses the original schemas as independent copies", () => {
  const tools = toAnthropicTools();
  assert.deepEqual(tools.map((t) => t.name), toolDefinitions.map((d) => d.name));
  tools.forEach((t, i) => {
    assert.equal(t.description, toolDefinitions[i].description);
    assert.deepEqual(t.input_schema, toolDefinitions[i].inputSchema);
    assert.notEqual(t.input_schema, toolDefinitions[i].inputSchema);
  });
  assert.equal(tools[1].input_schema.properties!.waitMs.default, 10000);
});

test("toAiSdkTools returns AI SDK compatible tools bound to the api and principal", async () => {
  const s = setup();
  const tools = toAiSdkTools(s.engine, { principal: OPERATOR });
  assert.deepEqual(Object.keys(tools), ["verify_payment", "get_verification", "block_payment"]);
  const { inputSchema } = tools.verify_payment;
  assert.equal((inputSchema as unknown as Record<symbol, unknown>)[Symbol.for("vercel.ai.schema")], true);
  assert.deepEqual(inputSchema.jsonSchema, toolDefinitions[0].inputSchema);
  assert.equal(inputSchema.validate({ payment: poisoned() }).success, true);
  const bad = inputSchema.validate({ payment: poisoned(), principal: OPERATOR });
  assert.equal(bad.success, false);

  const r = await tools.verify_payment.execute({ payment: poisoned() });
  assert.ok(r.ok);
  assert.equal((r.result as Verification).requestedBy, OPERATOR.id);
  const blocked = await tools.block_payment.execute({ paymentId: "pay_240k", reason: "suspected fraud" });
  assert.ok(blocked.ok);
  assert.equal((blocked.result as Verification).decision, "DO_NOT_PAY");
});
