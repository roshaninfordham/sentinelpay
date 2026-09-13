"use client";

import { useRef } from "react";
import type { Payment, Vendor } from "@/lib/types";
import { TERMINAL_STATUS, usd } from "./format";
import { StatusPill } from "./StatusPill";

// Single-select listbox: selection follows focus, with roving tabindex so Tab lands on the selected wire.
export function Queue({
  payments,
  vendors,
  requesters,
  selectedId,
  onSelect,
}: {
  payments: Payment[];
  vendors: Vendor[];
  requesters: Record<string, string>;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Released and frozen wires stay listed but are no longer waiting on anyone.
  const waiting = payments.filter((p) => !TERMINAL_STATUS.has(p.status)).length;

  const move = (e: React.KeyboardEvent) => {
    const index = payments.findIndex((p) => p.id === selectedId);
    const last = payments.length - 1;
    const next =
      e.key === "ArrowDown" ? Math.min(last, index + 1)
        : e.key === "ArrowUp" ? Math.max(0, index - 1)
          : e.key === "Home" ? 0
            : e.key === "End" ? last
              : null;
    if (next === null || next < 0) return;
    e.preventDefault();
    const id = payments[next].id;
    onSelect(id);
    list.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
  };

  return (
    <aside aria-labelledby="queue-heading" className="min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 id="queue-heading" className="font-display text-lg font-semibold">Outgoing wires</h2>
        {payments.length > 0 && <span className="text-xs text-muted">{waiting === 0 ? "None waiting" : `${waiting} waiting`}</span>}
      </div>
      {payments.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule px-3 py-4 text-sm text-muted">
          No payments waiting. Payments submitted by your AP system or agents appear here.
        </p>
      ) : (
        <div ref={list} role="listbox" aria-labelledby="queue-heading" aria-orientation="vertical" onKeyDown={move} className="flex flex-col gap-2">
          {payments.map((p) => {
            const v = vendors.find((x) => x.id === p.vendorId);
            const changed = v && p.claimedBankLast4 !== v.knownBankLast4;
            const selected = p.id === selectedId;
            const via = requesters[p.id];
            return (
              <div
                key={p.id}
                data-id={p.id}
                role="option"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(p.id);
                  }
                }}
                className={`relative cursor-pointer rounded-md border px-3 py-3 transition-colors ${
                  selected ? "border-muted bg-panel-2" : "border-rule bg-panel hover:border-muted/60"
                }`}
              >
                {selected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brass" aria-hidden />}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-xl font-semibold">{usd(p.amountCents, 0)}</span>
                  <StatusPill status={p.status} />
                </div>
                <div className="mt-1 truncate text-sm">{v?.legalName ?? p.vendorId}</div>
                {(changed && p.status === "RECEIVED") || via ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    {changed && p.status === "RECEIVED" && <span className="text-brass">Bank details changed on this invoice</span>}
                    {via && <span className="rounded bg-vault px-1.5 py-px font-mono text-muted">via agent: {via}</span>}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
