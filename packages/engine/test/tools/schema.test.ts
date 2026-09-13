import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage } from "../../src/adapters/memory";
import type { Receipt, Verification } from "../../src/core/types";
import { receiptSchema, toolDefinitions, verificationSchema, type JSONSchema7 } from "../../src/tools";
import { AGENT, APPROVER, clean, inlineProbe, poisoned, setup, spyRail } from "../core/helpers";
import { closed, compile, walkSchema } from "./helpers";

/** Drives real engines through every public state and rail outcome and returns what they produced. */
async function producedOutputs(): Promise<{ verifications: Verification[]; receipts: Receipt[] }> {
  const verifications: Verification[] = [];
  const receipts: Receipt[] = [];
  const keep = (v: Verification) => { verifications.push(v); return v; };

  // Clean gate match, no rail: PAY with recheck.
  const plain = setup();
  keep(await plain.engine.verify(clean()));
  receipts.push(await plain.engine.receipt("pay_18k"));

  // Mismatch -> challenge -> denied; plus block and no-channel quarantines.
  const deny = setup();
  keep(await deny.engine.verify(poisoned()));
  const opened = keep(await deny.engine.advance("pay_240k"));
  assert.equal(opened.state, "CHALLENGING");
  keep(await deny.engine.resolveChallenge({ challengeId: opened.challenge!.challengeId, verdict: "DENIED", responder: APPROVER }));
  receipts.push(await deny.engine.receipt("pay_240k"));
  keep(await deny.engine.verify(poisoned({ id: "pay_retry" })));
  keep(await deny.engine.verify(poisoned({ id: "pay_block", beneficiary: { accountLast4: "1111" } })));
  keep(await deny.engine.block("pay_block", { reason: "agent changed its mind" }));

  const noChannel = setup({ challengers: [], probes: [inlineProbe("rdap", [{ key: "probe_error", value: "rdap", source: "rdap", detail: "timeout" }])] });
  keep(await noChannel.engine.verify(poisoned()));
  keep(await noChannel.engine.advance("pay_240k"));

  // Rail: authorize -> released; failed release -> RETRY; drift -> DO_NOT_PAY.
  const storage = memoryStorage();
  const rail = spyRail(() => storage.ledger(), "9821");
  const railed = setup({ storage, rail });
  keep(await railed.engine.verify(poisoned()));
  keep(await railed.engine.advance("pay_240k"));
  const req = railed.starts.at(-1)!;
  keep(await railed.engine.resolveChallenge({ challengeId: req.challengeId, verdict: "AUTHORIZED", responderToken: req.responderToken }));
  receipts.push(await railed.engine.receipt("pay_240k"));

  rail.setBeneficiary("4471");
  rail.failNextRelease();
  keep(await railed.engine.verify(clean({ id: "pay_fail" }), { principal: AGENT }));
  const driftStorage = memoryStorage();
  const driftRail = spyRail(() => driftStorage.ledger(), "9821");
  const drift = setup({ storage: driftStorage, rail: driftRail });
  await drift.engine.verify(poisoned());
  await drift.engine.advance("pay_240k");
  const dreq = drift.starts.at(-1)!;
  driftRail.setBeneficiary("0000");
  keep(await drift.engine.resolveChallenge({ challengeId: dreq.challengeId, verdict: "AUTHORIZED", responderToken: dreq.responderToken }));

  return { verifications, receipts };
}

test("every produced Verification and Receipt validates against the output schemas, including with objects closed", async () => {
  const { verifications, receipts } = await producedOutputs();
  const decisions = new Set(verifications.map((v) => `${v.state}/${v.decision}/${v.nextActions[0].type}`));
  for (const expected of ["CLEARED/PAY/PAY", "CHALLENGING/WAIT/POLL", "PENDING_REVIEW/WAIT/POLL", "QUARANTINED/DO_NOT_PAY/DO_NOT_PAY", "CLEARED/PAY/RETRY", "CLEARED/DO_NOT_PAY/DO_NOT_PAY"]) {
    assert.ok(decisions.has(expected), `scenario ${expected} not covered: ${[...decisions].join(", ")}`);
  }

  const outputs = [verificationSchema, closed(verificationSchema)].map(compile);
  for (const v of verifications) {
    for (const validate of outputs) {
      const r = validate(v);
      assert.ok(r.ok, `${v.paymentId} ${v.state}: ${r.errors}`);
    }
  }
  const receiptValidators = [receiptSchema, closed(receiptSchema)].map(compile);
  for (const receipt of receipts) {
    for (const validate of receiptValidators) {
      const r = validate(receipt);
      assert.ok(r.ok, `receipt ${receipt.incidentId}: ${r.errors}`);
    }
  }

  const getOutput = compile(toolDefinitions.find((d) => d.name === "get_verification")!.outputSchema);
  assert.ok(getOutput(verifications[0]).ok);
  assert.ok(getOutput({ verification: receipts[0].verification, receipt: receipts[0] }).ok);
  assert.ok(!getOutput({ verification: receipts[0].verification }).ok);
});

