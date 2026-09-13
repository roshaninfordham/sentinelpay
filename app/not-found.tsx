import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-md border border-rule bg-panel px-5 py-6">
        <p className="text-sm text-muted">404</p>
        <h1 className="mt-1 font-display text-2xl font-semibold">Payment not found</h1>
        <p className="mt-2 text-sm text-muted">No payment or receipt exists at this address. Check the link, or return to the queue.</p>
        <Link href="/" className="mt-5 inline-block rounded-md bg-paper px-4 py-2 font-medium text-vault transition-colors hover:bg-white">
          Back to the queue
        </Link>
      </div>
    </main>
  );
}
