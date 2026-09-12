"use client";

import { ConversationProvider } from "@elevenlabs/react";
import { useCallback, useEffect, useState } from "react";
import type { Snapshot } from "@/lib/types";
import { CallConsole } from "./CallConsole";
import { LedgerPanel } from "./LedgerPanel";
import { Queue } from "./Queue";
import { Terminal } from "./Terminal";
import { WireTicket } from "./WireTicket";

const POLL_MS = 700;

export function Dashboard({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState(initial);
  const [selectedId, setSelectedId] = useState(initial.payments[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/stream", { cache: "no-store" });
      if (res.ok) setSnap(await res.json());
    } catch {
      /* dev server restarting — next tick retries */
    }
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const release = async (paymentId: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId }),
    });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Release failed");
    await refresh();
    setBusy(false);
  };

  const reset = async () => {
    setBusy(true);
    await fetch("/api/reset", { method: "POST" });
    setResetKey((k) => k + 1);
    await refresh();
    setBusy(false);
  };

  const payment = snap.payments.find((p) => p.id === selectedId) ?? snap.payments[0];
  const vendor = payment && snap.vendors.find((v) => v.id === payment.vendorId);
  const assessment = payment ? snap.assessments[payment.id] : undefined;
  const call = payment ? snap.calls[payment.id] : undefined;
  const lines = payment ? snap.timeline.filter((l) => l.paymentId === payment.id) : [];
  const entries = payment ? snap.ledger.filter((e) => e.paymentId === payment.id) : [];
  const protectedCents = snap.payments.filter((p) => p.status === "QUARANTINED").reduce((s, p) => s + p.amountCents, 0);

  return (
    <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 pb-6 md:px-6">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule py-4">
        <div className="flex items-center gap-3">
          <ShieldGlyph />
          <h1 className="font-display text-2xl font-semibold tracking-tight">SentinelPay</h1>
        </div>
        <p className="text-sm text-muted">Pre-settlement verification for outgoing wires</p>
        <div className="ml-auto flex flex-wrap items-center gap-4 text-sm">
          <span className="text-muted">
            Protected today <span className="font-display text-base font-semibold text-paper">{(protectedCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}</span>
          </span>
          <span className={snap.chain.ok ? "text-cleared" : "text-signal"} title="Every ledger hash recomputed on each refresh">
            {snap.chain.ok ? "Audit chain intact" : `Audit chain broken at #${snap.chain.brokenAt}`}
          </span>
          <span
            className={`rounded border px-2 py-0.5 ${snap.rail.name === "column" ? "border-cleared/50 text-cleared" : "border-rule text-muted"}`}
            title={snap.rail.name === "column" ? "Beneficiaries read from Column sandbox; releases create sandbox wires" : `Local AP queue${snap.rail.note ? ` (${snap.rail.note})` : ""}`}
          >
            {snap.rail.name === "column" ? "Column sandbox rail" : "Mock rail"}
          </span>
          <span
            className="rounded border border-rule px-2 py-0.5 text-muted"
            title={snap.demoMode === "cache" ? "Forensics and voice run from recorded fixtures (works offline)" : "Live APIs, with fixture fallback"}
          >
            {snap.demoMode === "cache" ? "Offline fixtures" : "Live data"}
          </span>
          <button
            onClick={reset}
            disabled={busy}
            className="no-print rounded border border-rule px-3 py-1 text-muted transition-colors hover:border-muted hover:text-paper disabled:opacity-50"
          >
            Reset demo
          </button>
        </div>
      </header>

      {error && <p className="mt-3 rounded border border-signal/60 bg-signal/10 px-3 py-2 text-sm text-signal">{error}</p>}

      <main className="mt-5 grid flex-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)_minmax(0,440px)]">
        <Queue payments={snap.payments} vendors={snap.vendors} selectedId={payment?.id} onSelect={setSelectedId} />

        <section className="flex min-w-0 flex-col gap-5">
          {payment && vendor ? (
            <>
              <WireTicket
                payment={payment}
                vendor={vendor}
                assessment={assessment}
                call={call}
                busy={busy}
                onRelease={() => release(payment.id)}
              />
              <LedgerPanel entries={entries} chainOk={snap.chain.ok} />
            </>
          ) : (
            <p className="text-muted">No payments in the queue. Reset the demo to load the scenario.</p>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-5">
          <Terminal lines={lines} />
          {payment && vendor && (
            <ConversationProvider>
              <CallConsole
                key={`${payment.id}-${resetKey}`}
                payment={payment}
                vendor={vendor}
                assessment={assessment}
                call={call}
                onDecided={refresh}
              />
            </ConversationProvider>
          )}
        </section>
      </main>
    </div>
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
