"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";
import type { Payment } from "@/lib/types";
import { explanation, Receipt, ShieldGlyph, stamp, type FreezeContext } from "./FreezeStamp";

/**
 * The one loud moment in the interface: when a wire freezes while the operator watches, the stamp lands over the
 * ticket (whose content is inert meanwhile) and focus moves to the receipt link if it was lost. "View case details"
 * collapses it to the band below.
 */
export function ResolutionShield({ payment, context, onDismiss }: { payment: Payment; context: FreezeContext; onDismiss: () => void }) {
  const reduce = useReducedMotion();
  const link = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const active = document.activeElement;
    const ticket = link.current?.closest("article");
    // Only take focus that was lost (a button that unmounted) or that sits on the ticket under the stamp.
    if (!active || active === document.body || (ticket && ticket.contains(active))) {
      link.current?.focus({ preventScroll: true });
      // On a stacked layout the ticket may be above the fold: bring the stamp, not just the link's edge, into view.
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      link.current?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  }, []);

  return (
    <motion.div
      role="status"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-vault/85 p-4 backdrop-blur-[2px] sm:p-6"
    >
      <motion.div
        initial={reduce ? false : { scale: 1.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 22, delay: 0.1 }}
        className="flex max-w-2xl flex-col items-center text-center"
      >
        <ShieldGlyph className="h-20 w-[4.5rem] drop-shadow-[0_0_28px_rgba(229,72,77,0.45)] sm:h-28 sm:w-24 md:h-36 md:w-32" />
        <motion.p
          initial={reduce ? false : { rotate: -9, scale: 1.3 }}
          animate={{ rotate: -3, scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 18, delay: 0.25 }}
          className="mt-4 rounded border-[3px] border-signal px-3 py-1 font-display text-[clamp(1.2rem,2.6vw,2.1rem)] font-bold leading-tight text-signal sm:mt-5 sm:whitespace-nowrap sm:px-4 sm:py-1.5"
        >
          {stamp(payment, context.reason)}
        </motion.p>
        <p className="mt-3 max-w-md text-sm text-paper">{explanation(context)}</p>
        <div className="no-print mt-4 flex flex-wrap items-center justify-center gap-3">
          <Receipt ref={link} payment={payment} className="rounded-md border border-paper/40 px-4 py-2 text-sm text-paper transition-colors hover:border-paper" />
          <button type="button" onClick={onDismiss} className="rounded-md px-4 py-2 text-sm text-muted underline underline-offset-4 transition-colors hover:text-paper">
            View case details
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
