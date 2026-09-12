import { Dashboard } from "@/components/Dashboard";
import { getDb } from "@/lib/db";
import { reseed } from "@/lib/seed-data";
import { snapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export default function Home() {
  // First run without `pnpm seed`: write the scenario so the dashboard is never empty.
  const count = getDb().prepare(`SELECT COUNT(*) AS n FROM vendors`).get() as { n: number };
  if (count.n === 0) reseed();
  return <Dashboard initial={snapshot()} />;
}
