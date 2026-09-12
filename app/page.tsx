import { Dashboard } from "@/components/Dashboard";
import { one } from "@/lib/db";
import { reseed } from "@/lib/seed-data";
import { snapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export default async function Home() {
  // First run without `pnpm seed` (including a fresh hosted database): write the scenario.
  const count = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM vendors`);
  if (!Number(count?.n)) await reseed();
  return <Dashboard initial={await snapshot()} />;
}
