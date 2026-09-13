"use client";

import { useEffect, useRef, useState } from "react";
import { Countdown } from "@/components/Countdown";
import { expiryTime, usd } from "@/components/format";

interface Details {
  status: "open";
  amountCents: number;
  vendor: string;
  onFileLast4: string;
  requestSourceDomain: string;
  callbackPhone: string | null;
  expiresAt: string;
}

type Link = { status: "loading" } | { status: "invalid" } | { status: "expired" } | { status: "closed" } | { status: "unavailable" } | Details;

type Outcome = { kind: "done"; released: boolean } | { kind: "error"; message: string; final: boolean } | null;

// Every token failure reads the same, so the page never reveals whether a challenge exists.
const ERRORS: Record<string, { message: string; final: boolean }> = {
  RESPONDER_TOKEN_INVALID: { message: "This confirmation link is not valid. Ask the payer’s accounts team for a new link.", final: true },
  SELF_APPROVAL_FORBIDDEN: { message: "You requested this payment, so you cannot confirm it. Ask another approver.", final: true },
  RESPONDER_TOKEN_REQUIRED: { message: "An approver sign-in is required to record this answer.", final: true },
  CHALLENGE_EXPIRED: { message: "This confirmation link has expired. The payment was frozen.", final: true },
  INVALID_TRANSITION: { message: "This confirmation is closed. The payment’s outcome is final.", final: true },
};

