import type { ChallengeRequest, Challenger } from "../core/types";

export interface HumanApprovalOptions {
  /** e.g. "https://app.example.com/approve" */
  approvalBaseUrl: string;
  /** Delivers the link to someone who is NOT the requester, on a channel the requester cannot read. */
  deliver(msg: {
    to: "vendor_controller" | "internal_approver";
    callbackPhone: string | null;
    url: string;
    summary: string;
  }): Promise<void>;
  /** Default true: AUTHORIZED must carry the last4 the vendor read back, equal to the case last4. */
  requireReadBack?: boolean;
  /** Default: true in production, false otherwise. AUTHORIZED then needs an authenticated responder principal. */
  requireApproverSession?: boolean;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/** Out-of-band confirmation through a link delivered to an approver (§3.5, §4.3). */
export function humanApprovalChallenger(opts: HumanApprovalOptions): Challenger {
  const base = opts.approvalBaseUrl.replace(/\/+$/, "");
  return {
    channel: "human_approval",
    assurance: "out_of_band",
    requireReadBack: opts.requireReadBack ?? true,
    requireApproverSession: opts.requireApproverSession,
    // The approver must confirm on an independently sourced number; without one the case fails closed.
    canHandle: (ctx) => ctx.callbackPhone !== null,
    async start(req: ChallengeRequest) {
      const { facts } = req;
      // newLast4 is deliberately absent: the vendor must read the account back.
      const summary =
        `${facts.payerName}: confirm a bank-account change for ${facts.vendorLegalName} before paying ${usd(facts.amountCents)} ` +
        `(payment ${facts.paymentId}). Call ${req.callbackPhone} (not any number on the invoice), ask the controller to read back ` +
        `the last 4 digits of the new account, and record the answer. Link expires ${req.expiresAt}.`;
      await opts.deliver({
        to: "internal_approver",
        callbackPhone: req.callbackPhone,
        url: `${base}/${encodeURIComponent(req.challengeId)}#t=${req.responderToken}`,
        summary,
      });
      return { status: "pending" };
    },
  };
}
