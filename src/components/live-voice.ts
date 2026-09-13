// The ElevenLabs SDK (and the WebRTC stack under it) is the largest dependency in the console. It is fetched only
// when a live vendor call is about to start, never on first load, and the scripted call never needs it.
import type { VoiceConversation } from "@elevenlabs/react";

export type LiveSession = VoiceConversation;

let pending: Promise<typeof VoiceConversation> | null = null;

/** Loads the SDK once; a failed fetch clears the cache so the next call can retry. */
export function loadVoiceSdk(): Promise<typeof VoiceConversation> {
  pending ??= import("@elevenlabs/react").then(
    (m) => m.VoiceConversation,
    (err) => {
      pending = null;
      throw err;
    },
  );
  return pending;
}
