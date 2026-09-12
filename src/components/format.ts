import type { PaymentStatus } from "@/lib/types";

export const usd = (cents: number, digits = 2) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const STATUS_LABEL: Record<PaymentStatus, string> = {
  RECEIVED: "Pending release",
  PENDING_REVIEW: "Held",
  INVESTIGATING: "Investigating",
  CHALLENGING: "Calling vendor",
  QUARANTINED: "Frozen",
  CLEARED: "Released",
};

export const STATUS_TONE: Record<PaymentStatus, string> = {
  RECEIVED: "text-paper border-rule",
  PENDING_REVIEW: "text-brass border-brass/60",
  INVESTIGATING: "text-brass border-brass/60",
  CHALLENGING: "text-brass border-brass/60",
  QUARANTINED: "text-signal border-signal/70",
  CLEARED: "text-cleared border-cleared/60",
};

export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
