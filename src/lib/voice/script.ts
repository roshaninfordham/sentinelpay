// Scripted challenge used when the live ElevenLabs agent is unavailable (DEMO_MODE=cache or no keys).
// It drives the exact same client tool → /api/governor/decide path as the live agent.

export type Speaker = "agent" | "vendor";
/** `text` is what the transcript shows; `spoken`, when present, is what browser speech says instead. */
export interface ScriptLine { speaker: Speaker; text: string; spoken?: string }

export interface ScriptVars {
  amount: string;
  vendor: string;
  payer: string;
}

// The agent never says the new account's digits: if the vendor confirms, the vendor reads them back.
export function challengeScript(v: ScriptVars, vendorAnswer: "deny" | "authorize", beneficiaryLast4: string): ScriptLine[] {
  const opening: ScriptLine = {
    speaker: "agent",
    text: `Hello, this is the SentinelPay settlement desk calling on behalf of ${v.payer}. We have a pending ${v.amount} wire to ${v.vendor}, and we received a request to change the bank account it is paid to. Did your treasury team authorize this change?`,
  };
  if (vendorAnswer === "deny") {
    return [
      opening,
      { speaker: "vendor", text: "No, we did not. Our account hasn't changed. That's fraudulent." },
      { speaker: "agent", text: "Understood. I'm freezing the wire now and generating a forensic report. Thank you." },
    ];
  }
  return [
    opening,
    { speaker: "vendor", text: "Yes. We moved banks last month." },
    { speaker: "agent", text: "Thank you. Please read me the last four digits of the new account." },
    { speaker: "vendor", text: `It ends in ${beneficiaryLast4}.`, spoken: `It ends in ${beneficiaryLast4.split("").join(" ")}.` },
    { speaker: "agent", text: "Thank you for confirming. I'm recording your authorization for release." },
  ];
}
