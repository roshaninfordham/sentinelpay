"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { CallOutcome, Payment } from "@/lib/types";
import { usd } from "./format";

// The one loud moment in the interface: the freeze lands on the wire ticket.
export function ResolutionShield({ payment, call }: { payment: Payment; call?: CallOutcome }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 flex items-center justify-center bg-vault/80 p-6 backdrop-blur-[2px]"
    >
      <motion.div
        initial={reduce ? false : { scale: 1.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 22, delay: 0.1 }}
        className="flex max-w-2xl flex-col items-center text-center"
      >
        <svg viewBox="0 0 120 138" className="h-28 w-24 drop-shadow-[0_0_28px_rgba(229,72,77,0.45)] md:h-36 md:w-32" aria-hidden>
          <path d="M60 4 114 22v40c0 33-22.5 58-54 72C28.5 120 6 95 6 62V22L60 4Z" fill="#e5484d" />
          <path d="M60 16 102 30v32c0 26-17.5 46-42 58-24.5-12-42-32-42-58V30l42-14Z" fill="none" stroke="#0d1822" strokeWidth="4" />
          <rect x="44" y="56" width="32" height="26" rx="3" fill="#0d1822" />
          <path d="M49 56v-7a11 11 0 0 1 22 0v7" fill="none" stroke="#0d1822" strokeWidth="6" />
        </svg>
        <motion.p
          initial={reduce ? false : { rotate: -9, scale: 1.3 }}
          animate={{ rotate: -3, scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 18, delay: 0.25 }}
          className="mt-5 rounded border-[3px] border-signal px-4 py-1.5 font-display text-[clamp(1.25rem,2.6vw,2.1rem)] font-bold leading-tight text-signal sm:whitespace-nowrap"
        >
          PAYMENT FROZEN · {usd(payment.amountCents, 0)} SAVED
        </motion.p>
        <p className="mt-3 max-w-md text-sm text-paper/85">
          {call?.verdict === "DENIED"
            ? "The vendor's real controller denied the bank change on an independently verified line."
            : "The challenge was inconclusive, so the wire failed closed."}
        </p>
        <a
          href={`/incident/${payment.id}`}
          target="_blank"
          className="no-print mt-4 rounded-md border border-paper/40 px-4 py-2 text-sm text-paper transition-colors hover:border-paper"
        >
          Open incident receipt
        </a>
      </motion.div>
    </motion.div>
  );
}
