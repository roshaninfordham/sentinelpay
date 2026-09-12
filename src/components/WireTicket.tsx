"use client";

import type { CallOutcome, Payment, PaymentStatus, RiskAssessment, Vendor } from "@/lib/types";
import { STATUS_LABEL, STATUS_TONE, usd } from "./format";
import { ResolutionShield } from "./ResolutionShield";

const STAGES: { label: string; reached: PaymentStatus[] }[] = [
  { label: "Release requested", reached: ["PENDING_REVIEW", "INVESTIGATING", "CHALLENGING", "QUARANTINED", "CLEARED"] },
  { label: "Held", reached: ["PENDING_REVIEW", "INVESTIGATING", "CHALLENGING", "QUARANTINED"] },
  { label: "Investigated", reached: ["CHALLENGING", "QUARANTINED"] },
  { label: "Vendor called", reached: ["QUARANTINED"] },
  { label: "Resolved", reached: ["QUARANTINED", "CLEARED"] },
];
const ACTIVE: Partial<Record<PaymentStatus, number>> = { INVESTIGATING: 2, CHALLENGING: 3 };

const RISK_TONE = { LOW: "text-cleared", ELEVATED: "text-brass", CRITICAL: "text-signal" } as const;

export function WireTicket({
  payment,
  vendor,
  assessment,
  call,
  busy,
  onRelease,
}: {
  payment: Payment;
  vendor: Vendor;
  assessment?: RiskAssessment;
  call?: CallOutcome;
  busy: boolean;
  onRelease: () => void;
}) {
  const bankChanged = payment.claimedBankLast4 !== vendor.knownBankLast4;
  const domainChanged = payment.requestSourceDomain !== vendor.knownDomain;
  const frozen = payment.status === "QUARANTINED";
  const cleared = payment.status === "CLEARED";
  // A clean payment released straight through the gate skips the middle stages.
  const straightThrough = cleared && !assessment;

  return (
    <article
      aria-label="Selected wire"
      className={`relative overflow-hidden rounded-md border bg-panel transition-colors duration-500 ${
        frozen ? "border-signal/70" : "border-rule"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 md:px-7 md:pt-6">
        <div className="min-w-0">
          <p className="text-sm text-muted">Wire to</p>
          <h2 className="font-display text-2xl font-semibold leading-tight">{vendor.legalName}</h2>
          {payment.memo && <p className="mt-1 text-sm text-muted">{payment.memo}</p>}
        </div>
        <span className={`rounded border px-2 py-0.5 text-sm ${STATUS_TONE[payment.status]}`}>{STATUS_LABEL[payment.status]}</span>
      </div>

      <p
        className={`px-5 font-display text-[clamp(3rem,7vw,5.75rem)] font-semibold leading-none tracking-tight md:px-7 ${
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
                <span className="text-muted line-through decoration-muted/70">••{vendor.knownBankLast4}</span>
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
              <span className={domainChanged ? "text-brass" : ""}>{payment.requestSourceDomain}</span>
              {domainChanged && <span className="block text-xs text-muted">Vendor of record: {vendor.knownDomain}</span>}
            </>
          }
        />
        <Detail
          term="Callback number"
          value={
            assessment?.verifiedCallbackPhone ? (
              <>
                <span>{assessment.verifiedCallbackPhone}</span>
                <span className="block text-xs text-muted">From registry records. Invoice number ignored.</span>
              </>
            ) : (
              <span className="block text-sm font-normal text-muted">Resolved from public registries, never the invoice</span>
            )
          }
        />
      </dl>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-5 md:px-7">
        <ol className="flex flex-1 flex-wrap items-center gap-x-1 gap-y-2" aria-label="Verification progress">
          {STAGES.map((s, i) => {
            const skipped = straightThrough && i > 0 && i < 4;
            const done = !skipped && s.reached.includes(payment.status);
            const active = ACTIVE[payment.status] === i;
            return (
              <li key={s.label} className="flex items-center gap-1">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${
                    active
                      ? "animate-pulse border-brass text-brass"
                      : done
                        ? frozen && i >= 3
                          ? "border-signal bg-signal text-vault"
                          : "border-paper/70 bg-paper/90 text-vault"
                        : "border-rule text-muted"
                  }`}
                >
                  {i + 1}
                </span>
                <span className={`mr-2 text-sm ${done || active ? "text-paper" : "text-muted"} ${skipped ? "line-through" : ""}`}>{s.label}</span>
              </li>
            );
          })}
        </ol>

        {assessment && (
          <p className="text-sm">
            <span className="text-muted">Risk </span>
            <span className={`font-display text-lg font-semibold ${RISK_TONE[assessment.level]}`}>
              {assessment.level.toLowerCase()} {assessment.score}
            </span>
          </p>
        )}

        {payment.status === "RECEIVED" && (
          <button
            onClick={onRelease}
            disabled={busy}
            className="no-print ml-auto rounded-md bg-paper px-5 py-2.5 font-display text-lg font-semibold text-vault transition-colors hover:bg-white disabled:opacity-60"
          >
            Release payment
          </button>
        )}
        {cleared && (
          <a href={`/incident/${payment.id}`} target="_blank" className="ml-auto text-sm text-cleared underline underline-offset-4">
            View release receipt
          </a>
        )}
      </div>

      {assessment && !frozen && (
        <p className="border-t border-rule px-5 py-3 text-sm text-muted md:px-7">{assessment.rationale}</p>
      )}

      {frozen && <ResolutionShield payment={payment} call={call} />}
    </article>
  );
}

function Detail({ term, value, changed }: { term: string; value: React.ReactNode; changed?: boolean }) {
  return (
    <div className="bg-panel px-5 py-3 md:px-7">
      <dt className="flex items-center gap-2 text-xs text-muted">
        {term}
        {changed && <span className="h-1.5 w-1.5 rounded-full bg-brass" aria-label="changed" />}
      </dt>
      <dd className="mt-1 font-display text-lg font-medium">{value}</dd>
    </div>
  );
}
