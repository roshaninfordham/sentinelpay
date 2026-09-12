"use client";

import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CallOutcome, Payment, RiskAssessment, Vendor } from "@/lib/types";
import { challengeScript, type ScriptLine } from "@/lib/voice/script";
import { createClientTools, submitDecision, type DecisionContext } from "@/lib/voice/tools";
import { Waveform } from "./Waveform";

type Phase = "idle" | "connecting" | "live" | "simulated" | "ended" | "failed";
type Line = { speaker: "agent" | "vendor"; text: string };

interface TokenResponse {
  mode: "live" | "simulated";
  reason?: string;
  conversationToken?: string;
  dynamicVariables: { amount: string; vendor: string; newLast4: string; payer: string } & Record<string, string>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function CallConsole({
  payment,
  vendor,
  assessment,
  call,
  onDecided,
}: {
  payment: Payment;
  vendor: Vendor;
  assessment?: RiskAssessment;
  call?: CallOutcome;
  onDecided: () => void;
}) {
  const conversation = useConversation();
  const [phase, setPhase] = useState<Phase>(call ? "ended" : "idle");
  const [lines, setLines] = useState<Line[]>(() => (call?.transcript ? parseTranscript(call.transcript) : []));
  const [speaking, setSpeaking] = useState<"agent" | "vendor" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [vendorAnswer, setVendorAnswer] = useState<"deny" | "authorize">("deny");
  const [voiceOn, setVoiceOn] = useState(true);
  const started = useRef(false);
  const linesRef = useRef<Line[]>(lines);
  const cancelled = useRef(false);
  const transcriptBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptBox.current?.scrollTo({ top: transcriptBox.current.scrollHeight, behavior: "smooth" });
  }, [lines.length]);

  const push = useCallback((l: Line) => {
    linesRef.current = [...linesRef.current, l];
    setLines(linesRef.current);
  }, []);

  const ctx = useCallback(
    (startedAt: number): DecisionContext => ({
      paymentId: payment.id,
      startedAt,
      transcript: () => linesRef.current.map((l) => `${l.speaker === "agent" ? "Agent" : "Vendor"}: ${l.text}`).join("\n"),
      onDecided: () => onDecided(),
    }),
    [payment.id, onDecided],
  );

  const runSimulated = useCallback(
    async (vars: TokenResponse["dynamicVariables"]) => {
      setPhase("simulated");
      const startedAt = Date.now();
      const script = challengeScript(vars, vendorAnswer);
      await wait(900); // ring
      for (const [i, line] of script.entries()) {
        if (cancelled.current) return;
        const last = i === script.length - 1;
        push(line);
        setSpeaking(line.speaker);
        const spoken = say(line, voiceOn);
        // The tool fires as the agent announces the decision — mid-call, like the live agent.
        if (last) {
          const tool = vendorAnswer === "deny" ? "freeze_payment" : "approve_payment";
          await wait(700);
          await submitDecision(ctx(startedAt), tool, vendorAnswer === "deny" ? "DENIED" : "AUTHORIZED");
        }
        await spoken;
        setSpeaking(null);
        await wait(350);
      }
      setPhase("ended");
    },
    [ctx, push, vendorAnswer, voiceOn],
  );

  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setPhase("connecting");
    let token: TokenResponse;
    try {
      const res = await fetch(`/api/voice/token?paymentId=${payment.id}`, { cache: "no-store" });
      token = await res.json();
    } catch {
      setPhase("failed");
      setNote("Could not reach the voice service. Payment stays held.");
      return;
    }

    if (token.mode === "simulated" || !token.conversationToken) {
      setNote(`Scripted call: ${token.reason ?? "voice agent unavailable"}. Uses the same freeze and approve tools.`);
      return runSimulated(token.dynamicVariables);
    }

    try {
      const startedAt = Date.now();
      conversation.startSession({
        conversationToken: token.conversationToken,
        connectionType: "webrtc",
        dynamicVariables: token.dynamicVariables,
        clientTools: createClientTools(ctx(startedAt)),
        onConnect: () => setPhase("live"),
        onMessage: ({ message, role }) => push({ speaker: role === "agent" ? "agent" : "vendor", text: message }),
        onModeChange: ({ mode }) => setSpeaking(mode === "speaking" ? "agent" : null),
        onDisconnect: () => setPhase("ended"),
        onError: (message) => {
          setNote(`Voice agent error: ${message}. Falling back to the scripted call.`);
          runSimulated(token.dynamicVariables);
        },
      });
    } catch (err) {
      setNote(`Voice agent failed to start (${(err as Error).message}). Falling back to the scripted call.`);
      runSimulated(token.dynamicVariables);
    }
  }, [conversation, ctx, payment.id, push, runSimulated]);

  // Auto-dial once forensics hands the payment to the challenge stage.
  useEffect(() => {
    // dialing is an external async process; kick it off outside the effect body
    if (payment.status === "CHALLENGING" && !call) queueMicrotask(start);
  }, [payment.status, call, start]);

  // End the live session once the governor has decided.
  useEffect(() => {
    if (call && conversation.status === "connected") {
      const t = setTimeout(() => conversation.endSession(), 4000);
      return () => clearTimeout(t);
    }
  }, [call, conversation]);

  useEffect(() => {
    cancelled.current = false; // StrictMode remounts: re-arm after the simulated unmount
    return () => {
      cancelled.current = true;
      window.speechSynthesis?.cancel();
    };
  }, []);

  const onLine = phase === "live" || phase === "simulated" || phase === "connecting";
  const statusText =
    phase === "connecting"
      ? `Dialing ${assessment?.verifiedCallbackPhone ?? "verified number"}…`
      : phase === "live"
        ? "Connected (ElevenLabs voice agent)"
        : phase === "simulated"
          ? "On call (scripted)"
          : phase === "ended"
            ? call
              ? `Call ended: ${call.toolInvoked ?? "no tool"} (${call.durationSec}s)`
              : "Call ended"
            : phase === "failed"
              ? "Call failed"
              : payment.status === "RECEIVED" || payment.status === "CLEARED"
                ? "No call needed yet"
                : "Waiting for forensics";

  return (
    <section aria-label="Out-of-band call" className="rounded-md border border-rule bg-panel">
      <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-2.5">
        <h2 className="font-display text-lg font-semibold">Vendor call</h2>
        <span className={`text-sm ${onLine ? "text-brass" : "text-muted"}`}>{statusText}</span>
      </div>

      <div className="px-4 pt-4">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">Calling the controller at</p>
            <p className="truncate font-display text-lg font-medium">
              {vendor.legalName.replace(/ LLC$/, "")}
              {assessment?.verifiedCallbackPhone && <span className="text-muted"> {assessment.verifiedCallbackPhone}</span>}
            </p>
          </div>
        </div>
        <Waveform
          active={onLine}
          speaker={speaking}
          sample={phase === "live" ? () => (speaking === "agent" ? conversation.getOutputByteFrequencyData() : conversation.getInputByteFrequencyData()) : undefined}
        />
      </div>

      <div ref={transcriptBox} className="scroll-thin max-h-[240px] overflow-y-auto px-4 pb-3" aria-live="polite">
        {lines.length === 0 ? (
          <p className="py-2 text-sm text-muted">
            When the risk check finishes, SentinelPay calls the vendor on the registry number and asks one question: did you authorize this bank change?
          </p>
        ) : (
          <ol className="flex flex-col gap-2.5 py-1">
            {lines.map((l, i) => (
              <li key={i} className="text-sm leading-relaxed">
                <span className={`mr-2 font-medium ${l.speaker === "agent" ? "text-brass" : "text-paper"}`}>
                  {l.speaker === "agent" ? "SentinelPay" : "Vendor"}
                </span>
                <span className="text-paper/85">{l.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {note && <p className="border-t border-rule px-4 py-2 text-xs text-muted">{note}</p>}

      {phase === "idle" && !call && (
        <div className="no-print flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule px-4 py-3 text-sm text-muted">
          <label className="flex items-center gap-2">
            If scripted, vendor
            <select
              value={vendorAnswer}
              onChange={(e) => setVendorAnswer(e.target.value as "deny" | "authorize")}
              className="rounded border border-rule bg-panel-2 px-2 py-1 text-paper"
            >
              <option value="deny">denies the change</option>
              <option value="authorize">confirms the change</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} className="accent-[var(--brass)]" />
            Speak aloud
          </label>
        </div>
      )}
    </section>
  );
}

function parseTranscript(t: string): Line[] {
  return t
    .split("\n")
    .map((row) => row.match(/^(Agent|Vendor): (.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ speaker: m[1] === "Agent" ? "agent" : "vendor", text: m[2] }));
}

/** Browser speech for the scripted call. Resolves when the line finishes (or after a reading-time estimate). */
function say(line: ScriptLine, enabled: boolean): Promise<void> {
  const estimate = Math.min(9000, 700 + line.text.length * 55);
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!enabled || !synth) return wait(estimate);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(line.text);
    const voices = synth.getVoices().filter((v) => v.lang.startsWith("en"));
    const pick = line.speaker === "agent" ? voices.find((v) => /samantha|google us english|aria|jenny/i.test(v.name)) : voices.find((v) => /daniel|alex|fred|guy|google uk english male/i.test(v.name));
    if (pick) u.voice = pick;
    u.rate = line.speaker === "agent" ? 1.04 : 1.0;
    u.pitch = line.speaker === "agent" ? 1.05 : 0.85;
    const done = () => resolve();
    u.onend = done;
    u.onerror = done;
    setTimeout(done, estimate + 4000); // some browsers never fire onend
    synth.speak(u);
  });
}
