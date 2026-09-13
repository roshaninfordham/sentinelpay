import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { rationaleText, signalLabel, writtenDigits } from "@/components/format";
import { isProduction } from "@/lib/auth";
import { buildReceipt } from "@/lib/receipt";
import { CopyButton } from "./CopyButton";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Incident receipt · SentinelPay" };

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const CHANNEL: Record<string, string> = {
  voice_browser: "Browser voice call",
  voice_phone: "Phone call",
  human_approval: "Approval link",
  scripted: "Scripted call",
};

const ASSURANCE: Record<string, string> = { operator_session: "Operator session", out_of_band: "Out of band", test: "Test only" };

export default async function IncidentPage({ params }: PageProps<"/incident/[id]">) {
  const { id } = await params;
  // A browser page carries no API key, so production serves receipts only through authenticated APIs.
  if (await isProduction()) notFound();
  const r = await buildReceipt(id).catch(() => null);
  if (!r) notFound();

  const v = r.verification;
  const frozen = r.payment.status === "QUARANTINED";
  const cleared = r.payment.status === "CLEARED";
  const outcome = frozen ? "Wire frozen" : cleared ? "Wire released" : "Open, not yet decided";
  const callResult = r.entries.findLast((e) => e.event === "CALL_RESULT")?.payload as
    | { authorizedWithToken?: boolean; reason?: string }
    | undefined;
  const riskReasons = r.assessment?.reasons ?? [];
  const mismatchCodes = v?.mismatches.map((m) => m.code) ?? [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-[15px] leading-relaxed print:max-w-none print:p-0 md:px-8 md:py-10">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-sm text-muted underline underline-offset-4 hover:text-paper">
          Back to the queue
        </Link>
        <PrintButton />
      </div>

      <article className="rounded-md border border-rule bg-panel p-5 print:border-0 print:bg-white print:p-0 sm:p-6 md:p-10">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-rule pb-6 print:border-black/30">
          <div className="min-w-0">
            <p className="text-sm text-muted print:text-black/60">SentinelPay incident receipt</p>
            <h1 className="break-all font-display text-3xl font-semibold">{r.incidentId}</h1>
            <p className="text-sm text-muted print:text-black/60">Generated {new Date(r.generatedAt).toUTCString()}</p>
          </div>
          <div className="text-left sm:text-right">
            <p className={`font-display text-2xl font-semibold print:text-black ${frozen ? "text-signal" : cleared ? "text-cleared" : "text-brass"}`}>
              {outcome}
            </p>
            <p className="font-display text-xl">{usd(r.payment.amountCents)}</p>
          </div>
        </header>

        {v && (
          <Section title="Decision">
            <Row k="Decision" v={<span className="font-mono text-sm">{v.decision}</span>} />
            <Row k="Reason" v={<Codes codes={[v.reason]} />} />
            {mismatchCodes.length > 0 && <Row k="Gate findings" v={<Codes codes={mismatchCodes} />} />}
            {riskReasons.length > 0 && <Row k="Risk reasons" v={<Codes codes={riskReasons} />} />}
            <Row k="Requested by" v={v.requestedBy} />
          </Section>
        )}

        <Section title="Payment">
          <Row k="Payment ID" v={<span className="font-mono text-sm">{r.payment.id}</span>} />
          <Row k="Payee" v={r.vendor.legalName} />
          <Row k="Vendor of record" v={`${r.vendor.knownDomain}, account ••${r.vendor.knownBankLast4}`} />
          <Row k="Requested change" v={`Account ••${r.payment.claimedBankLast4}, from ${r.payment.requestSourceDomain}`} />
          <Row k="Invoice contact number" v={`${r.payment.invoiceContactPhone ?? "None"} (not used)`} />
          {r.payment.railReference && <Row k="Column sandbox wire" v={r.payment.railReference} />}
        </Section>

        {r.assessment && (
          <Section title="Risk assessment">
            <Row k="Result" v={`${r.assessment.level.charAt(0)}${r.assessment.level.slice(1).toLowerCase()} risk, score ${r.assessment.score} of 100 (deterministic policy)`} />
            <Row k="Verified callback" v={r.assessment.verifiedCallbackPhone ?? "Unresolved"} />
            {r.assessment.signals.map((s) => (
              <Row key={s.key} k={signalLabel(s)} v={s.detail ?? String(s.value)} />
            ))}
            <p className="mt-3 text-paper/90 print:text-black">{rationaleText(r.assessment.rationale)}</p>
          </Section>
        )}

        {(v?.challenge || r.call) && (
          <Section title="Vendor confirmation">
            {v?.challenge && (
              <>
                {/* The id addresses the approval page, so it is printed only once the challenge is closed. */}
                {v.challenge.status !== "OPEN" && <Row k="Challenge ID" v={<span className="break-all font-mono text-sm">{v.challenge.challengeId}</span>} />}
                <Row k="Channel" v={channelLabel(v.challenge.channel, r)} />
                <Row k="Assurance tier" v={assuranceLabel(v.challenge.assurance, r.environment)} />
                <Row k="Status" v={v.challenge.status.charAt(0) + v.challenge.status.slice(1).toLowerCase()} />
              </>
            )}
            {r.call && <Row k="Verdict" v={<span className="font-mono text-sm">{r.call.verdict}</span>} />}
            {v?.challenge && <Row k="Resolved by" v={v.challenge.resolvedBy ?? "Expired (failed closed)"} />}
            <Row k="Authorized with token" v={callResult ? (callResult.authorizedWithToken ? "Yes" : "No") : "No answer recorded"} />
            {r.call && (
              <>
                <Row k="Tool invoked" v={r.call.toolInvoked ?? "None"} />
                <Row k="Duration" v={`${r.call.durationSec}s`} />
              </>
            )}
            {r.call?.transcript && (
              <pre className="print-avoid-break mt-3 whitespace-pre-wrap rounded border border-rule bg-vault/50 p-3 font-sans text-sm print:border-black/20 print:bg-white">
                {writtenDigits(r.call.transcript)}
              </pre>
            )}
          </Section>
        )}

        <Section title="Audit chain">
          <p className={`mb-3 text-sm print:text-black ${r.chain.ok ? "text-cleared" : "font-medium text-signal"}`}>
            {r.chain.ok
              ? `Verified: all ${r.chain.length} ledger entries recompute to their stored SHA-256 hashes.`
              : `Verification failed at entry #${r.chain.brokenAt}. The ledger has been altered.`}
          </p>
          {r.entries.length === 0 ? (
            <p className="text-sm text-muted print:text-black/60">Audit chain empty for this payment.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs print:min-w-0">
                <caption className="sr-only">Ledger entries for this payment</caption>
                <thead className="text-muted print:text-black/60">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-normal">Seq</th>
                    <th scope="col" className="py-1 pr-3 font-normal">Event</th>
                    <th scope="col" className="py-1 pr-3 font-normal">Time (UTC)</th>
                    <th scope="col" className="py-1 font-normal">Entry hash</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {r.entries.map((e) => (
                    <tr key={e.seq} className="border-t border-rule/60 align-top print:border-black/10">
                      <td className="py-1 pr-3">{e.seq}</td>
                      <td className="py-1 pr-3">{e.event}</td>
                      <td className="whitespace-nowrap py-1 pr-3">{e.ts.replace("T", " ").slice(0, 19)}</td>
                      <td className="break-all py-1">{e.entryHash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.headHash && (
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-rule px-3 py-2 print:border-black/20">
              <span className="text-xs text-muted print:text-black/60">Head hash</span>
              <span className="min-w-0 flex-1 break-all font-mono text-xs">{r.headHash}</span>
              <CopyButton value={r.headHash} label="Copy head hash" />
            </div>
          )}
        </Section>

        <footer className="mt-8 border-t border-rule pt-4 text-xs text-muted print:border-black/30 print:text-black/60">
          <p className="print:mt-6">Approved by (CFO / Controller) ______________________________ Date ____________</p>
          <p className="mt-2">JSON version: /api/incident/{r.payment.id}</p>
        </footer>
      </article>
    </main>
  );
}

function channelLabel(channel: string, r: { voiceAgent: string; environment: string }): string {
  const label = CHANNEL[channel] ?? channel;
  return channel === "voice_browser" && r.voiceAgent === "scripted" ? `${label}, scripted (${r.environment})` : label;
}

function assuranceLabel(assurance: string, environment: string): string {
  const label = ASSURANCE[assurance] ?? assurance;
  return environment === "production" ? label : `${label} (${environment})`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="print-avoid-break mt-7">
      <h2 className="mb-2 font-display text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 border-t border-rule/50 py-1.5 sm:grid-cols-[200px_1fr] print:grid-cols-[180px_1fr] print:border-black/10">
      <span className="text-muted print:text-black/60">{k}</span>
      <span className="min-w-0 break-words">{v}</span>
    </div>
  );
}

function Codes({ codes }: { codes: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {codes.map((c) => (
        <span key={c} className="rounded border border-rule bg-vault/50 px-1.5 py-px font-mono text-xs print:border-black/20 print:bg-white">
          {c}
        </span>
      ))}
    </span>
  );
}
