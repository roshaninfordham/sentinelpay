"use client";

import { useEffect } from "react";

// Render-time failures (for example the database is unreachable). Nothing is released while this shows.
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("[sentinelpay]", error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div role="alert" className="rounded-md border border-signal/60 bg-panel px-5 py-6">
        <h1 className="font-display text-2xl font-semibold">Verification service unavailable. Payments stay held.</h1>
        <p className="mt-2 text-sm text-muted">No wire is released while verification is down. Try again in a moment.</p>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-5 rounded-md bg-paper px-4 py-2 font-medium text-vault transition-colors hover:bg-white"
        >
          Retry
        </button>
      </div>
    </main>
  );
}
