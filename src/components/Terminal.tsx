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

// Probe lines served from recorded captures end in "[cached]" or "[cached: note]"; shown as a badge instead.
const CACHED = /\s+\[cached(?::\s*([^\]]+))?\]$/;

export function Terminal({ lines, evidence }: { lines: TimelineLine[]; /** Where probe evidence comes from, e.g. "Live RDAP and Tavily". */ evidence: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // scroll only the log box, never the page
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [lines.length]);

  return (
    <section aria-labelledby="investigation-heading" className="rounded-md border border-rule bg-[#08121a]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-rule px-4 py-2.5">
        <h2 id="investigation-heading" className="font-display text-lg font-semibold">
          Investigation
        </h2>
        <span className="text-sm text-muted">{evidence}</span>
      </div>
      <div
        ref={box}
        role="log"
        aria-live="polite"
        aria-labelledby="investigation-heading"
        tabIndex={0}
        className="scroll-thin h-[260px] overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-6 min-[1200px]:h-[300px]"
      >
        {lines.length === 0 ? (
          <p className="text-muted">Findings appear here after you select Verify and release.</p>
        ) : (
          lines.map((l) => {
            const cached = CACHED.exec(l.text);
            const text = cached ? l.text.slice(0, cached.index) : l.text;
            return (
              <div key={l.id} className="grid grid-cols-[4.25rem_1fr] gap-2">
                <span className="text-muted" suppressHydrationWarning>{clock(l.ts)}</span>
                <span className={`break-words ${TONE[l.kind]}`}>
                  {text}
                  {cached && (
                    <span
                      className="ml-2 inline-block rounded border border-rule px-1 align-[1px] text-[10.5px] font-normal leading-4 text-muted"
                      title={cached[1] ? `Recorded fixture: ${cached[1]}` : "Recorded fixture"}
                    >
                      recorded fixture{cached[1] && <span className="sr-only">: {cached[1]}</span>}
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
