import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NextAction, PaymentInput, Receipt, Verification } from "payfirewall";
import { connectedScenario, poisoned, postResult } from "./helpers";

// §7.3: a headless agent that knows nothing about the engine. It calls verify_payment once and then does
// nextActions[0], literally, until the action is terminal for the agent (PAY or stop).

interface ToolCall { structured: Record<string, unknown>; text: string; isError: boolean }

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCall> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  assert.equal(content.length, 1, "one text block per result");
  return { structured: res.structuredContent as Record<string, unknown>, text: content[0].text ?? "", isError: res.isError === true };
}

/** Every key under any `properties` object, at any depth. */
function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(propertyNames);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "properties" && typeof child === "object" && child !== null
      ? [...Object.keys(child), ...propertyNames(Object.values(child))]
      : propertyNames(child));
}

interface AgentRun {
  outcome: "PAID" | "STOPPED";
  last: NextAction;
  final: ToolCall;
  transcript: string[];
}

async function runAgent(client: Client, payment: PaymentInput, betweenCalls: () => Promise<void> = async () => {}): Promise<AgentRun> {
  const transcript: string[] = [];
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const r = await callTool(client, name, args);
    transcript.push(`${name} -> ${r.text}`);
    return r;
  };

  let res = await invoke("verify_payment", { payment });
  for (let turn = 0; turn < 25; turn++) {
    const body = res.isError
      ? (res.structured.error as { nextActions: NextAction[] })
      : ((res.structured.verification ?? res.structured) as Verification);
    const next = body.nextActions[0];
    switch (next.type) {
      case "POLL":
        // afterMs is honored as a bound, not a wall-clock wait: the long-poll itself returns on change.
        await new Promise((r) => setTimeout(r, Math.min(next.afterMs, 5)));
        await betweenCalls();
        res = await invoke(next.tool, next.args);
        break;
      case "RETRY":
        await betweenCalls();
        res = await invoke(next.tool, next.args);
        break;
      case "PAY": {
        const recheck = await invoke(next.recheck.tool, next.recheck.args);
        const v = recheck.structured as unknown as Verification;
        const safe = !recheck.isError && v.decision === "PAY"
          && next.recheck.expect.amountCents === payment.amountCents
          && next.recheck.expect.beneficiaryLast4 === payment.beneficiary.accountLast4
          && v.beneficiary.last4 === next.recheck.expect.beneficiaryLast4;
        return { outcome: safe ? "PAID" : "STOPPED", last: next, final: recheck, transcript };
      }
      case "DO_NOT_PAY":
      case "ESCALATE_TO_HUMAN":
      case "AWAIT_OUT_OF_BAND":
        return { outcome: "STOPPED", last: next, final: res, transcript };
    }
  }
  throw new Error(`agent did not settle:\n${transcript.join("\n")}`);
}

test("listTools returns exactly the three requester tools, with no approving verdict or token field", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["verify_payment", "get_verification", "block_payment"]);
  const text = JSON.stringify(tools);
  assert.ok(!text.includes("AUTHORIZED"), "a tool schema advertises AUTHORIZED");
  assert.deepEqual(propertyNames(tools).filter((key) => /token/i.test(key)), [], "a tool schema has a token field");
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema?.type, "object");
  }
});

