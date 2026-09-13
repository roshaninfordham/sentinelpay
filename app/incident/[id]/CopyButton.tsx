"use client";

import { useState } from "react";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="no-print shrink-0 rounded border border-rule px-2.5 py-1 text-xs text-paper transition-colors hover:border-muted"
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Head hash copied to clipboard" : state === "failed" ? "Could not copy the head hash" : ""}
      </span>
    </>
  );
}
