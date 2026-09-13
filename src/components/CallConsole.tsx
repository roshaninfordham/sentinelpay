"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CallOutcome, ChallengeView, Payment, RiskAssessment, Snapshot, Vendor } from "@/lib/types";
import { challengeScript, type ScriptLine } from "@/lib/voice/script";
import { createClientTools, submitDecision, type DecisionContext } from "@/lib/voice/tools";
import { Countdown } from "./Countdown";
import { loadVoiceSdk, type LiveSession } from "./live-voice";
import { expiryTime, possessive, shortName, TERMINAL_STATUS, writtenDigits } from "./format";
import { Waveform } from "./Waveform";

type Phase = "idle" | "connecting" | "live" | "simulated" | "ended" | "failed";
type Line = { speaker: "agent" | "vendor"; text: string };

export interface DemoSettings {
  vendorAnswer: "deny" | "authorize";
  voiceOn: boolean;
}

interface TokenResponse {
  mode: "live" | "simulated";
  reason?: string;
  challengeId: string;
  responderToken: string;
  /** For the scripted vendor only; never sent to the voice provider. */
  beneficiaryLast4: string;
  conversationToken?: string;
  dynamicVariables: { amount: string; vendor: string; payer: string } & Record<string, string>;
}

const CHANNEL_LABEL: Record<string, string> = {
  voice_browser: "live voice agent",
  voice_phone: "phone call",
  human_approval: "approval link",
  scripted: "scripted call",
};

const VERDICT_TEXT = {
  AUTHORIZED: { text: "Vendor confirmed the change", tone: "text-cleared" },
  DENIED: { text: "Vendor denied the change", tone: "text-signal" },
  INCONCLUSIVE: { text: "No clear answer. Failed closed", tone: "text-signal" },
} as const;

