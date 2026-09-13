// What /api/voice/token returns. The responder token lets the operator's browser record the vendor's answer; the new
// account's last 4 digits go only to the scripted demo call, whose simulated vendor has to say them. A live call never
// receives them: the real vendor reads them back, so a browser that fetched a live token cannot also look them up here.

export interface VoiceTokenBase {
  challengeId: string;
  responderToken: string;
  dynamicVariables: Record<string, string>;
}

export type VoiceTokenBody =
  | ({ mode: "live"; conversationToken: string } & VoiceTokenBase)
  | ({ mode: "simulated"; reason: string; beneficiaryLast4: string } & VoiceTokenBase);

export function liveTokenBody(base: VoiceTokenBase, conversationToken: string): VoiceTokenBody {
  return { mode: "live", conversationToken, ...base };
}

export function simulatedTokenBody(base: VoiceTokenBase, reason: string, beneficiaryLast4: string): VoiceTokenBody {
  return { mode: "simulated", reason, ...base, beneficiaryLast4 };
}
