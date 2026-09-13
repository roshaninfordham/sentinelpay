import type { Metadata } from "next";
import { getRuntime } from "@/lib/engine";
import { callbackPhoneOf, usd } from "@/lib/timeline-format";
import { ApproveForm } from "./ApproveForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Confirm a bank change · SentinelPay", robots: { index: false } };

// Responder surface for humanApprovalChallenger (ENGINE_SPEC §6.2 item 4). The token stays in the URL fragment,
// which never reaches this server; the form reads it in the browser and posts it once.
export default async function ApprovePage({ params }: PageProps<"/approve/[challengeId]">) {
  const { challengeId } = await params;
  const { engine, loadCase } = await getRuntime();
  const found = await loadCase({ challengeId }).catch(() => null);
  if (!found?.challenge || found.challenge.channel !== "human_approval") {
    return <Notice title="This confirmation link is not valid." body="Ask the payer's accounts team for a new link. No payment is released without a valid confirmation." />;
  }
  // One lazy engine step enforces expiry before anything is shown as confirmable.
  await engine.advance(found.paymentId).catch(() => undefined);
  const c = (await loadCase({ challengeId }).catch(() => null)) ?? found;
  const ch = c.challenge!;

  if (ch.status === "EXPIRED") {
    return <Notice title="This confirmation link has expired." body="The payment was frozen. Nothing further is needed from you." />;
  }
  if (ch.status !== "OPEN" || c.state !== "CHALLENGING") {
    return <Notice title="This confirmation has already been recorded." body="The payment's outcome is final. Nothing further is needed from you." />;
  }

  const phone = callbackPhoneOf(c);
  const expires = new Date(ch.expiresAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

  return (
    <main className="mx-auto max-w-md px-4 py-8 text-[15px] leading-relaxed">
      <p className="text-sm text-muted">SentinelPay · vendor bank-change confirmation</p>
      <h1 className="mt-1 font-display text-2xl font-semibold">Confirm before {usd(c.payment.amountCents)} is paid</h1>

      <dl className="mt-5 rounded-md border border-rule bg-panel px-4 py-2">
        <Row k="Amount" v={usd(c.payment.amountCents)} />
        <Row k="Vendor" v={c.vendorSnapshot.legalName} />
        <Row k="Account on file" v={`••${c.vendorSnapshot.knownBankLast4}`} />
        <Row k="Requesting domain" v={`${c.payment.requestSourceDomain} (from the request, unverified)`} />
        <Row k="Link expires" v={expires} />
      </dl>

      <section className="mt-5 rounded-md border border-brass/50 bg-panel px-4 py-3">
        <p className="text-sm text-muted">Call this number, not the one on the invoice</p>
        <p className="font-display text-2xl font-semibold text-brass">{phone ?? "No verified number on file"}</p>
        <p className="mt-1 text-sm text-muted">
          Ask the vendor&apos;s controller whether they changed their bank account, and ask them to read back the last 4 digits of the new account.
        </p>
      </section>

      <ApproveForm challengeId={ch.challengeId} />
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-x-3 border-t border-rule/50 py-1.5 first:border-t-0">
      <dt className="text-muted">{k}</dt>
      <dd className="break-words">{v}</dd>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div role="status" className="rounded-md border border-rule bg-panel px-4 py-5">
        <h1 className="font-display text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-muted">{body}</p>
      </div>
    </main>
  );
}
