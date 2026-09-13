"use client";

import { ConversationProvider } from "@elevenlabs/react";
import { MotionConfig } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Snapshot } from "@/lib/types";
import { CallConsole, type DemoSettings } from "./CallConsole";
import { requestersFrom, TERMINAL_STATUS } from "./format";
import { AuditIndicator, DemoControls, EnvironmentChip } from "./HeaderControls";
import { LedgerPanel } from "./LedgerPanel";
import { Queue } from "./Queue";
import { SAVED_REASONS } from "./ResolutionShield";
import { Terminal } from "./Terminal";
import { WireTicket } from "./WireTicket";

/** Refresh while a wire is being verified, so the investigation reads live; slower when every wire is idle. */
const POLL_ACTIVE_MS = 1000;
const POLL_IDLE_MS = 5000;
/** Consecutive failed refreshes before the dashboard says the service is down (a dev reload drops one or two). */
const FAILURES_BEFORE_ALERT = 3;

export function Dashboard({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState(initial);
  const [selectedId, setSelectedId] = useState(initial.payments[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const [demo, setDemo] = useState<DemoSettings>({ vendorAnswer: "deny", voiceOn: true });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/stream", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setSnap(await res.json());
      setFailures(0);
    } catch {
      setFailures((n) => n + 1);
    }
  }, []);

  const active = busy || snap.payments.some((p) => p.status !== "RECEIVED" && !TERMINAL_STATUS.has(p.status));
  useEffect(() => {
    const t = setInterval(refresh, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(t);
  }, [refresh, active]);

  const release = async (paymentId: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId }),
    }).catch(() => null);
    if (!res) setError("Verification service unavailable. Payments stay held.");
    else if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(res.status >= 500 ? "Verification service unavailable. Payments stay held." : `Could not verify this payment: ${body.error ?? res.status}. It stays held.`);
    }
    await refresh();
    setBusy(false);
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    window.speechSynthesis?.cancel();
    await fetch("/api/reset", { method: "POST" }).catch(() => null);
    setResetKey((k) => k + 1);
    await refresh();
    setBusy(false);
  };

  const requesters = useMemo(() => requestersFrom(snap.timeline), [snap.timeline]);
  const payment = snap.payments.find((p) => p.id === selectedId) ?? snap.payments[0];
  const vendor = payment && snap.vendors.find((v) => v.id === payment.vendorId);
  const assessment = payment ? snap.assessments[payment.id] : undefined;
  const call = payment ? snap.calls[payment.id] : undefined;
  const lines = payment ? snap.timeline.filter((l) => l.paymentId === payment.id) : [];
  const entries = payment ? snap.ledger.filter((e) => e.paymentId === payment.id) : [];
  const frozenReasons = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const e of snap.ledger) if (e.event === "FROZEN") out[e.paymentId] = (e.payload as { reason?: string } | null)?.reason;
    return out;
  }, [snap.ledger]);
  const frozenReason = payment ? frozenReasons[payment.id] : undefined;
  const challenge = payment ? snap.challenges[payment.id] : undefined;
  // Only a vendor's refusal counts as protected; an operator freeze or an expiry holds money that may be legitimate.
  const protectedCents = snap.payments
    .filter((p) => p.status === "QUARANTINED" && SAVED_REASONS.has(frozenReasons[p.id] ?? ""))
    .reduce((s, p) => s + p.amountCents, 0);
  const unavailable = failures >= FAILURES_BEFORE_ALERT;

  return (
    <MotionConfig reducedMotion="user">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 pb-8 md:px-6">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-rule py-4">
          <div className="flex items-center gap-3">
            <ShieldGlyph />
            <h1 className="font-display text-2xl font-semibold tracking-tight">SentinelPay</h1>
            <p className="hidden text-sm text-muted xl:block">Pre-settlement verification for outgoing wires</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 min-[900px]:ml-auto">
            <span className="text-sm text-muted">
              Protected today{" "}
              <span className="font-display text-base font-semibold text-paper">
                {(protectedCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
              </span>
            </span>
            <AuditIndicator chain={snap.chain} entries={snap.ledger.length} />
            <div className="no-print flex flex-wrap items-center gap-2">
              <EnvironmentChip snap={snap} />
              {snap.environment !== "production" && <DemoControls settings={demo} onChange={setDemo} onReset={reset} busy={busy} />}
            </div>
          </div>
        </header>

        <div aria-live="assertive" className="empty:hidden">
          {(unavailable || error) && (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-signal/60 bg-signal/10 px-4 py-2.5 text-sm">
              <p className="text-signal">{unavailable ? "Verification service unavailable. Payments stay held." : error}</p>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  refresh();
                }}
                className="ml-auto rounded border border-signal/60 px-3 py-1 text-signal transition-colors hover:bg-signal/10"
              >
                {unavailable ? "Retry" : "Dismiss"}
              </button>
            </div>
          )}
        </div>

        <main className="mt-5 grid flex-1 content-start gap-5 min-[900px]:grid-cols-[240px_minmax(0,1fr)] min-[1200px]:grid-cols-[260px_minmax(0,1fr)_minmax(0,420px)]">
          <div className="min-[900px]:row-span-2 min-[1200px]:row-span-1">
            <Queue payments={snap.payments} vendors={snap.vendors} requesters={requesters} selectedId={payment?.id} onSelect={setSelectedId} />
          </div>

          <section aria-label="Selected case" className="flex min-w-0 flex-col gap-4">
            {payment && vendor ? (
              <>
                <WireTicket
                  payment={payment}
                  vendor={vendor}
                  assessment={assessment}
                  freeze={{
                    reason: frozenReason,
                    assurance: challenge?.assurance,
                    scripted: challenge?.channel === "voice_browser" && snap.voiceAgent === "scripted",
                  }}
                  busy={busy}
                  onRelease={() => release(payment.id)}
                />
                <LedgerPanel key={payment.id} paymentId={payment.id} entries={entries} chainOk={snap.chain.ok} />
              </>
            ) : (
              <div className="rounded-md border border-dashed border-rule px-5 py-8 text-muted">
                <p className="text-paper">Select a wire to verify it.</p>
                <p className="mt-1 text-sm">
                  Verify and release holds the wire, investigates the change, confirms it with the vendor out of band, then releases or freezes it
                  with a receipt.
                </p>
              </div>
            )}
          </section>

          <section aria-label="Investigation and vendor confirmation" className="flex min-w-0 flex-col gap-4 min-[900px]:col-start-2 min-[1200px]:col-start-3">
            <Terminal lines={lines} />
            {payment && vendor && (
              <ConversationProvider>
                <CallConsole
                  key={`${payment.id}-${resetKey}`}
                  payment={payment}
                  vendor={vendor}
                  assessment={assessment}
                  call={call}
                  challenge={challenge}
                  demo={demo}
                  environment={snap.environment}
                  voiceAgent={snap.voiceAgent}
                  frozenReason={frozenReason}
                  onDecided={refresh}
                />
              </ConversationProvider>
            )}
          </section>
        </main>
      </div>
    </MotionConfig>
  );
}

function ShieldGlyph() {
  return (
    <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden className="text-brass">
      <path d="M11 1 21 4.5v7.8c0 6-4.2 10.7-10 12.7C5.2 23 1 18.3 1 12.3V4.5L11 1Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M6.5 13 9.8 16.2 15.8 9.6" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
