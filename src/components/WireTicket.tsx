"use client";

import { useEffect, useRef, useState } from "react";
import type { Payment, PaymentStatus, RiskAssessment, Vendor } from "@/lib/types";
import { rationaleText, usd } from "./format";
import { FrozenBand, ResolutionShield, type FreezeContext } from "./ResolutionShield";
import { StatusPill } from "./StatusPill";

const STAGES = ["Verify requested", "Held", "Investigated", "Vendor confirmation", "Outcome"] as const;

/** Index of the stage in progress, or null when nothing is running. */
const ACTIVE: Partial<Record<PaymentStatus, number>> = { PENDING_REVIEW: 2, INVESTIGATING: 2, CHALLENGING: 3 };

/** How many stages are complete for a status. */
function completed(status: PaymentStatus, investigated: boolean): number {
  switch (status) {
    case "RECEIVED":
      return 0;
    case "PENDING_REVIEW":
    case "INVESTIGATING":
      return 2;
    case "CHALLENGING":
      return 3;
    case "QUARANTINED":
      return 5;
    case "CLEARED":
      return investigated ? 5 : 1;
  }
}

// The primary button's label follows the decision; it is only actionable before verification starts.
const PRIMARY_LABEL: Record<PaymentStatus, string> = {
  RECEIVED: "Verify and release",
  PENDING_REVIEW: "Held",
  INVESTIGATING: "Held",
  CHALLENGING: "Awaiting vendor",
  QUARANTINED: "Frozen",
  CLEARED: "Released",
};

const RISK_TONE = { LOW: "text-cleared", ELEVATED: "text-brass", CRITICAL: "text-signal" } as const;