export function ApproveForm({ challengeId }: { challengeId: string }) {
  const token = useRef<string | null>(null);
  const [link, setLink] = useState<Link>({ status: "loading" });
  const [readBack, setReadBack] = useState("");
  const [submitting, setSubmitting] = useState<"confirm" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const result = useRef<HTMLDivElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  // Take the token out of the fragment once and remove it from the address bar and history, then load the details
  // with it. Without a token nothing about the challenge is requested.
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    if (t) token.current = t;
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const presented = token.current; // StrictMode re-runs this after the hash is gone
    if (!presented) {
      queueMicrotask(() => setLink({ status: "invalid" }));
      return;
    }
    let active = true;
    fetch(`/api/approve/${encodeURIComponent(challengeId)}`, { headers: { authorization: `Bearer ${presented}` }, cache: "no-store" })
      .then(async (res) => {
        if (!active) return;
        if (res.status === 401) return setLink({ status: "invalid" });
        if (!res.ok) return setLink({ status: "unavailable" });
        setLink((await res.json()) as Link);
      })
      .catch(() => active && setLink({ status: "unavailable" }));
    return () => {
      active = false;
    };
  }, [challengeId]);

  useEffect(() => {
    if (outcome) result.current?.focus();
  }, [outcome]);

  async function submit(confirmed: boolean) {
    if (!token.current) return setOutcome({ kind: "error", ...ERRORS.RESPONDER_TOKEN_INVALID });
    setSubmitting(confirmed ? "confirm" : "deny");
    const answers = { authorizedChange: confirmed ? "yes" : "no", ...(readBack ? { beneficiaryLast4ReadBack: readBack } : {}) };
    const res = await fetch(
      confirmed ? `/api/v1/challenges/${encodeURIComponent(challengeId)}/result` : `/api/approve/${encodeURIComponent(challengeId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token.current}` },
        body: JSON.stringify({ verdict: confirmed ? "AUTHORIZED" : "DENIED", answers }),
      },
    ).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { decision?: string; error?: { code?: string } } | null;
    setSubmitting(null);
    if (res?.ok) {
      token.current = null; // posted once
      return setOutcome({ kind: "done", released: body?.decision === "PAY" });
    }
    setOutcome({
      kind: "error",
      ...(ERRORS[body?.error?.code ?? ""] ?? { message: "Could not record the answer. The payment stays held; try again.", final: false }),
    });
  }

  if (link.status === "loading") {
    return (
      <div role="status" className="rounded-md border border-rule bg-panel px-4 py-5">
        <p className="text-muted">Checking this confirmation link…</p>
      </div>
    );
  }
  if (link.status === "invalid") {
    return <Notice title="This confirmation link is not valid." body="Ask the payer’s accounts team for a new link. No payment is released without a valid confirmation." />;
  }
  if (link.status === "unavailable") {
    return <Notice title="Verification service unavailable." body="The payment stays held. Reload this page in a moment." />;
  }
  if (link.status === "expired") {
    return <Notice tone="frozen" title="This confirmation link has expired. The payment was frozen." body="No money moved. Nothing further is needed from you." />;
  }
  if (link.status === "closed") {
    return <Notice title="This confirmation is closed. The payment’s outcome is final." body="Nothing further is needed from you." />;
  }

  const recorded = outcome?.kind === "done";
  const busy = submitting !== null;
  const blocked = outcome?.kind === "error" && outcome.final;

  return (
    <>
      <p className="text-sm text-muted">Vendor bank-change confirmation</p>
      <h1 className="mt-1 font-display text-[1.75rem] font-semibold leading-tight">
        {recorded ? `Answer recorded for ${usd(link.amountCents)}` : `Confirm before ${usd(link.amountCents)} is paid`}
      </h1>
      {!recorded && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Countdown expiresAt={link.expiresAt} />
          <span className="text-sm text-muted">Link expires {expiryTime(link.expiresAt)}</span>
        </div>
      )}

      <dl className="mt-5 rounded-md border border-rule bg-panel px-4 py-1">
        <Row k="Amount" v={usd(link.amountCents)} />
        <Row k="Vendor" v={link.vendor} />
        <Row k="Account on file" v={`••${link.onFileLast4}`} />
        <Row
          k="Requesting domain"
          v={
            <>
              <span className="break-all text-brass">{link.requestSourceDomain}</span>
              <span className="block text-xs text-muted">From the request, unverified</span>
            </>
          }
        />
      </dl>

      {!recorded && (
        <section aria-labelledby="call-heading" className="mt-5 rounded-md border border-brass/60 bg-panel px-4 py-4">
          <h2 id="call-heading" className="text-sm font-medium text-brass">
            Call this number, not the one on the invoice
          </h2>
          {link.callbackPhone ? (
            <a
              href={`tel:${link.callbackPhone.replace(/[^\d+]/g, "")}`}
              className="mt-1 block font-display text-3xl font-semibold text-paper underline-offset-4 hover:underline"
            >
              {link.callbackPhone}
            </a>
          ) : (
            <p className="mt-1 font-display text-xl font-semibold">No verified number on file</p>
          )}
          <p className="mt-1 text-xs text-muted">From public registry records for {link.vendor}.</p>
          <ol className="mt-4 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-paper/90 marker:text-muted">
            <li>Ask the vendor’s controller whether they changed their bank account.</li>
            <li>If they did, ask them to read back the last 4 digits of the new account.</li>
            <li>Record their answer below.</li>
          </ol>
        </section>
      )}

      {outcome?.kind === "done" ? (
        <div
          ref={result}
          tabIndex={-1}
          role="status"
          className={`mt-5 rounded-md border bg-panel px-4 py-5 outline-none ${outcome.released ? "border-cleared/60" : "border-signal/60"}`}
        >
          <p className={`flex items-start gap-2 font-display text-xl font-semibold ${outcome.released ? "text-cleared" : "text-signal"}`}>
            <svg viewBox="0 0 12 12" className="mt-1.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
              {outcome.released ? (
                <path d="m2.5 6.25 2.25 2.25L9.5 3.75" />
              ) : (
                <>
                  <rect x="2.25" y="5.25" width="7.5" height="5" rx="1" />
                  <path d="M3.9 5.25V4a2.1 2.1 0 0 1 4.2 0v1.25" />
                </>
              )}
            </svg>
            {outcome.released ? "Recorded. The payment was released to the confirmed account." : "Recorded. The payment is frozen."}
          </p>
          <p className="mt-2 text-sm text-muted">
            {outcome.released
              ? "The vendor confirmed the account and the digits matched. You can close this page."
              : "The vendor did not confirm this account, or the digits read back did not match. No money moves."}
          </p>
        </div>
      ) : blocked ? (
        <div ref={result} tabIndex={-1} role="alert" className="mt-5 rounded-md border border-signal/60 bg-panel px-4 py-4 outline-none">
          <p className="font-medium text-signal">{outcome.message}</p>
          <p className="mt-1 text-sm text-muted">No payment is released without a valid confirmation.</p>
        </div>
      ) : (
        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(e) => {
            // Enter never records an answer: with 4 digits it moves to the confirm button, so confirming stays a deliberate press.
            e.preventDefault();
            if (readBack.length === 4) confirmButton.current?.focus();
          }}
        >
          <div className="flex flex-col gap-0.5">
            <label htmlFor="read-back" className="text-sm font-medium">
              Last 4 digits the vendor read back
            </label>
            <p id="read-back-hint" className="text-xs text-muted">
              Required to confirm. Leave empty if the vendor did not confirm.
            </p>
          </div>
          <input
            id="read-back"
            aria-describedby="read-back-hint"
            inputMode="numeric"
            enterKeyHint="next"
            autoComplete="off"
            pattern="[0-9]{4}"
            maxLength={4}
            placeholder="••••"
            value={readBack}
            onChange={(e) => setReadBack(e.target.value.replace(/\D/g, "").slice(0, 4))}
            className="w-40 rounded-md border border-rule bg-panel-2 px-3 py-2.5 font-mono text-2xl tracking-[0.4em] text-paper placeholder:text-muted"
          />
          {outcome?.kind === "error" && (
            <div ref={result} tabIndex={-1} role="alert" className="rounded-md border border-signal/60 bg-signal/10 px-3 py-2 text-sm text-signal outline-none">
              {outcome.message}
            </div>
          )}
          <button
            ref={confirmButton}
            type="button"
            onClick={() => submit(true)}
            disabled={busy || readBack.length !== 4}
            className="mt-2 rounded-md bg-paper px-4 py-3 font-medium text-vault transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-paper/40"
          >
            {submitting === "confirm" ? "Recording…" : "Vendor confirmed this account"}
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={busy}
            className="rounded-md border border-signal/70 px-4 py-3 font-medium text-signal transition-colors hover:bg-signal/10 disabled:opacity-60"
          >
            {submitting === "deny" ? "Recording…" : "Vendor did not confirm"}
          </button>
          <p className="text-xs text-muted">Not confirming freezes the payment. Your answer is written to the audit chain.</p>
        </form>
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-3 border-t border-rule/60 py-2 first:border-t-0">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </div>
  );
}

function Notice({ title, body, tone = "neutral" }: { title: string; body: string; tone?: "neutral" | "frozen" }) {
  return (
    <div role="status" className={`rounded-md border bg-panel px-4 py-5 ${tone === "frozen" ? "border-signal/60" : "border-rule"}`}>
      <h1 className={`font-display text-xl font-semibold leading-snug ${tone === "frozen" ? "text-signal" : ""}`}>{title}</h1>
      <p className="mt-2 text-muted">{body}</p>
    </div>
  );
}
