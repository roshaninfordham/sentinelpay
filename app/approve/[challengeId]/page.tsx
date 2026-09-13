import type { Metadata } from "next";
import { ApproveForm } from "./ApproveForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Confirm a bank change · SentinelPay", robots: { index: false } };

// Responder surface for humanApprovalChallenger (ENGINE_SPEC §6.2 item 4). The token stays in the URL fragment,
// which never reaches this server. The server renders only a neutral shell, the same for every challenge id; the
// form reads the token in the browser and loads the payment details with it (§6.4: no existence oracle).
export default async function ApprovePage({ params }: PageProps<"/approve/[challengeId]">) {
  const { challengeId } = await params;
  return (
    <main className="mx-auto w-full max-w-[26rem] px-4 pb-10 pt-6 text-[15px] leading-relaxed">
      <p className="mb-5 flex items-center gap-2 font-display text-lg font-semibold">
        <svg width="16" height="19" viewBox="0 0 22 26" aria-hidden className="text-brass">
          <path d="M11 1 21 4.5v7.8c0 6-4.2 10.7-10 12.7C5.2 23 1 18.3 1 12.3V4.5L11 1Z" fill="none" stroke="currentColor" strokeWidth="2.5" />
        </svg>
        SentinelPay
      </p>
      <ApproveForm challengeId={challengeId} />
    </main>
  );
}
