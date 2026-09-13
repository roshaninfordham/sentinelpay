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
    text: `Hi, this is Alex with the SentinelPay settlement desk, calling for ${v.payer}'s accounts payable team. We received a request to change the bank account for a ${v.amount} payment to ${v.vendor}, and before any money moves we confirm changes like this directly with you. Did your team ask for that change?`,
  };
  if (vendorAnswer === "deny") {
    return [
      opening,
      { speaker: "vendor", text: "No, we didn't. Our account hasn't changed. That sounds like fraud." },
      { speaker: "agent", text: "Thank you for telling me. The payment is on hold and no money will move. You may have just stopped a fraud attempt, and their accounts payable team will follow up with your usual contact. Goodbye." },
    ];
  }
  return [
    opening,
    { speaker: "vendor", text: "Yes, we moved banks last month." },
    { speaker: "agent", text: "Got it, thanks. For security, could you read me the last four digits of the new account?" },
    { speaker: "vendor", text: `It ends in ${beneficiaryLast4}.`, spoken: `It ends in ${beneficiaryLast4.split("").join(" ")}.` },
    { speaker: "agent", text: "Thanks, that matches. Your confirmation is recorded and the payment can go ahead. Have a good day." },
  ];
}