const TOKEN_ATTEMPTS = 6;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function CallConsole({
  payment,
  vendor,
  assessment,
  call,
  challenge,
  demo,
  environment,
  voiceAgent,
  frozenReason,
  onDecided,
}: {
  payment: Payment;
  vendor: Vendor;
  assessment?: RiskAssessment;
  call?: CallOutcome;
  challenge?: ChallengeView;
  demo: DemoSettings;
  environment: string;
  voiceAgent: Snapshot["voiceAgent"];
  /** Reason on the FROZEN ledger entry, so an operator freeze is never shown as a vendor answer. */
  frozenReason?: string;
  onDecided: () => void;
}) {
  // The live voice session, created from the lazily loaded SDK. Null on the scripted call.
  const session = useRef<LiveSession | null>(null);
  const [phase, setPhase] = useState<Phase>(call ? "ended" : "idle");
  const [lines, setLines] = useState<Line[]>(() => (call?.transcript ? parseTranscript(call.transcript) : []));
  const [speaking, setSpeaking] = useState<"agent" | "vendor" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [freezing, setFreezing] = useState(false);
  // True once this console has run the local script, or when no voice agent is configured at all.
  const [scripted, setScripted] = useState(voiceAgent === "scripted");
  const started = useRef(false);
  const linesRef = useRef<Line[]>(lines);
  const cancelled = useRef(false);
  const transcriptBox = useRef<HTMLDivElement>(null);
  // Read when a call starts, so changing Demo controls mid-call never alters a running script.
  const demoRef = useRef(demo);
  useEffect(() => {
    demoRef.current = demo;
  }, [demo]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    transcriptBox.current?.scrollTo({ top: transcriptBox.current.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [lines.length]);

  // Set when either tool reached the governor, so a hang-up without a decision can be recorded as one.
  const decided = useRef(false);

  const push = useCallback((l: Line) => {
    linesRef.current = [...linesRef.current, l];
    setLines(linesRef.current);
  }, []);

  const ctx = useCallback(
    (startedAt: number, token: TokenResponse): DecisionContext => ({
      paymentId: payment.id,
      challengeId: token.challengeId,
      responderToken: token.responderToken,
      startedAt,
      transcript: () => linesRef.current.map((l) => `${l.speaker === "agent" ? "Agent" : "Vendor"}: ${l.text}`).join("\n"),
      onDecided: () => {
        decided.current = true;
        onDecided();
      },
    }),
    [payment.id, onDecided],
  );

  const runSimulated = useCallback(
    async (token: TokenResponse) => {
      setPhase("simulated");
      setScripted(true);
      const { vendorAnswer, voiceOn } = demoRef.current;
      const startedAt = Date.now();
      const script = challengeScript(token.dynamicVariables, vendorAnswer, token.beneficiaryLast4);
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
          await submitDecision(ctx(startedAt, token), tool, vendorAnswer === "deny" ? "DENIED" : "AUTHORIZED", token.beneficiaryLast4);
        }
        await spoken;
        setSpeaking(null);
        await wait(350);
      }
      setPhase("ended");
    },
    [ctx, push],
  );

  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setPhase("connecting");
    let token: TokenResponse;
    try {
      // The engine records the open challenge before the channel starts it, so the voice session can lag the
      // dashboard's refresh by a moment: the route answers 202 until it exists.
      let res: Response;
      let body: TokenResponse & { error?: string };
      for (let attempt = 1; ; attempt++) {
        res = await fetch(`/api/voice/token?paymentId=${payment.id}`, { cache: "no-store" });
        body = await res.json();
        if (res.status !== 202 || attempt === TOKEN_ATTEMPTS || cancelled.current) break;
        await wait(700);
      }
      if (res.status !== 200) throw new Error(body.error ?? "voice session did not start");
      token = body;
    } catch (err) {
      setPhase("failed");
      setNote(
        environment === "production"
          ? "Voice unavailable, use approval link. The payment stays held."
          : `Could not start the vendor call (${(err as Error).message}). The payment stays held.`,
      );
      return;
    }

    if (token.mode === "simulated" || !token.conversationToken) {
      setNote(`Scripted call (${token.reason ?? "voice agent unavailable"}). It uses the same freeze and approve tools as the live agent.`);
      return runSimulated(token);
    }

    // Falls back to the scripted call at most once, whether the SDK fails to load, the session fails to start, or
    // the live session errors mid-call.
    let fellBack = false;
    const fallBack = (note: string) => {
      if (fellBack || cancelled.current) return;
      fellBack = true;
      session.current?.endSession().catch(() => undefined);
      session.current = null;
      setNote(note);
      runSimulated(token);
    };

    try {
      const VoiceConversation = await loadVoiceSdk();
      if (cancelled.current) return;
      const startedAt = Date.now();
      const live = await VoiceConversation.startSession({
        conversationToken: token.conversationToken,
        connectionType: "webrtc",
        dynamicVariables: token.dynamicVariables,
        clientTools: createClientTools(ctx(startedAt, token)),
        onConnect: () => {
          setPhase("live");
          setNote("Live call. Use headphones so the agent doesn't hear itself through your speakers.");
        },
        onMessage: ({ message, role }) => push({ speaker: role === "agent" ? "agent" : "vendor", text: message }),
        onModeChange: ({ mode }) => setSpeaking(mode === "speaking" ? "agent" : null),
        onDisconnect: () => {
          session.current = null;
          setSpeaking(null);
          setPhase((p) => (p === "simulated" ? p : "ended"));
          // A call that ends without a decision is inconclusive: freeze now instead of leaving the wire in limbo until
          // the challenge expires. Moving toward a frozen payment needs no token and is always allowed.
          if (!decided.current && !fellBack && !cancelled.current) {
            decided.current = true;
            void submitDecision(ctx(startedAt, token), "freeze_payment", "INCONCLUSIVE");
          }
        },
        onError: (message) => fallBack(`Voice agent error: ${message}. Falling back to the scripted call.`),
      });
      // Unmounted or frozen while connecting: hang up rather than leave a session open.
      if (cancelled.current || fellBack) {
        live.endSession().catch(() => undefined);
        return;
      }
      session.current = live;
    } catch (err) {
      fallBack(`Voice agent failed to start (${(err as Error).message}). Falling back to the scripted call.`);
    }
  }, [ctx, environment, payment.id, push, runSimulated]);

  const open = payment.status === "CHALLENGING" && challenge?.status === "OPEN";
  const voiceChallengeOpen = open && challenge?.channel === "voice_browser";
  const approvalChannel = challenge?.channel === "human_approval";
  const awaitingApproval = open && approvalChannel;

  // Auto-dial once forensics opens a voice_browser challenge. Other channels are answered elsewhere.
  useEffect(() => {
    // dialing is an external async process; kick it off outside the effect body
    if (voiceChallengeOpen && !call) queueMicrotask(start);
  }, [voiceChallengeOpen, call, start]);

  const freeze = useCallback(async () => {
    setFreezing(true);
    cancelled.current = true; // stop a scripted call; the frozen case refuses any later approval anyway
    window.speechSynthesis?.cancel();
    const res = await fetch("/api/block", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId: payment.id }),
    }).catch(() => null);
    if (!res?.ok) setNote("Freeze request failed. The payment stays held; try again.");
    session.current?.endSession().catch(() => undefined);
    session.current = null;
    setPhase((p) => (p === "simulated" || p === "live" || p === "connecting" ? "ended" : p));
    setFreezing(false);
    onDecided();
  }, [onDecided, payment.id]);

  // End the live session once the governor has decided.
  useEffect(() => {
    if (call && phase === "live") {
      // The agent explains the outcome and hangs up itself (end_call); this only closes a session it left open.
      const t = setTimeout(() => session.current?.endSession().catch(() => undefined), 15000);
      return () => clearTimeout(t);
    }
  }, [call, phase]);

  // Warm the SDK while forensics runs, so the live call starts without a fetch at the moment it dials.
  const verifying = payment.status === "PENDING_REVIEW" || payment.status === "INVESTIGATING" || payment.status === "CHALLENGING";
  useEffect(() => {
    if (voiceAgent === "elevenlabs" && verifying && !call) loadVoiceSdk().catch(() => undefined);
  }, [voiceAgent, verifying, call]);

  useEffect(() => {
    cancelled.current = false; // StrictMode remounts: re-arm after the simulated unmount
    return () => {
      cancelled.current = true;
      window.speechSynthesis?.cancel();
      session.current?.endSession().catch(() => undefined);
      session.current = null;
    };
  }, []);

  const onLine = phase === "live" || phase === "simulated" || phase === "connecting";
  // A scripted call is never presented as the live voice agent.
  const channelLabel = scripted && challenge?.channel === "voice_browser" ? CHANNEL_LABEL.scripted : challenge ? CHANNEL_LABEL[challenge.channel] ?? challenge.channel.replace(/_/g, " ") : null;
  const name = shortName(vendor.legalName);
  const dial = challenge?.dialMasked ?? assessment?.verifiedCallbackPhone;
  const verdict =
    frozenReason === "BLOCKED_BY_PRINCIPAL"
      ? { text: "Frozen from the operator console before the vendor answered", tone: "text-signal" }
      : call
        ? VERDICT_TEXT[call.verdict]
        : null;
  const expired = challenge?.status === "EXPIRED";
  const notNeeded = payment.status === "CLEARED" && !challenge && lines.length === 0;

  const statusText = awaitingApproval
    ? "Awaiting confirmation"
    : phase === "connecting"
      ? "Dialing…"
      : phase === "live"
        ? "Connected"
        : phase === "simulated"
          ? "On call"
          : phase === "failed"
            ? "Call failed"
            : expired
              ? "Expired"
              : verdict
                ? frozenReason === "BLOCKED_BY_PRINCIPAL"
                  ? "Frozen"
                  : "Answer recorded"
                : payment.status === "RECEIVED"
                  ? "Not started"
                  : payment.status === "CLEARED"
                    ? "Not needed"
                    : payment.status === "QUARANTINED"
                      ? "Closed"
                      : "Waiting for forensics";

  return (
    <section aria-labelledby="confirmation-heading" className="rounded-md border border-rule bg-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-rule px-4 py-2.5">
        <h2 id="confirmation-heading" className="font-display text-lg font-semibold">
          Vendor confirmation
        </h2>
        <span className={`inline-flex items-center gap-1.5 text-sm ${onLine || awaitingApproval ? "text-brass" : "text-muted"}`}>
          {(onLine || awaitingApproval) && <span className="h-1.5 w-1.5 rounded-full bg-brass motion-safe:animate-pulse" aria-hidden />}
          {statusText}
        </span>
      </div>

      {approvalChannel ? (
        <div className="px-4 py-4">
          {awaitingApproval && challenge ? (
            <>
              <p className="text-[15px] leading-relaxed">
                Awaiting confirmation from {possessive(name)} controller
                {challenge.dialMasked && (
                  <>
                    {" "}via <span className="whitespace-nowrap font-medium">{challenge.dialMasked}</span>
                  </>
                )}
                <span className="text-muted" suppressHydrationWarning> · link expires {expiryTime(challenge.expiresAt)}</span>
              </p>
              <Countdown expiresAt={challenge.expiresAt} className="mt-3" />
              <p className="mt-3 text-sm text-muted">
                An internal approver calls the vendor on the registry number and records the answer on their own device. The payment stays held
                until then, and freezes if the link expires.
              </p>
            </>
          ) : (
            <p className="text-[15px] leading-relaxed">
              {expired ? (
                <span className="text-signal">The confirmation link expired without an answer. The payment was frozen.</span>
              ) : verdict ? (
                <span className={verdict.tone}>{verdict.text}.</span>
              ) : (
                <span className="text-muted">The confirmation closed.</span>
              )}
              {challenge?.resolvedBy && !challenge.resolvedBy.startsWith("channel:") && (
                <span className="block text-sm text-muted">Recorded by {challenge.resolvedBy}</span>
              )}
            </p>
          )}
        </div>
      ) : (
        <>
          {!notNeeded && (
            <div className="px-4 pt-4">
              <p className="text-sm text-muted">
                {onLine || payment.status === "CHALLENGING"
                  ? `Calling the controller${channelLabel ? `, ${channelLabel}` : ""}`
                  : lines.length > 0
                    ? `Called the controller${channelLabel ? `, ${channelLabel}` : ""}`
                    : "If verification needs it, SentinelPay calls"}
              </p>
              <p className="truncate font-display text-lg font-medium">
                {name}
                {dial && <span className="text-muted"> {dial}</span>}
              </p>
              <Waveform
                active={onLine}
                speaker={speaking}
                sample={phase === "live" ? () => (speaking === "agent" ? session.current?.getOutputByteFrequencyData() : session.current?.getInputByteFrequencyData()) : undefined}
              />
            </div>
          )}

          <div ref={transcriptBox} role="log" aria-live="polite" aria-label="Call transcript" tabIndex={0} className={`scroll-thin max-h-[240px] overflow-y-auto px-4 pb-3 ${notNeeded ? "pt-3" : ""}`}>
            {lines.length === 0 ? (
              <p className="py-2 text-sm text-muted">
                {payment.status === "CLEARED"
                  ? "No call was needed. The beneficiary matched the vendor master."
                  : "When the risk check finishes, SentinelPay calls the vendor on the registry number and asks one question: did you authorize this bank change?"}
              </p>
            ) : (
              <ol className="flex flex-col gap-2.5 py-1">
                {lines.map((l, i) => (
                  <li key={i} className="text-sm leading-relaxed">
                    <span className={`mr-2 font-medium ${l.speaker === "agent" ? "text-brass" : "text-paper"}`}>
                      {l.speaker === "agent" ? "SentinelPay" : "Vendor"}
                    </span>
                    <span className="text-paper/90">{writtenDigits(l.text)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {verdict && phase === "ended" && (
            <p className={`border-t border-rule px-4 py-2.5 text-sm font-medium ${verdict.tone}`}>
              {verdict.text}
              {call && call.durationSec > 0 && <span className="font-normal text-muted"> · {call.durationSec}s call</span>}
            </p>
          )}
        </>
      )}

      {note && <p className="border-t border-rule px-4 py-2.5 text-xs text-muted">{note}</p>}

      {!TERMINAL_STATUS.has(payment.status) && payment.status !== "RECEIVED" && (
        <div className="no-print flex items-center justify-between gap-3 border-t border-rule px-4 py-3">
          <p className="text-xs text-muted">Stops the wire now, whatever the vendor says.</p>
          <button
            type="button"
            onClick={freeze}
            disabled={freezing}
            className="shrink-0 rounded border border-signal/70 px-3 py-1.5 text-sm font-medium text-signal transition-colors hover:bg-signal/10 disabled:opacity-60"
          >
            {freezing ? "Freezing…" : "Freeze now"}
          </button>
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
  const estimate = Math.min(9000, 700 + (line.spoken ?? line.text).length * 55);
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!enabled || !synth) return wait(estimate);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(line.spoken ?? line.text);
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
