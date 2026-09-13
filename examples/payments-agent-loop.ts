// Reference loop for Agent 2, the requester/payments agent (docs/AGENTS.md). It drives PayFirewall only through the
// requester tools (callTool: the same surface MCP and function calling expose) and only from nextActions, with a
// deterministic policy and no LLM. An LLM-driven agent must behave exactly like `decide` below; the evals in
// evals/payments-agent.test.ts hold this loop to that contract.
import type { NextAction, PayFirewall, PaymentInput, Principal, Verification } from "payfirewall";
import { callTool, type ToolResult } from "payfirewall/tools";

export type Outcome =
  | { status: "PAID"; paymentId: string; reference: string; reason: string }
  | { status: "PAID_BY_RAIL"; paymentId: string; railReference: string; reason: string }
  | { status: "NOT_PAID"; paymentId: string; reason: string; escalation?: string };

/** What the policy does next. Pure data, so the policy can be tested without an engine. */
export type Step =
  | { kind: "call"; tool: "get_verification" | "verify_payment"; args: Record<string, unknown>; afterMs: number; why: string }
  | { kind: "recheck_then_pay"; args: Record<string, unknown>; expect: { amountCents: number; beneficiaryLast4: string }; railReference?: string }
  | { kind: "stop"; reason: string; escalation?: string };

const MAX_RETRIES = 3;

/**
 * The whole policy: do nextActions[0], and treat anything unrecognized as DO_NOT_PAY. `retries` counts RETRY steps
 * already taken, so a persistently failing rail or store ends in escalation instead of a loop.
 */
export function decide(result: ToolResult, retries = 0): Step {
  if (!result.ok) {
    const first = result.error.nextActions[0];
    // Errors never say PAY. A RETRY or POLL behind the leading DO_NOT_PAY is followed only when the error is retryable.
    const follow = result.error.retryable ? result.error.nextActions.find((a) => a.type === "RETRY" || a.type === "POLL") : undefined;
    if (follow && retries < MAX_RETRIES) return fromAction(follow, retries);
    return { kind: "stop", reason: `${result.error.code}${first?.type === "DO_NOT_PAY" ? ` (${first.reason})` : ""}`, escalation: result.error.message };
  }
  const v = verificationOf(result);
  const action = v.nextActions[0];
  if (!action) return { kind: "stop", reason: `no nextActions (${v.reason})` };
  // Belt and braces: the only path to money is decision PAY with a PAY action. Anything else stops.
  if (action.type === "PAY" && v.decision !== "PAY") return { kind: "stop", reason: `PAY action with decision ${v.decision}` };
  return fromAction(action, retries, v);
}

function fromAction(action: NextAction, retries: number, v?: Verification): Step {
  switch (action.type) {
    case "POLL":
      return { kind: "call", tool: "get_verification", args: { ...action.args }, afterMs: action.afterMs, why: v?.reason ?? "poll" };
    case "AWAIT_OUT_OF_BAND":
      // Never first in practice (POLL precedes it), but if it is: keep waiting on the same payment.
      return v
        ? { kind: "call", tool: "get_verification", args: { paymentId: v.paymentId, waitMs: 10_000, sinceVersion: v.version }, afterMs: 1000, why: `awaiting ${action.channel}` }
        : { kind: "stop", reason: "AWAIT_OUT_OF_BAND without a verification" };
    case "RETRY":
      return retries < MAX_RETRIES
        ? { kind: "call", tool: "verify_payment", args: { ...action.args }, afterMs: action.afterMs, why: action.reason }
        : { kind: "stop", reason: `${action.reason} after ${MAX_RETRIES} retries`, escalation: "Retries exhausted. A person must investigate." };
    case "PAY":
      return { kind: "recheck_then_pay", args: { ...action.recheck.args }, expect: { ...action.recheck.expect }, ...(action.railReference ? { railReference: action.railReference } : {}) };
    case "DO_NOT_PAY":
      return { kind: "stop", reason: action.reason };
    case "ESCALATE_TO_HUMAN":
      return { kind: "stop", reason: action.reason, escalation: action.message };
    default:
      return { kind: "stop", reason: `unknown nextAction ${(action as { type?: unknown }).type} treated as DO_NOT_PAY` };
  }
}

function verificationOf(result: Extract<ToolResult, { ok: true }>): Verification {
  const r = result.result as Verification | { verification: Verification };
  return "verification" in r ? r.verification : r;
}

