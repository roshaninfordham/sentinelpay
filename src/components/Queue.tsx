"use client";

import type { Payment, Vendor } from "@/lib/types";
import { STATUS_LABEL, STATUS_TONE, usd } from "./format";

export function Queue({
  payments,
  vendors,
  selectedId,
  onSelect,
}: {
  payments: Payment[];
  vendors: Vendor[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside aria-label="Disbursement queue" className="min-w-0">
      <h2 className="mb-3 font-display text-lg font-semibold">Outgoing wires</h2>
      <ul className="flex flex-col gap-2">
        {payments.map((p) => {
          const v = vendors.find((x) => x.id === p.vendorId);
          const changed = v && p.claimedBankLast4 !== v.knownBankLast4;
          const selected = p.id === selectedId;
          return (
            <li key={p.id}>
              <button
                onClick={() => onSelect(p.id)}
                aria-pressed={selected}
                className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                  selected ? "border-muted bg-panel-2" : "border-rule bg-panel hover:border-muted/60"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-xl font-semibold">{usd(p.amountCents, 0)}</span>
                  <span className={`rounded border px-1.5 py-px text-xs ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                </div>
                <div className="mt-1 truncate text-sm">{v?.legalName ?? p.vendorId}</div>
                {changed && p.status === "RECEIVED" && (
                  <div className="mt-1 text-xs text-brass">Bank details changed on this invoice</div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