test("the output schema rejects a Verification missing a required field or carrying an unknown decision", async () => {
  const { verifications } = await producedOutputs();
  const validate = compile(verificationSchema);
  const missing: Partial<Verification> = { ...verifications[0] };
  delete missing.nextActions;
  assert.ok(!validate(missing).ok);
  assert.ok(!validate({ ...verifications[0], decision: "MAYBE" }).ok);
  assert.ok(!validate({ ...verifications[0], nextActions: [{ type: "APPROVE" }] }).ok);
});

test("exactly three requester tools with the §5.1 annotations", () => {
  assert.deepEqual(toolDefinitions.map((d) => d.name), ["verify_payment", "get_verification", "block_payment"]);
  const byName = Object.fromEntries(toolDefinitions.map((d) => [d.name, d]));
  assert.deepEqual(byName.verify_payment.annotations, { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true });
  assert.deepEqual(byName.get_verification.annotations, { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(byName.block_payment.annotations, { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false });
  assert.match(byName.verify_payment.description, /^Call BEFORE sending any vendor payment\./);
  for (const d of toolDefinitions) assert.equal(d.outputSchema.type, "object");
});

test("no tool schema carries an approving verdict value or a token field", () => {
  const text = JSON.stringify(toolDefinitions);
  assert.ok(!text.includes("AUTHORIZED"), "AUTHORIZED appears in a tool schema");
  for (const d of toolDefinitions) {
    for (const schema of [d.inputSchema, d.outputSchema]) {
      walkSchema(schema, (s, at) => {
        for (const key of Object.keys(s.properties ?? {})) assert.ok(!/token/i.test(key), `token-like field ${key} at ${at}`);
      });
    }
  }
});

test("every inputSchema rejects extra properties at every object level", () => {
  const extras: Record<string, unknown[]> = {
    verify_payment: [
      { payment: clean(), extra: 1 },
      { payment: { ...clean(), extra: 1 } },
      { payment: { ...clean(), beneficiary: { accountLast4: "4471", extra: 1 } } },
      { payment: clean(), responderToken: "t" },
    ],
    get_verification: [{ paymentId: "pay_1", extra: true }, { paymentId: "pay_1", verdict: "DENIED" }],
    block_payment: [{ paymentId: "pay_1", reason: "fraud", principal: AGENT }],
  };
  for (const d of toolDefinitions) {
    const validate = compile(d.inputSchema);
    walkSchema(d.inputSchema, (s, at) => {
      if (s.type === "object") assert.equal(s.additionalProperties, false, `${d.name} ${at} is open`);
    });
    for (const bad of extras[d.name]) assert.ok(!validate(bad).ok, `${d.name} accepted ${JSON.stringify(bad)}`);
  }
  assert.ok(compile(toolDefinitions[0].inputSchema)({ payment: poisoned(), waitMs: 0 }).ok);
});

test("input schemas mirror the engine's runtime rules", () => {
  const verify = compile(toolDefinitions[0].inputSchema);
  const cases: Array<[unknown, boolean]> = [
    [{ payment: clean({ amountCents: 0 }) }, false],
    [{ payment: clean({ amountCents: 1.5 }) }, false],
    [{ payment: clean({ id: "has|pipe" }) }, false],
    [{ payment: clean({ memo: "x".repeat(281) }) }, false],
    [{ payment: clean(), waitMs: 25_001 }, false],
    [{ payment: clean({ currency: "EUR" as "USD" }) }, false],
    [{ payment: clean({ beneficiary: { accountLast4: "4471", accountNumber: "0000004471", routingNumber: "021000021" } }) }, true],
  ];
  for (const [args, ok] of cases) assert.equal(verify(args).ok, ok, JSON.stringify(args));
  const schema: JSONSchema7 = toolDefinitions[2].inputSchema;
  assert.ok(!compile(schema)({ paymentId: "pay_1", reason: "no" }).ok);
});
