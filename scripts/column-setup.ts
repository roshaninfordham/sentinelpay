// One-time Column sandbox setup for PAYMENT_SOURCE=column.
//   1. finds your sandbox root entity (or COLUMN_ENTITY_ID)
//   2. creates an "AP operating" bank account and funds it via /simulate/receive-wire
//   3. creates counterparties: each vendor's account on file + the attacker's account on the poisoned invoice
//   4. writes .column-sandbox.json (object ids only; gitignored)
// Usage: COLUMN_API_KEY=test_... pnpm column:setup
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ColumnClient } from "../src/lib/providers/column-client";
import { COLUMN_CONFIG_PATH, SANDBOX_ACCOUNTS, type ColumnSandboxConfig } from "../src/lib/providers/column-config";

const root = path.join(__dirname, "..");
if (existsSync(path.join(root, ".env.local"))) {
  for (const line of readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  if (!process.env.COLUMN_API_KEY) throw new Error("Set COLUMN_API_KEY (sandbox key, starts with test_) in .env.local");
  const client = new ColumnClient(process.env.COLUMN_API_KEY);

  let entityId = process.env.COLUMN_ENTITY_ID;
  if (!entityId) {
    const { entities = [] } = await client.listEntities();
    entityId = entities[0]?.id;
    if (!entityId) {
      entityId = (await client.createBusinessEntity({ business_name: "Acme Corp (SentinelPay sandbox payer)", website: "https://sentinelpay-sigma.vercel.app" })).id;
      console.log("created sandbox payer entity");
    }
  }
  console.log(`entity        ${entityId}`);

  const account = await client.createBankAccount({ entity_id: entityId, description: "SentinelPay AP operating" });
  console.log(`bank account  ${account.id}`);

  await client.simulateReceiveWire({ destination_account_number_id: account.default_account_number_id, amount: 100_000_000 });
  // The simulated wire settles asynchronously; releasing before it lands fails with "not enough funds".
  for (let attempt = 0; ; attempt++) {
    const { balances } = await client.getBankAccount(account.id);
    if ((balances?.available_amount ?? 0) >= 100_000_000) break;
    if (attempt >= 20) throw new Error("simulated funding wire did not settle within 40s");
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`funded        $1,000,000.00 (simulated incoming wire, settled)`);

  const vendorCounterparties: Record<string, string> = {};
  for (const [vendorId, v] of Object.entries(SANDBOX_ACCOUNTS.vendors)) {
    const cp = await client.createCounterparty({ routing_number: SANDBOX_ACCOUNTS.routing, account_number: v.account, name: v.name, description: v.description, address: SANDBOX_ACCOUNTS.addresses[v.address] });
    vendorCounterparties[vendorId] = cp.id;
    console.log(`counterparty  ${cp.id}  ${v.name} ••${v.account.slice(-4)} (on file)`);
  }

  const paymentCounterparties: Record<string, string> = {};
  for (const [paymentId, p] of Object.entries(SANDBOX_ACCOUNTS.payments)) {
    if ("vendor" in p) {
      paymentCounterparties[paymentId] = vendorCounterparties[p.vendor];
      continue;
    }
    const cp = await client.createCounterparty({ routing_number: SANDBOX_ACCOUNTS.routing, account_number: p.account, name: p.name, description: p.description, address: SANDBOX_ACCOUNTS.addresses[p.address] });
    paymentCounterparties[paymentId] = cp.id;
    console.log(`counterparty  ${cp.id}  ${p.name} ••${p.account.slice(-4)} (from invoice ${paymentId})`);
  }

  const config: ColumnSandboxConfig = {
    createdAt: new Date().toISOString(),
    bankAccountId: account.id,
    accountNumberId: account.default_account_number_id,
    paymentCounterparties,
    vendorCounterparties,
  };
  writeFileSync(COLUMN_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(root, COLUMN_CONFIG_PATH)}. Set PAYMENT_SOURCE=column and DEMO_MODE=live, then pnpm seed && pnpm dev.`);
  console.log(`\nFor Vercel, add this as COLUMN_SANDBOX_CONFIG:\n${JSON.stringify(config)}`);
}

main().catch((e) => {
  console.error(`column:setup failed: ${(e as Error).message}`);
  process.exit(1);
});
