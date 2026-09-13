// Runnable reference payments agent (Agent 2 in docs/AGENTS.md). No LLM and no API keys: a deterministic policy
// drives PayFirewall purely from nextActions against an in-memory engine, and a scripted controller answers the
// captured approval link out of band. Prints a readable transcript of three invoices.
//
//   pnpm exec tsx examples/payments-agent.ts
import type { Engine } from "payfirewall";
import { AP_AGENT, CLEAN_INVOICE, CONTROLLER_DESK, demoEngine, POISONED_INVOICE, type ApprovalLink } from "./demo-engine";
import { runPaymentsAgent } from "./payments-agent-loop";

type ControllerAnswer = { verdict: "DENIED" } | { verdict: "AUTHORIZED"; readBack: string };

/** Plays the internal approver: after a short delay, phones the vendor (simulated) and records the answer via the link. */
function controller(answer: ControllerAnswer, print: (line: string) => void) {
  let engine: Engine | undefined;
  const onApprovalLink = (link: ApprovalLink) => {
    print(`link   >> delivered to the approver (not the agent): ${link.summary}`);
    setTimeout(() => {
      const said = answer.verdict === "DENIED" ? "we never changed banks" : `yes, the new account ends ${answer.readBack}`;
      print(`vendor >> controller on (312) 555-0198: "${said}"`);
      void engine!.resolveChallenge({
        challengeId: link.challengeId,
        responderToken: link.responderToken,
        responder: CONTROLLER_DESK,
        verdict: answer.verdict,
        ...(answer.verdict === "AUTHORIZED" ? { answers: { authorizedChange: "yes", beneficiaryLast4ReadBack: answer.readBack } } : {}),
      }).catch((err: Error) => print(`link   >> rejected: ${err.message}`));
    }, 250);
  };
  return { onApprovalLink, bind: (e: Engine) => { engine = e; } };
}

async function scenario(title: string, invoice: typeof CLEAN_INVOICE, answer: ControllerAnswer) {
  console.log(`\n=== ${title} ===`);
  const print = (line: string) => console.log(`  ${line}`);
  const desk = controller(answer, print);
  const engine = demoEngine({ onApprovalLink: desk.onApprovalLink });
  desk.bind(engine);

  const outcome = await runPaymentsAgent(invoice, {
    api: engine,
    principal: AP_AGENT,
    sendPayment: async (p) => `ach_${p.id}_1`,
    log: print,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))), // the demo does not wait out full backoffs
  });
  const receipt = await engine.receipt(invoice.id, { principal: AP_AGENT });
  print(`report :: ${outcome.status} ${outcome.reason}; ledger ${receipt.entries.map((e) => e.event).join(" > ")}; chain ok=${receipt.chain.ok}`);
  return outcome;
}

async function main() {
  const results = [
    await scenario("Clean invoice: beneficiary matches the vendor master", CLEAN_INVOICE, { verdict: "DENIED" }),
    await scenario("Poisoned invoice, vendor denies the change", POISONED_INVOICE, { verdict: "DENIED" }),
    await scenario("Bank change the vendor really made (correct read-back)", POISONED_INVOICE, { verdict: "AUTHORIZED", readBack: "9821" }),
  ];
  const expected = ["PAID", "NOT_PAID", "PAID"];
  const ok = results.every((r, i) => r.status === expected[i]);
  console.log(`\n${ok ? "OK" : "UNEXPECTED"}: ${results.map((r) => r.status).join(", ")}`);
  process.exit(ok ? 0 : 1);
}

void main();
