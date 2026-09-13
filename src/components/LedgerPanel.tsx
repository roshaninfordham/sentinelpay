"use client";

import type { LedgerEntry } from "@/lib/types";
import { clock, shortHash } from "./format";

const EVENT_LABEL: Record<string, string> = {
  INTERCEPTED: "Intercepted at release",
  INVESTIGATION_STARTED: "Forensics started",
  FORENSICS: "Risk assessed",
  CHALLENGE_STARTED: "Vendor confirmation opened",
  CALL_RESULT: "Vendor answer recorded",
  FROZEN: "Wire frozen",
  CLEARED: "Wire released",
  RAIL_RELEASED: "Sandbox wire created",
  RAIL_ERROR: "Rail release failed",
  RESPONDER_TOKEN_REJECTED: "Confirmation rejected",
  IDEMPOTENCY_CONFLICT: "Conflicting resubmission",
};

// The case's slice of the hash chain, collapsed by default. The full chain lives on the receipt.
export function LedgerPanel({ paymentId, entries, chainOk }: { paymentId: string; entries: LedgerEntry[]; chainOk: boolean }) {
  return (
    <details className="group rounded-md border border-rule bg-panel">
      <summary className="flex cursor-pointer items-center gap-3 rounded-md px-4 py-3 hover:bg-panel-2/60">
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden>
          <path d="m3.5 2 3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="font-display text-base font-semibold">Audit</span>
        <span className="min-w-0 truncate text-sm text-muted">
          {entries.length === 0 ? "No entries for this payment yet" : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} for this payment`}
        </span>
        <span className={`ml-auto shrink-0 text-xs ${chainOk ? "hidden text-muted sm:inline" : "text-signal"}`}>
          {chainOk ? "SHA-256 chain verified" : "Chain failed verification"}
        </span>
      </summary>
      <div className="border-t border-rule">
        {entries.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">Audit chain empty. Each decision on this payment is written here, linked to the one before it.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">Ledger entries for this payment</caption>
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-normal">Seq</th>
                  <th scope="col" className="px-2 py-2 font-normal">Event</th>
                  <th scope="col" className="px-2 py-2 font-normal">Time</th>
                  <th scope="col" className="px-2 py-2 font-normal">Previous</th>
                  <th scope="col" className="px-4 py-2 font-normal">Entry hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.seq} className="border-t border-rule/60">
                    <td className="px-4 py-1.5 text-muted">{e.seq}</td>
                    <td className={`px-2 py-1.5 ${e.event === "FROZEN" ? "text-signal" : e.event === "CLEARED" ? "text-cleared" : ""}`}>
                      {EVENT_LABEL[e.event] ?? e.event}
                    </td>
                    <td className="px-2 py-1.5 text-muted" suppressHydrationWarning>{clock(e.ts)}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-muted">{shortHash(e.prevHash)}</td>
                    <td className="px-4 py-1.5 font-mono text-xs">{shortHash(e.entryHash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-rule px-4 py-2.5 text-xs text-muted">
          <a href={`/incident/${paymentId}`} target="_blank" className="text-paper underline underline-offset-4 hover:text-white">
            Open the receipt<span className="sr-only"> (opens in a new tab)</span>
          </a>{" "}
          for the full chain and head hash.
        </p>
      </div>
    </details>
  );
}