/** The recheck must still say PAY and describe exactly the payment this agent intends to send. */
export function recheckAllowsPayment(recheck: ToolResult, expect: { amountCents: number; beneficiaryLast4: string }, intended: PaymentInput): string | null {
  if (!recheck.ok) return `recheck failed: ${recheck.error.code}`;
  const v = verificationOf(recheck);
  if (v.decision !== "PAY") return `recheck decision is ${v.decision} (${v.reason})`;
  if (expect.amountCents !== intended.amountCents) return `expect.amountCents ${expect.amountCents} differs from the invoice ${intended.amountCents}`;
  if (expect.beneficiaryLast4 !== intended.beneficiary.accountLast4) return `expect.beneficiaryLast4 ${expect.beneficiaryLast4} differs from the invoice ${intended.beneficiary.accountLast4}`;
  if (v.beneficiary.last4 !== intended.beneficiary.accountLast4) return `verified beneficiary ${v.beneficiary.last4} differs from the invoice`;
  return null;
}

export interface PaymentsAgentOptions {
  api: PayFirewall;
  principal?: Principal;
  /** The host's own payment function. Called at most once, only on a rechecked PAY with no rail configured. */
  sendPayment: (payment: PaymentInput) => Promise<string>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxSteps?: number;
}

const brief = (r: ToolResult) => {
  if (!r.ok) return `error ${r.error.code} -> ${r.error.nextActions[0]?.type ?? "DO_NOT_PAY"}`;
  const v = verificationOf(r);
  const risk = v.risk ? ` risk=${v.risk.level}/${v.risk.score}` : "";
  return `${v.state} decision=${v.decision} reason=${v.reason}${risk} -> ${v.nextActions[0]?.type ?? "none"}`;
};

/** Runs one payment to a final outcome. Never sends money except through `sendPayment` after a matching recheck. */
export async function runPaymentsAgent(payment: PaymentInput, opts: PaymentsAgentOptions): Promise<Outcome> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ctx = { principal: opts.principal };
  const maxSteps = opts.maxSteps ?? 40;

  log(`agent  -> verify_payment ${payment.id}: $${(payment.amountCents / 100).toLocaleString("en-US")} to ${payment.vendorId} account ...${payment.beneficiary.accountLast4}`);
  let result = await callTool(opts.api, "verify_payment", { payment }, ctx);
  let retries = 0;
  for (let i = 0; i < maxSteps; i++) {
    log(`engine <- ${brief(result)}`);
    const step = decide(result, retries);
    switch (step.kind) {
      case "call": {
        if (step.tool === "verify_payment") retries++;
        log(`agent  -> ${step.tool} (${step.why})`);
        await sleep(step.afterMs);
        result = await callTool(opts.api, step.tool, step.args, ctx);
        continue;
      }
      case "stop":
        log(`agent  :: DO NOT PAY (${step.reason})${step.escalation ? `; escalate: ${step.escalation}` : ""}`);
        return { status: "NOT_PAID", paymentId: payment.id, reason: step.reason, ...(step.escalation ? { escalation: step.escalation } : {}) };
      case "recheck_then_pay": {
        log(`agent  -> get_verification (recheck before paying)`);
        const recheck = await callTool(opts.api, "get_verification", step.args, ctx);
        const refusal = recheckAllowsPayment(recheck, step.expect, payment);
        if (refusal) {
          log(`agent  :: DO NOT PAY (${refusal})`);
          return { status: "NOT_PAID", paymentId: payment.id, reason: refusal };
        }
        const v = verificationOf(recheck as Extract<ToolResult, { ok: true }>);
        if (step.railReference || v.rail.status !== "NOT_CONFIGURED") {
          // With a rail configured the rail pays; sending money here as well could pay twice.
          const railReference = step.railReference ?? v.rail.reference ?? "";
          log(`agent  :: PAID BY RAIL ${railReference} (never sent again by the agent)`);
          return { status: "PAID_BY_RAIL", paymentId: payment.id, railReference, reason: v.reason };
        }
        const reference = await opts.sendPayment(payment);
        log(`agent  :: PAID ${reference} (recheck matched amount and beneficiary)`);
        return { status: "PAID", paymentId: payment.id, reference, reason: v.reason };
      }
    }
  }
  log(`agent  :: DO NOT PAY (step budget exhausted)`);
  return { status: "NOT_PAID", paymentId: payment.id, reason: "STEP_BUDGET_EXHAUSTED", escalation: "The verification did not finish in time. A person must follow up." };
}
