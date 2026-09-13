import { MockPaymentSource, MockVendorDirectory } from "./mock";

// The AP queue and vendor master stay app-owned SQLite tables. The payment rail (PAYMENT_SOURCE=column) is the
// engine's columnRail, configured in src/lib/engine.ts.

export function paymentSource(): MockPaymentSource {
  return new MockPaymentSource();
}

export function vendorDirectory(): MockVendorDirectory {
  return new MockVendorDirectory();
}
