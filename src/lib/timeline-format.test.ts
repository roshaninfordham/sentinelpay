import assert from "node:assert/strict";
import { test } from "node:test";
import { accountLabel, describeMismatch } from "./timeline-format";

test("mismatch lines never print a bullet in front of words", () => {
  assert.equal(accountLabel("4471"), "••4471");
  assert.equal(accountLabel("unknown"), "an account the rail could not read");
  assert.equal(accountLabel("4471 at routing ••0013"), "••4471 at routing ••0013");
  assert.equal(describeMismatch({ code: "BENEFICIARY_CHANGED", onFile: "4471", claimed: "unknown" }), "Beneficiary changed: ••4471 → an account the rail could not read");
  assert.equal(describeMismatch({ code: "BENEFICIARY_CHANGED", onFile: "4471", claimed: "9821" }), "Beneficiary changed: ••4471 → ••9821");
});
