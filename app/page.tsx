import { Suspense } from "react";
import { Dashboard } from "@/components/Dashboard";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { isProduction } from "@/lib/auth";
import { one } from "@/lib/db";
import { reseed } from "@/lib/seed-data";
import { snapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <LiveDashboard />
    </Suspense>
  );
}

async function LiveDashboard() {
  // The console has no operator sign-in, and its routes need an operator key in production, so it is not served there.
  if (await isProduction()) return <ProductionNotice />;
  // First run without `pnpm seed` (including a fresh hosted database): write the scenario.
  const count = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM vendors`);
  if (!Number(count?.n)) await reseed();
  return <Dashboard initial={await snapshot()} />;
}

function ProductionNotice() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-md border border-rule bg-panel px-5 py-6">
        <p className="text-sm text-muted">SentinelPay · Production</p>
        <h1 className="mt-1 font-display text-2xl font-semibold">The operator console needs operator sign-in</h1>
        <p className="mt-2 text-sm text-muted">
          This build has no operator sign-in, so the console is not served in production. Payments are verified through{" "}
          <code className="font-mono text-paper">/api/v1</code> with an API key, and nothing is released without verification.
        </p>
      </div>
    </main>
  );
}
