import { demoMode } from "../env";
import type { PaymentRail } from "../types";
import { ColumnClient } from "./column-client";
import { loadColumnConfig } from "./column-config";
import { ColumnPaymentSource } from "./column";
import { MockPaymentSource, MockVendorDirectory } from "./mock";

// PAYMENT_SOURCE=mock|column. Column falls back to mock (with a reason shown in the dashboard)
// when offline mode is on, the key is missing, or `pnpm column:setup` has not been run.
export function railStatus(): { name: PaymentRail; note?: string } {
  if (process.env.PAYMENT_SOURCE !== "column") return { name: "mock" };
  if (demoMode() === "cache") return { name: "mock", note: "PAYMENT_SOURCE=column ignored in DEMO_MODE=cache" };
  if (!process.env.COLUMN_API_KEY) return { name: "mock", note: "COLUMN_API_KEY not set" };
  if (!process.env.COLUMN_API_KEY.startsWith("test_")) return { name: "mock", note: "COLUMN_API_KEY is not a sandbox (test_) key" };
  if (!loadColumnConfig()) return { name: "mock", note: "run `pnpm column:setup` first" };
  return { name: "column" };
}

export function paymentSource(): MockPaymentSource {
  if (railStatus().name === "column") {
    return new ColumnPaymentSource(ColumnClient.fromEnv()!, loadColumnConfig()!);
  }
  return new MockPaymentSource();
}

export function vendorDirectory(): MockVendorDirectory {
  return new MockVendorDirectory();
}
