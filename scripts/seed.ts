import "./load-env";
import { reseed, seedPayments, VENDORS } from "../src/lib/seed-data";

async function main() {
  await reseed();
console.log(`Seeded ${process.env.TURSO_DATABASE_URL ? "Turso database" : "sentinel.db"} — ${VENDORS.length} vendors, ${seedPayments().length} payments.`);
console.log("  pay_240k  $240,000.00 → Meridian Global (beneficiary ••4471 → ••9821)  [poisoned]");
console.log("  pay_18k   $18,450.00  → Northwind Freight (matches vendor master)       [clean]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