test("deny path: WAIT then POLL, approver denies on the result route, agent stops with VENDOR_DENIED_CHANGE and a 6-event chain", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);

  const first = await callTool(s.client, "verify_payment", { payment: poisoned() });
  const v1 = first.structured as unknown as Verification;
  assert.deepEqual([first.isError, v1.decision, v1.nextActions[0].type], [false, "WAIT", "POLL"]);
  assert.equal(first.text, `decision=WAIT reason=${v1.reason} next=POLL`);

  let denial: { status: number; json: Verification } | undefined;
  const run = await runAgent(s.client, poisoned(), async () => {
    const link = s.links[0];
    if (!link || denial) return;
    assert.ok(!link.summary.includes("9821"), "the approver message must not reveal the claimed account");
    denial = await postResult(s.handler, link, {
      verdict: "DENIED", answers: { authorizedChange: "no" }, evidence: { transcript: "controller: we changed nothing" },
    }, { token: true, session: true });
  });

  assert.equal(denial?.status, 200);
  assert.equal(run.outcome, "STOPPED");
  assert.deepEqual(run.last, { type: "DO_NOT_PAY", reason: "VENDOR_DENIED_CHANGE", terminal: true });
  const final = run.final.structured as unknown as Verification;
  assert.deepEqual([final.state, final.decision, final.reason, final.terminal], ["QUARANTINED", "DO_NOT_PAY", "VENDOR_DENIED_CHANGE", true]);
  assert.equal(final.nextActions[1].type, "ESCALATE_TO_HUMAN");
  assert.equal(final.challenge?.resolvedBy, "human:controller-desk");
  assert.equal(run.final.text, "decision=DO_NOT_PAY reason=VENDOR_DENIED_CHANGE next=DO_NOT_PAY");
  assert.ok(run.transcript.some((line) => line.includes("reason=AWAITING_OUT_OF_BAND_CONFIRMATION")), run.transcript.join("\n"));

  assert.equal(final.proof.ledgerLength, 6);
  const read = await s.client.readResource({ uri: "payfirewall://verifications/pay_240k/receipt" });
  const receipt = JSON.parse((read.contents[0] as { text: string }).text) as Receipt;
  assert.deepEqual(receipt.entries.map((e) => e.event), [
    "INTERCEPTED", "INVESTIGATION_STARTED", "FORENSICS", "CHALLENGE_STARTED", "CALL_RESULT", "FROZEN",
  ]);
  assert.deepEqual([receipt.chain.ok, receipt.chain.length, receipt.headHash], [true, 6, final.proof.ledgerHeadHash]);
  const verificationRead = await s.client.readResource({ uri: "payfirewall://verifications/pay_240k" });
  for (const surface of [read, verificationRead, run.transcript, run.final.structured]) {
    assert.ok(!JSON.stringify(surface).includes(s.links[0].token), "the responder token leaked through MCP");
  }
});

test("authorize path: responder token with the correct read-back gives PAY and the agent's recheck confirms it", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);

  let approval: { status: number; json: Verification } | undefined;
  const run = await runAgent(s.client, poisoned(), async () => {
    const link = s.links[0];
    if (!link || approval) return;
    approval = await postResult(s.handler, link, {
      verdict: "AUTHORIZED", answers: { authorizedChange: "yes", beneficiaryLast4ReadBack: "9821", amountConfirmed: true },
    }, { token: true });
  });

  assert.deepEqual([approval?.status, approval?.json.decision], [200, "PAY"]);
  assert.equal(run.outcome, "PAID", run.transcript.join("\n"));
  assert.equal(run.last.type, "PAY");
  const final = run.final.structured as unknown as Verification;
  assert.deepEqual([final.state, final.reason, final.mayRelease, final.challenge?.resolvedBy], ["CLEARED", "VENDOR_CONFIRMED_CHANGE", true, "channel:human_approval"]);
  assert.equal(run.final.text, "decision=PAY reason=VENDOR_CONFIRMED_CHANGE next=PAY");
});

test("retry with a different beneficiary gets IDEMPOTENCY_CONFLICT as an MCP error with structured nextActions", async (t) => {
  const s = await connectedScenario();
  t.after(s.close);

  const first = await callTool(s.client, "verify_payment", { payment: poisoned() });
  assert.equal(first.isError, false);

  const run = await runAgent(s.client, poisoned({ beneficiary: { accountLast4: "1234" } }));
  assert.equal(run.outcome, "STOPPED");
  assert.equal(run.final.isError, true);
  const error = run.final.structured.error as { code: string; retryable: boolean; nextActions: NextAction[] };
  assert.equal(error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(error.retryable, false);
  assert.deepEqual([error.nextActions[0].type, (error.nextActions[0] as { reason?: string }).reason], ["DO_NOT_PAY", "BENEFICIARY_CHANGED"]);
  assert.equal(error.nextActions[1].type, "ESCALATE_TO_HUMAN");
  assert.equal(run.final.text, "error=IDEMPOTENCY_CONFLICT retryable=false next=DO_NOT_PAY");
  assert.equal(s.links.length, 0, "the conflicting request never reaches the approver");
});
