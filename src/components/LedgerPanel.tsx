"use client";

import type { LedgerEntry } from "@/lib/types";
import { clock, shortHash } from "./format";

const EVENT_LABEL: Record<string, string> = {
  INTERCEPTED: "Intercepted at release",
  INVESTIGATION_STARTED: "Forensics started",
  FORENSICS: "Risk assessed",
  CHALLENGE_STARTED: "Out-of-band call placed",
  CALL_RESULT: "Call outcome recorded",
  FROZEN: "Wire frozen",
  CLEARED: "Wire released",
  RAIL_RELEASED: "Sandbox wire created",
  RAIL_ERROR: "Rail release failed",
};

export function LedgerPanel({ entries, chainOk }: { entries: LedgerEntry[]; chainOk: boolean }) {
  return (
    <section aria-label="Audit ledger" className="rounded-md border border-rule bg-panel">
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-2.5">
        <h2 className="font-display text-lg font-semibold">Audit trail</h2>
        <span className="text-xs text-muted">SHA-256 hash chain {chainOk ? "verified" : "failed verification"}</span>
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">Each decision on this payment is written here, linked to the one before it.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">Seq</th>
                <th className="px-2 py-2 font-normal">Event</th>
                <th className="px-2 py-2 font-normal">Time</th>
                <th className="px-2 py-2 font-normal">Previous</th>
                <th className="px-4 py-2 font-normal">Entry hash</th>
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
    </section>
  );
}