export function WireTicket({
  payment,
  vendor,
  assessment,
  freeze,
  busy,
  onRelease,
}: {
  payment: Payment;
  vendor: Vendor;
  assessment?: RiskAssessment;
  /** Why and how the wire froze, for the stamp and its explanation. */
  freeze: FreezeContext;
  busy: boolean;
  onRelease: () => void;
}) {
  const bankChanged = payment.claimedBankLast4 !== vendor.knownBankLast4;
  const domainChanged = payment.requestSourceDomain !== vendor.knownDomain;
  const frozen = payment.status === "QUARANTINED";
  const cleared = payment.status === "CLEARED";
  // A clean payment released straight through the gate skips the middle stages.
  const straightThrough = cleared && !assessment;
  const done = completed(payment.status, !!assessment);
  const actionable = payment.status === "RECEIVED" && !busy;

  // The stamp overlays the ticket only when the freeze happens on screen; a wire that was already frozen when
  // selected shows the band, so its facts stay readable. Adjusted during render when the payment or status changes.
  const [seen, setSeen] = useState({ id: payment.id, status: payment.status });
  const [stamping, setStamping] = useState(false);
  if (seen.id !== payment.id || seen.status !== payment.status) {
    setStamping(seen.id === payment.id && seen.status !== "QUARANTINED" && frozen);
    setSeen({ id: payment.id, status: payment.status });
  }
  const overlay = frozen && stamping;

  const band = useRef<HTMLAnchorElement>(null);
  const dismissed = useRef(false);
  useEffect(() => {
    if (!overlay && dismissed.current) {
      dismissed.current = false;
      band.current?.focus();
    }
  }, [overlay]);

  return (
    <article
      aria-labelledby="ticket-heading"
      className={`relative overflow-hidden rounded-md border bg-panel transition-colors duration-500 ${
        frozen ? "border-signal/70" : "border-rule"
      }`}
    >
      <div inert={overlay}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-5 sm:px-5 md:px-7 md:pt-6">
          <div className="min-w-0">
            <p className="text-sm text-muted">Wire to</p>
            <h2 id="ticket-heading" className="font-display text-2xl font-semibold leading-tight">{vendor.legalName}</h2>
            {payment.memo && <p className="mt-1 break-words text-sm text-muted">{payment.memo}</p>}
          </div>
          <StatusPill status={payment.status} size="md" />
        </div>

        <p
          className={`mt-1 px-4 font-display text-[clamp(2.75rem,7vw,5.75rem)] font-semibold leading-none tracking-tight sm:px-5 md:px-7 ${
            frozen ? "text-signal" : "text-paper"
          }`}
        >
          {usd(payment.amountCents)}
        </p>

        <dl className="mt-6 grid gap-px border-y border-rule bg-rule sm:grid-cols-3">
          <Detail
            term="Beneficiary account"
            changed={bankChanged}
            value={
              bankChanged ? (
                <>
                  <span className="text-muted line-through decoration-muted/70">
                    <span className="sr-only">on file </span>••{vendor.knownBankLast4}
                  </span>
                  <span className="mx-2 text-muted">to</span>
                  <span className="text-brass">••{payment.claimedBankLast4}</span>
                </>
              ) : (
                <>••{payment.claimedBankLast4} on file</>
              )
            }
          />
          <Detail
            term="Change requested from"
            changed={domainChanged}
            value={
              <>
                <span className={`break-all ${domainChanged ? "text-brass" : ""}`}>{payment.requestSourceDomain}</span>
                {domainChanged && <span className="block font-sans text-xs font-normal text-muted">Vendor of record: {vendor.knownDomain}</span>}
              </>
            }
          />
          <Detail
            term="Callback number"
            value={
              assessment?.verifiedCallbackPhone ? (
                <>
                  <span>{assessment.verifiedCallbackPhone}</span>
                  <span className="block font-sans text-xs font-normal text-muted">From registry records. Invoice number ignored.</span>
                </>
              ) : straightThrough ? (
                <span className="block font-sans text-sm font-normal text-muted">Not needed. The beneficiary matched the vendor master.</span>
              ) : (
                <span className="block font-sans text-sm font-normal text-muted">Resolved from public registries, never the invoice</span>
              )
            }
          />
        </dl>

        <div className="flex flex-col gap-4 px-4 py-5 sm:px-5 md:px-7">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Verification progress">
            {STAGES.map((label, i) => {
              const skipped = straightThrough && i > 0 && i < 4;
              const complete = !skipped && (i < done || (straightThrough && i === 4));
              const active = ACTIVE[payment.status] === i;
              const redStage = frozen && i >= 3;
              return (
                <li key={label} className="flex items-center gap-1.5" aria-current={active ? "step" : undefined}>
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                      active
                        ? "border-brass text-brass motion-safe:animate-pulse"
                        : complete
                          ? redStage
                            ? "border-signal bg-signal text-vault"
                            : "border-paper/70 bg-paper/90 text-vault"
                          : "border-rule text-muted"
                    }`}
                    aria-hidden
                  >
                    {complete ? (
                      <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="m2.5 6.25 2.25 2.25L9.5 3.75" />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className={`mr-2 text-sm ${complete || active ? "text-paper" : "text-muted"} ${skipped ? "line-through" : ""}`}>
                    {label}
                    <span className="sr-only">{skipped ? ", not needed" : complete ? ", done" : active ? ", in progress" : ", not started"}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {assessment && (
              <p className="text-sm">
                <span className="text-muted">Risk </span>
                <span className={`font-display text-lg font-semibold ${RISK_TONE[assessment.level]}`}>
                  {assessment.level.toLowerCase()} {assessment.score}
                </span>
              </p>
            )}

            <div className="no-print ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
              {cleared && (
                <a href={`/incident/${payment.id}`} target="_blank" className="text-sm text-cleared underline underline-offset-4 hover:text-paper">
                  View release receipt<span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
              <button
                type="button"
                onClick={() => actionable && onRelease()}
                aria-disabled={!actionable}
                className={`inline-flex min-w-[12.5rem] items-center justify-center gap-2 rounded-md px-5 py-2.5 font-display text-lg font-semibold transition-colors ${
                  actionable
                    ? "bg-paper text-vault hover:bg-white"
                    : payment.status === "RECEIVED"
                      ? "cursor-progress bg-paper/80 text-vault"
                      : `cursor-default border ${frozen ? "border-signal/60 text-signal" : cleared ? "border-cleared/60 text-cleared" : "border-brass/60 text-brass"}`
                }`}
              >
                {payment.status === "RECEIVED" ? (busy ? "Verifying…" : PRIMARY_LABEL.RECEIVED) : PRIMARY_LABEL[payment.status]}
              </button>
            </div>
          </div>
        </div>

        {assessment && !cleared && (
          <p className="border-t border-rule px-4 py-3 text-sm text-muted sm:px-5 md:px-7">{rationaleText(assessment.rationale)}</p>
        )}

        {frozen && <FrozenBand ref={band} payment={payment} context={freeze} />}
      </div>

      {overlay && (
        <ResolutionShield
          payment={payment}
          context={freeze}
          onDismiss={() => {
            dismissed.current = true;
            setStamping(false);
          }}
        />
      )}
    </article>
  );
}

function Detail({ term, value, changed }: { term: string; value: React.ReactNode; changed?: boolean }) {
  return (
    <div className="min-w-0 bg-panel px-4 py-3 sm:px-5 md:px-7">
      <dt className="flex items-center gap-2 text-xs text-muted">
        {term}
        {changed && (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brass" aria-hidden />
            <span className="sr-only">(changed on this invoice)</span>
          </>
        )}
      </dt>
      <dd className="mt-1 font-display text-lg font-medium">{value}</dd>
    </div>
  );
}
