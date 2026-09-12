"use client";

import { useEffect, useRef } from "react";
import type { TimelineKind, TimelineLine } from "@/lib/types";
import { clock } from "./format";

const TONE: Record<TimelineKind, string> = {
  info: "text-muted",
  probe: "text-paper",
  warn: "text-brass",
  risk: "text-signal font-semibold",
  call: "text-brass",
  ok: "text-cleared",
  alert: "text-signal",
};

export function Terminal({ lines }: { lines: TimelineLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // scroll only the log box, never the page
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [lines.length]);

  return (
    <section aria-label="Investigation log" className="rounded-md border border-rule bg-[#08121a]">
      <h2 className="border-b border-rule px-4 py-2.5 font-display text-lg font-semibold">Investigation</h2>
      <div ref={box} className="scroll-thin h-[300px] overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-6" aria-live="polite">
        {lines.length === 0 ? (
          <p className="text-muted">Findings appear here when a payment is released.</p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="grid grid-cols-[4.5rem_1fr] gap-2">
              <span className="text-muted/60">{clock(l.ts)}</span>
              <span className={`break-words ${TONE[l.kind]}`}>{l.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
