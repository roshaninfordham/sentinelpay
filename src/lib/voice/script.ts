// Scripted challenge used when the live ElevenLabs agent is unavailable (DEMO_MODE=cache or no keys).
// It drives the exact same client tool → /api/governor/decide path as the live agent.

export type Speaker = "agent" | "vendor";
export interface ScriptLine { speaker: Speaker; text: string }

export interface ScriptVars {
  amount: string;
  vendor: string;
  newLast4: string;
  payer: string;
}

export function challengeScript(v: ScriptVars, vendorAnswer: "deny" | "authorize"): ScriptLine[] {
  const opening: ScriptLine = {
    speaker: "agent",
    text: `Hello, this is the SentinelPay settlement desk calling on behalf of ${v.payer}. We have a pending ${v.amount} wire to ${v.vendor}, and we received a request to change your bank routing to an account ending ${v.newLast4.split("").join(" ")}. Did your treasury team authorize this change?`,
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
    { speaker: "vendor", text: "Yes. We moved banks last month; the account ending in those digits is ours." },
    { speaker: "agent", text: "Thank you for confirming. I'm releasing the payment and recording your authorization." },
  ];
}
