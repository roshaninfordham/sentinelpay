import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Written by `pnpm column:setup` to .column-sandbox.json (local) and printed for COLUMN_SANDBOX_CONFIG (Vercel).
// Holds sandbox object ids only, no secrets.

export interface ColumnSandboxConfig {
  createdAt: string;
  bankAccountId: string;
  accountNumberId: string;
  // Counterparty ids keyed by seed payment id: the beneficiary record the rail would pay.
  paymentCounterparties: Record<string, string>;
  // Counterparty ids of the vendor-of-record accounts, keyed by vendor id (for reference).
  vendorCounterparties: Record<string, string>;
}

export const COLUMN_CONFIG_PATH = path.join(process.cwd(), ".column-sandbox.json");

/**
 * Reads the sandbox object ids: inline JSON first (Vercel's COLUMN_SANDBOX_CONFIG, since there is no local file),
 * then the file written by `pnpm column:setup`. The caller supplies both; this module never reads env.
 */
export function loadColumnConfig(source: { json?: string; file?: string }): ColumnSandboxConfig | null {
  if (source.json) {
    try {
      return JSON.parse(source.json) as ColumnSandboxConfig;
    } catch {
      console.error("[sentinelpay] COLUMN_SANDBOX_CONFIG is not valid JSON");
      return null;
    }
  }
  const file = source.file ?? COLUMN_CONFIG_PATH;
  // Local development only (Vercel uses the inline JSON), so the file is kept out of output tracing.
  if (!existsSync(/*turbopackIgnore: true*/ file)) return null;
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as ColumnSandboxConfig;
  } catch {
    return null;
  }
}

/** The scenario's beneficiary accounts, created on the Column sandbox by the setup script. */
export const SANDBOX_ACCOUNTS = {
  // Wells Fargo ABA routing number; sandbox never contacts the receiving bank.
  routing: "121000248",
  // Beneficiary addresses are required for wires. Fictional scenario addresses.
  addresses: {
    meridian: { line_1: "233 S Wacker Dr", city: "Chicago", state: "IL", postal_code: "60606", country_code: "US" },
    northwind: { line_1: "1200 Alaskan Way", city: "Seattle", state: "WA", postal_code: "98101", country_code: "US" },
  },
  vendors: {
    v_meridian: { account: "300038104471", name: "Meridian Global Logistics LLC", description: "Vendor of record (on file)", address: "meridian" },
    v_northwind: { account: "500045102208", name: "Northwind Freight Partners Inc.", description: "Vendor of record (on file)", address: "northwind" },
  },
  payments: {
    // The poisoned invoice: same payee name, attacker-controlled account ending 9821.
    pay_240k: { account: "770001939821", name: "Meridian Global Logistics LLC", description: "Beneficiary from INV-88412 remittance update", address: "meridian" },
    pay_18k: { vendor: "v_northwind" },
  },
} as const;
