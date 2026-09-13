"use client";

import { useEffect, useRef, useState } from "react";

const THRESHOLDS = [5 * 60, 60] as const;

const format = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Visible ticking timer plus a separate polite live region that only speaks at 5 minutes and 1 minute left,
 * so screen readers are not interrupted every second.
 */
export function Countdown({ expiresAt, className = "" }: { expiresAt: string; className?: string }) {
  const deadline = new Date(expiresAt).getTime();
  const [now, setNow] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(new Set<number>());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const left = now === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));

  useEffect(() => {
    if (left === null) return;
    for (const mark of THRESHOLDS) {
      // Announce when crossing a mark, never for marks already passed when the timer first renders.
      if (left <= mark && left > mark - 5 && !announced.current.has(mark)) {
        announced.current.add(mark);
        const t = setTimeout(() => setAnnouncement(mark === 60 ? "1 minute left to confirm." : "5 minutes left to confirm."), 0);
        return () => clearTimeout(t);
      }
    }
  }, [left]);

  const urgent = left !== null && left <= 60;
  return (
    <div className={className}>
      <p className={`inline-flex items-baseline gap-2 rounded border px-2.5 py-1 text-sm ${urgent ? "border-signal/60 text-signal" : "border-brass/50 text-brass"}`}>
        {left === 0 ? (
          "Expired"
        ) : (
          <>
            <span className="min-w-[3.5ch] font-mono text-base tabular-nums">{left === null ? "–:––" : format(left)}</span>
            <span>left</span>
          </>
        )}
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  );
}
