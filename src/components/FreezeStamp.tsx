import type { Payment } from "@/lib/types";
import { usd } from "./format";

// The freeze's words and marks, free of any animation library so the ticket and band render on first load.
// The animated stamp (ResolutionShield) is loaded separately, only when a wire is being verified.

/** Reasons where the vendor itself refused the account: only these count as money saved rather than held. */
export const SAVED_REASONS = new Set(["VENDOR_DENIED_CHANGE", "BENEFICIARY_PREVIOUSLY_DENIED"]);

export interface FreezeContext {
  reason?: string;
  /** Assurance tier of the challenge that decided it, when there was one. */
  assurance?: string;
  /** The vendor call was the local script, not a live agent. */
  scripted?: boolean;
}

export function explanation({ reason, assurance, scripted }: FreezeContext): string {
  switch (reason) {
    case "VENDOR_DENIED_CHANGE":
      if (scripted) return "Frozen: the vendor denied the bank change on a scripted sandbox call.";
      return assurance === "out_of_band"
        ? "Frozen: the vendor’s controller denied the bank change on an independently verified line."
        : "Frozen: the vendor’s controller denied the bank change when called on the registry number.";
    case "BLOCKED_BY_PRINCIPAL":
      return "Frozen from the operator console before the vendor answered. Nothing yet shows the change was fraudulent.";
    case "CHALLENGE_EXPIRED":
      return "Frozen: the confirmation expired without an answer, so the wire failed closed.";
    case "CHALLENGE_INCONCLUSIVE":
      return "Frozen: the vendor’s answer was inconclusive, so the wire failed closed.";
    case "NO_CHALLENGE_CHANNEL":
      return "Frozen: no verified callback number was found, so the vendor could not be reached.";
    case "BENEFICIARY_PREVIOUSLY_DENIED":
      return "Frozen: this account was already denied by the vendor on an earlier payment.";
    default:
      return "Frozen: the wire failed closed. No money moved.";
  }
}

export const stamp = (payment: Payment, reason?: string) => `PAYMENT FROZEN · ${usd(payment.amountCents, 0)} ${reason && SAVED_REASONS.has(reason) ? "SAVED" : "HELD"}`;

export function Receipt({ payment, className, ref }: { payment: Payment; className: string; ref?: React.Ref<HTMLAnchorElement> }) {
  return (
    <a ref={ref} href={`/incident/${payment.id}`} target="_blank" className={className}>
      Open incident receipt<span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function ShieldGlyph({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 120 138" className={className} aria-hidden>
      <path d="M60 4 114 22v40c0 33-22.5 58-54 72C28.5 120 6 95 6 62V22L60 4Z" fill="#e5484d" />
      <path d="M60 16 102 30v32c0 26-17.5 46-42 58-24.5-12-42-32-42-58V30l42-14Z" fill="none" stroke="#0d1822" strokeWidth="4" />
      <rect x="44" y="56" width="32" height="26" rx="3" fill="#0d1822" />
      <path d="M49 56v-7a11 11 0 0 1 22 0v7" fill="none" stroke="#0d1822" strokeWidth="6" />
    </svg>
  );
}

/** The settled form of the freeze, in the ticket's flow so the case facts above stay readable. */
export function FrozenBand({ payment, context, ref }: { payment: Payment; context: FreezeContext; ref?: React.Ref<HTMLAnchorElement> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-signal/50 bg-signal/10 px-4 py-4 sm:px-5 md:px-7">
      <ShieldGlyph className="h-9 w-8 shrink-0" />
      <div className="min-w-[min(100%,14rem)] flex-1 basis-56">
        <p className="font-display text-lg font-bold leading-tight text-signal">{stamp(payment, context.reason)}</p>
        <p className="mt-0.5 text-sm text-paper">{explanation(context)}</p>
      </div>
      <Receipt ref={ref} payment={payment} className="no-print shrink-0 rounded-md border border-paper/40 px-3 py-1.5 text-sm text-paper transition-colors hover:border-paper" />
    </div>
  );
}
