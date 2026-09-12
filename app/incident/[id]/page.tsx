import Link from "next/link";
import { notFound } from "next/navigation";
import { buildReceipt } from "@/lib/receipt";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default async function IncidentPage({ params }: PageProps<"/incident/[id]">) {
  const { id } = await params;
  const r = await buildReceipt(id).catch(() => null);
  if (!r) notFound();

  const frozen = r.payment.status === "QUARANTINED";
  const outcome = frozen ? "Wire frozen" : r.payment.status === "CLEARED" ? "Wire released" : "Open (not yet decided)";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-[15px] leading-relaxed print:max-w-none print:py-0 md:px-8">
      <div className="no-print mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-muted underline underline-offset-4">Back to dashboard</Link>
        <PrintButton />
      </div>

      <article className="rounded-md border border-rule bg-panel p-6 print:border-black/30 print:bg-white md:p-10">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-rule pb-6 print:border-black/30">
          <div>
            <p className="text-sm text-muted print:text-black/60">SentinelPay incident receipt</p>
            <h1 className="font-display text-3xl font-semibold">{r.incidentId}</h1>
            <p className="text-sm text-muted print:text-black/60">Generated {new Date(r.generatedAt).toUTCString()}</p>
          </div>
          <div className="text-right">
            <p className={`font-display text-2xl font-semibold ${frozen ? "text-signal" : "text-cleared"} print:text-black`}>{outcome}</p>
            <p className="font-display text-xl">{usd(r.payment.amountCents)}</p>
          </div>
        </header>

        <Section title="Payment">
          <Row k="Payment ID" v={r.payment.id} />
          <Row k="Payee" v={r.vendor.legalName} />
          <Row k="Vendor of record" v={`${r.vendor.knownDomain}, account ••${r.vendor.knownBankLast4}`} />
          <Row k="Requested change" v={`account ••${r.payment.claimedBankLast4}, from ${r.payment.requestSourceDomain}`} />
          <Row k="Invoice contact number" v={`${r.payment.invoiceContactPhone ?? "none"} (not used)`} />
          {r.payment.railReference && <Row k="Column sandbox wire" v={r.payment.railReference} />}
        </Section>

        {r.assessment && (
          <Section title="Risk assessment">
            <Row k="Result" v={`${r.assessment.level}, score ${r.assessment.score} of 100 (deterministic policy)`} />
            <Row k="Verified callback" v={r.assessment.verifiedCallbackPhone ?? "unresolved"} />
            {r.assessment.signals.map((s) => (
              <Row key={s.key} k={`${s.key} (${s.source})`} v={s.detail ?? String(s.value)} />
            ))}
            <p className="mt-3 text-paper/85 print:text-black">{r.assessment.rationale}</p>
          </Section>
        )}

        {r.call && (
          <Section title="Out-of-band challenge">
            <Row k="Verdict" v={r.call.verdict} />
            <Row k="Tool invoked" v={r.call.toolInvoked ?? "none"} />
            <Row k="Duration" v={`${r.call.durationSec}s`} />
            {r.call.transcript && (
              <pre className="mt-3 whitespace-pre-wrap rounded border border-rule bg-vault/50 p-3 font-sans text-sm print:border-black/20 print:bg-white">
                {r.call.transcript}
              </pre>
            )}
          </Section>
        )}

        <Section title="Audit chain">
          <p className="mb-3 text-sm">
            {r.chain.ok
              ? `Verified: all ${r.chain.length} ledger entries recompute to their stored SHA-256 hashes.`
              : `Verification failed at entry #${r.chain.brokenAt}. The ledger has been altered.`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted print:text-black/60">
                <tr>
                  <th className="py-1 pr-3 font-normal">Seq</th>
                  <th className="py-1 pr-3 font-normal">Event</th>
                  <th className="py-1 pr-3 font-normal">Time (UTC)</th>
                  <th className="py-1 font-normal">Entry hash</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {r.entries.map((e) => (
                  <tr key={e.seq} className="border-t border-rule/60 align-top print:border-black/10">
                    <td className="py-1 pr-3">{e.seq}</td>
                    <td className="py-1 pr-3">{e.event}</td>
                    <td className="py-1 pr-3">{e.ts.replace("T", " ").slice(0, 19)}</td>
                    <td className="break-all py-1">{e.entryHash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.headHash && (
            <p className="mt-3 break-all text-xs text-muted print:text-black/60">
              Head hash: <span className="font-mono">{r.headHash}</span>
            </p>
          )}
        </Section>

        <footer className="mt-8 border-t border-rule pt-4 text-xs text-muted print:border-black/30 print:text-black/60">
          Approved by (CFO / Controller) ______________________________ Date ____________
          <p className="mt-2">JSON version: /api/incident/{r.payment.id}</p>
        </footer>
      </article>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-2 font-display text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 border-t border-rule/50 py-1.5 sm:grid-cols-[200px_1fr] print:border-black/10">
      <span className="text-muted print:text-black/60">{k}</span>
      <span className="break-words">{v}</span>
    </div>
  );
}
