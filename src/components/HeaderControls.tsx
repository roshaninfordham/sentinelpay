"use client";

import { useState } from "react";
import type { Snapshot } from "@/lib/types";
import type { DemoSettings } from "./CallConsole";
import { Popover } from "./Popover";

const CHIP = "inline-flex items-center gap-2 rounded border px-2.5 py-1 text-sm transition-colors";

interface Health {
  environment: string;
  storage: string;
  rail: string;
  probes: Array<{ id: string; origin: string }>;
  challengers: Array<{ channel: string; assurance: string }>;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function environmentLabel(snap: Pick<Snapshot, "environment" | "demoMode" | "rail">): string {
  return [
    cap(snap.environment),
    snap.demoMode === "cache" ? "Offline fixtures" : "Live data",
    snap.rail.name === "column" ? "Column sandbox rail" : "Mock rail",
  ].join(" · ");
}

export function EnvironmentChip({ snap }: { snap: Pick<Snapshot, "environment" | "demoMode" | "rail"> }) {
  const [health, setHealth] = useState<Health | null>(null);
  const production = snap.environment === "production";

  const load = () => {
    fetch("/api/v1/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((h: Health | null) => h && setHealth(h))
      .catch(() => undefined);
  };

  return (
    <Popover
      label="Environment details"
      onOpen={load}
      triggerClassName={`${CHIP} ${production ? "border-cleared/50 text-cleared" : "border-rule text-muted hover:border-muted hover:text-paper"}`}
      trigger={
        <>
          <span className="sr-only">Environment: </span>
          {environmentLabel(snap)}
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <Row k="Environment" v={cap(snap.environment)} />
        <Row
          k="Evidence"
          v={
            snap.demoMode === "cache"
              ? "Recorded fixtures. Works offline; a fixture can never clear a payment in production."
              : "Live registry and web search, with fixture fallback outside production."
          }
        />
        {health && (
          <>
            <Row k="Probes" v={health.probes.map((p) => `${p.id} (${p.origin})`).join(", ")} />
            <Row k="Confirmation" v={health.challengers.map((c) => `${c.channel.replace(/_/g, " ")} (${c.assurance.replace(/_/g, " ")})`).join(", ")} />
            <Row k="Storage" v={health.storage} />
          </>
        )}
        <Row
          k="Rail"
          v={
            snap.rail.name === "column"
              ? "Column sandbox. Beneficiaries are read from the rail; a release creates a sandbox wire."
              : `Mock AP queue. Release and freeze only change state${snap.rail.note ? ` (${snap.rail.note})` : ""}.`
          }
        />
      </dl>
    </Popover>
  );
}

export function AuditIndicator({ chain, entries }: { chain: Snapshot["chain"]; entries: number }) {
  const ok = chain.ok;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm ${ok ? "text-cleared" : "font-medium text-signal"}`}
      title="Every ledger entry's SHA-256 hash is recomputed when a new entry is written, and at least once a minute"
    >
      <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        {ok ? <path d="m2.5 6.25 2.25 2.25L9.5 3.75" /> : <path d="M3 3l6 6M9 3 3 9" />}
      </svg>
      {ok
        ? entries === 0
          ? "Audit chain empty"
          : `Audit chain verified · ${entries} ${entries === 1 ? "entry" : "entries"}`
        : `Audit chain broken at #${chain.brokenAt}`}
    </span>
  );
}

export function DemoControls({
  settings,
  onChange,
  onReset,
  busy,
}: {
  settings: DemoSettings;
  onChange: (next: DemoSettings) => void;
  onReset: () => void;
  busy: boolean;
}) {
  return (
    <Popover
      label="Demo controls"
      triggerClassName={`${CHIP} border-rule text-muted hover:border-muted hover:text-paper`}
      trigger="Demo controls"
    >
      <fieldset>
        <legend className="mb-2 text-xs text-muted">On a scripted call, the vendor</legend>
        <div className="flex flex-col gap-1.5">
          {(
            [
              ["deny", "Denies the change"],
              ["authorize", "Confirms the change"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex cursor-pointer items-center gap-2.5 rounded px-1 py-0.5 hover:bg-panel">
              <input
                type="radio"
                name="vendor-answer"
                value={value}
                checked={settings.vendorAnswer === value}
                onChange={() => onChange({ ...settings, vendorAnswer: value })}
                className="h-4 w-4 accent-[var(--brass)]"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-3 flex cursor-pointer items-center gap-2.5 border-t border-rule px-1 pt-3">
        <input
          type="checkbox"
          checked={settings.voiceOn}
          onChange={(e) => onChange({ ...settings, voiceOn: e.target.checked })}
          className="h-4 w-4 accent-[var(--brass)]"
        />
        Speak the call aloud
      </label>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-rule pt-3">
        <p className="text-xs text-muted">Restores both seeded wires.</p>
        <button
          type="button"
          onClick={() => !busy && onReset()}
          aria-disabled={busy}
          className="rounded border border-rule px-3 py-1 text-sm text-paper transition-colors hover:border-muted aria-disabled:cursor-progress aria-disabled:opacity-60"
        >
          Reset demo
        </button>
      </div>
    </Popover>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="text-paper">{v}</dd>
    </>
  );
}
