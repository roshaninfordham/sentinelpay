// Mirrors the dashboard's grid and panel heights so nothing jumps when the data arrives.
export function DashboardSkeleton() {
  return (
    <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 pb-8 md:px-6" aria-busy="true">
      <p className="sr-only" role="status">
        Loading payments
      </p>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-rule py-4">
        <div className="skeleton h-8 w-44" />
        <div className="flex flex-wrap items-center gap-3 min-[900px]:ml-auto">
          <div className="skeleton h-6 w-36" />
          <div className="skeleton h-6 w-56" />
          <div className="skeleton h-7 w-64" />
        </div>
      </header>
      <div className="mt-5 grid flex-1 content-start gap-5 min-[900px]:grid-cols-[240px_minmax(0,1fr)] min-[1200px]:grid-cols-[260px_minmax(0,1fr)_minmax(0,420px)]">
        <div className="flex flex-col gap-2 min-[900px]:row-span-2 min-[1200px]:row-span-1">
          <div className="skeleton mb-1 h-7 w-36" />
          {[0, 1].map((i) => (
            <div key={i} className="rounded-md border border-rule bg-panel px-3 py-3">
              <div className="flex justify-between">
                <div className="skeleton h-6 w-24" />
                <div className="skeleton h-5 w-20" />
              </div>
              <div className="skeleton mt-2 h-4 w-40" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <div className="h-[420px] rounded-md border border-rule bg-panel p-6">
            <div className="skeleton h-4 w-16" />
            <div className="skeleton mt-2 h-7 w-72 max-w-full" />
            <div className="skeleton mt-6 h-20 w-96 max-w-full" />
          </div>
          <div className="h-12 rounded-md border border-rule bg-panel" />
        </div>
        <div className="flex flex-col gap-4 min-[900px]:col-start-2 min-[1200px]:col-start-3">
          <div className="h-[310px] rounded-md border border-rule bg-[#08121a] min-[1200px]:h-[350px]" />
          <div className="h-[300px] rounded-md border border-rule bg-panel" />
        </div>
      </div>
    </div>
  );
}
