import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SENTINEL_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "sentinel-approve-")), "test.db");
process.env.SENTINELPAY_TOKEN_PEPPER = "a".repeat(40);
process.env.APPROVAL_DELIVERY = "log";
process.env.APPROVAL_BASE_URL = "http://localhost/approve";
process.env.DEMO_MODE = "cache";
process.env.DEMO_PACE_MS = "0";

const params = (challengeId: string) => ({ params: Promise.resolve({ challengeId }) });
const bearer = (token?: string) => new Request("http://localhost/api/approve/x", { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("approval details are served only with the link's token; every failure is the same 401", async () => {
  const { reseed } = await import("./seed-data");
  const { getRuntime } = await import("./engine");
  const { runGate } = await import("./gate");
  const route = await import("../../app/api/approve/[challengeId]/route");
  await reseed();
  const rt = await getRuntime();

  const logged: string[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    await runGate("pay_240k");
    await rt.engine.advance("pay_240k");
  } finally {
    console.info = info;
  }
  const link = /http:\/\/localhost\/approve\/(chl_[a-z2-7]+)#t=([\w-]+)/.exec(logged.join("\n"));
  assert.ok(link, "approval link delivered to the log");
  const [, challengeId, token] = link;

  const failures = [
    await route.GET(bearer(), params(challengeId)),
    await route.GET(bearer("wrong-token"), params(challengeId)),
    await route.GET(bearer(token), params("chl_doesnotexistdoesnotexist")),
  ];
  const bodies = await Promise.all(failures.map(async (r) => [r.status, await r.text()]));
  assert.deepEqual(bodies[0], [401, JSON.stringify({ error: { code: "RESPONDER_TOKEN_INVALID", message: "responder token is invalid" } })]);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[2], bodies[0]);

  const ok = await route.GET(bearer(token), params(challengeId));
  assert.equal(ok.status, 200);
  const details = (await ok.json()) as Record<string, unknown>;
  assert.equal(details.status, "open");
  assert.equal(details.amountCents, 24000000);
  assert.equal(details.callbackPhone, "(312) 555-0198");
  assert.equal(JSON.stringify(details).includes(token), false);

  // "Vendor did not confirm" also needs the token, then the link reads closed.
  const deny = (t?: string) =>
    route.POST(
      new Request("http://localhost/api/approve/x", {
        method: "POST",
        headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify({ verdict: "DENIED" }),
      }),
      params(challengeId),
    );
  assert.equal((await deny()).status, 401);
  assert.equal((await rt.loadCase({ challengeId }))?.state, "CHALLENGING");
  assert.deepEqual(await (await deny(token)).json(), { decision: "DO_NOT_PAY" });
  assert.deepEqual(await (await route.GET(bearer(token), params(challengeId))).json(), { status: "closed" });
});
