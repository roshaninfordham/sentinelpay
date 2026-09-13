"use client";

import { useEffect, useRef, useState } from "react";

type Outcome = { kind: "done"; frozen: boolean } | { kind: "error"; message: string } | null;

const ERRORS: Record<string, string> = {
  RESPONDER_TOKEN_INVALID: "This confirmation link is not valid.",
  SELF_APPROVAL_FORBIDDEN: "You requested this payment, so you cannot confirm it. Ask another approver.",
  RESPONDER_TOKEN_REQUIRED: "An approver sign-in is required to record this confirmation.",
  CHALLENGE_EXPIRED: "This confirmation link has expired. The payment was frozen.",
  INVALID_TRANSITION: "This payment can no longer be confirmed. It stays held.",
};

export function ApproveForm({ challengeId }: { challengeId: string }) {
  const token = useRef<string | null>(null);
  const [readBack, setReadBack] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  // Take the token out of the fragment once, then remove it from the address bar and history.
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    if (t) token.current = t;
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  async function submit(confirmed: boolean) {
    if (!token.current) return setOutcome({ kind: "error", message: ERRORS.RESPONDER_TOKEN_INVALID });
    setSubmitting(true);
    const answers = { authorizedChange: confirmed ? "yes" : "no", ...(readBack ? { beneficiaryLast4ReadBack: readBack } : {}) };
    const res = await fetch(
      confirmed ? `/api/v1/challenges/${encodeURIComponent(challengeId)}/result` : `/api/approve/${encodeURIComponent(challengeId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(confirmed ? { authorization: `Bearer ${token.current}` } : {}) },
        body: JSON.stringify({ verdict: confirmed ? "AUTHORIZED" : "DENIED", answers }),
      },
    ).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { decision?: string; error?: { code?: string } } | null;
    setSubmitting(false);
    if (res?.ok) {
      token.current = null; // posted once
      return setOutcome({ kind: "done", frozen: body?.decision !== "PAY" });
    }
    setOutcome({ kind: "error", message: ERRORS[body?.error?.code ?? ""] ?? "Could not record the answer. The payment stays held; try again." });
  }

  if (outcome?.kind === "done") {
    return (
      <div role="status" className="mt-5 rounded-md border border-rule bg-panel px-4 py-4">
        <p className={`font-display text-xl font-semibold ${outcome.frozen ? "text-signal" : "text-cleared"}`}>
          {outcome.frozen ? "Recorded: the payment is frozen." : "Recorded: the vendor confirmed the account."}
        </p>
        <p className="mt-1 text-sm text-muted">
          {outcome.frozen
            ? "The vendor did not confirm this account, or the digits read back did not match. No money moves."
            : "The payment can now be released to the confirmed account."}
        </p>
      </div>
    );
  }

  return (
    <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">Last 4 digits the vendor read back</span>
        <input
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4}"
          maxLength={4}
          value={readBack}
          onChange={(e) => setReadBack(e.target.value.replace(/\D/g, "").slice(0, 4))}
          className="rounded border border-rule bg-panel-2 px-3 py-2 font-mono text-lg tracking-widest text-paper"
        />
      </label>
      {outcome?.kind === "error" && (
        <p role="alert" className="rounded border border-signal/60 bg-signal/10 px-3 py-2 text-sm text-signal">{outcome.message}</p>
      )}
      <button
        type="button"
        onClick={() => submit(true)}
        disabled={submitting || readBack.length !== 4}
        className="rounded-md bg-paper px-4 py-3 font-medium text-vault transition-colors hover:bg-white disabled:opacity-50"
      >
        Vendor confirmed this account
      </button>
      <button
        type="button"
        onClick={() => submit(false)}
        disabled={submitting}
        className="rounded-md border border-signal/60 px-4 py-3 font-medium text-signal transition-colors hover:bg-signal/10 disabled:opacity-50"
      >
        Vendor did not confirm
      </button>
    </form>
  );
}
