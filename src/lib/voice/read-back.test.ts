import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SENTINEL_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "sentinel-voice-")), "test.db");
process.env.SENTINELPAY_TOKEN_PEPPER = "v".repeat(40);
process.env.DEMO_MODE = "cache";
process.env.DEMO_PACE_MS = "0";

async function openVoiceChallenge() {
  const { reseed } = await import("../seed-data");
  const { getRuntime } = await import("../engine");
  const { runGate } = await import("../gate");
  const { GET } = await import("../../../app/api/voice/token/route");
  await reseed();
  const rt = await getRuntime();
  await runGate("pay_240k");
  await rt.engine.advance("pay_240k");
  const res = await GET(new Request("http://localhost/api/voice/token?paymentId=pay_240k"));
  assert.equal(res.status, 200);
  return { rt, session: (await res.json()) as { challengeId: string; responderToken: string } };
}

test("voice AUTHORIZED without the vendor's read-back freezes the wire", async () => {
  const { rt, session } = await openVoiceChallenge();
  const { decide } = await import("../governor");
  const receipt = await decide({ paymentId: "pay_240k", verdict: "AUTHORIZED", challengeId: session.challengeId, responderToken: session.responderToken, toolInvoked: "approve_payment" });
  assert.equal(receipt.payment.status, "QUARANTINED");
  assert.equal((await rt.loadCase({ paymentId: "pay_240k" }))?.reason, "VENDOR_DENIED_CHANGE");
});

test("voice AUTHORIZED with a wrong read-back freezes; the matching read-back releases", async () => {
  const { decide } = await import("../governor");
  let { session } = await openVoiceChallenge();
  const wrong = await decide({ paymentId: "pay_240k", verdict: "AUTHORIZED", challengeId: session.challengeId, responderToken: session.responderToken, beneficiaryLast4ReadBack: "4471" });
  assert.equal(wrong.payment.status, "QUARANTINED");

  ({ session } = await openVoiceChallenge());
  const right = await decide({ paymentId: "pay_240k", verdict: "AUTHORIZED", challengeId: session.challengeId, responderToken: session.responderToken, beneficiaryLast4ReadBack: "9821" });
  assert.equal(right.payment.status, "CLEARED");
});
