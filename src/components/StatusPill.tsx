import type { PaymentStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_TONE } from "./format";

// Status is carried by the glyph and the word; colour only reinforces it.
export function StatusPill({ status, size = "sm" }: { status: PaymentStatus; size?: "sm" | "md" }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border ${STATUS_TONE[status]} ${
        size === "md" ? "px-2 py-0.5 text-sm" : "px-1.5 py-px text-xs"
      }`}
    >
      <StatusGlyph status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StatusGlyph({ status, className = "h-3 w-3" }: { status: PaymentStatus; className?: string }) {
  const common = { className, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;
  switch (status) {
    case "RECEIVED":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" />
        </svg>
      );
    case "PENDING_REVIEW":
    case "INVESTIGATING":
      return (
        <svg {...common}>
          <path d="M4.25 2.5v7M7.75 2.5v7" />
        </svg>
      );
    case "CHALLENGING":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" />
          <path d="M6 3.5V6l1.75 1.25" />
        </svg>
      );
    case "QUARANTINED":
      return (
        <svg {...common}>
          <rect x="2.25" y="5.25" width="7.5" height="5" rx="1" />
          <path d="M3.9 5.25V4a2.1 2.1 0 0 1 4.2 0v1.25" />
        </svg>
      );
    case "CLEARED":
      return (
        <svg {...common}>
          <path d="m2.5 6.25 2.25 2.25L9.5 3.75" />
        </svg>
      );
  }
}
