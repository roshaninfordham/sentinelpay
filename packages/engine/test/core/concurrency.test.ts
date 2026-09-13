import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage } from "../../src/adapters/memory";
import type { Probe, Storage } from "../../src/core/types";
import { eventsOf, poisoned, poisonedProbes, setup } from "./helpers";

/** Counts VERSION_CONFLICT rejections so the test can prove a lost race was absorbed, not avoided. */
function conflictCounting(inner: Storage) {
  const counter = { conflicts: 0 };
  const storage: Storage = {
    ...inner,
    commit: async (next, expected, events) => {
      try {
        return await inner.commit(next, expected, events);
      } catch (err) {
        if ((err as { code?: string }).code === "VERSION_CONFLICT") counter.conflicts++;
        throw err;
      }
    },
  };
  return { storage, counter };
}

test("two racing advance() calls give exactly one FORENSICS entry and absorb the VERSION_CONFLICT", async () => {
  const { storage, counter } = conflictCounting(memoryStorage());
  // Slow probes keep the winner's investigation open while the loser tries to take the lease.
  const slow: Probe[] = poisonedProbes().map((p) => ({ id: p.id, run: async (ctx) => { await new Promise((r) => setTimeout(r, 20)); return p.run(ctx); } }));
  const { engine, starts } = setup({ storage, probes: slow });
  await engine.verify(poisoned());

  const [a, b] = await Promise.all([engine.advance("pay_240k"), engine.advance("pay_240k")]);
  const events = await eventsOf(storage);
  assert.equal(events.filter((e) => e === "INVESTIGATION_STARTED").length, 1);
  assert.equal(events.filter((e) => e === "FORENSICS").length, 1);
  assert.equal(events.filter((e) => e === "CHALLENGE_STARTED").length, 1);
  assert.equal(starts.length, 1);
  assert.equal(counter.conflicts, 1);
  assert.ok([a.state, b.state].includes("CHALLENGING"));
  assert.equal((await engine.get("pay_240k")).state, "CHALLENGING");
  assert.equal((await engine.verifyLedger()).ok, true);
});

test("concurrent verify of the same payment creates one case and one INTERCEPTED entry", async () => {
  const { engine, storage } = setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => engine.verify(poisoned())));
  assert.ok(results.every((v) => v.paymentId === "pay_240k" && v.version === 1));
  assert.deepEqual(await eventsOf(storage), ["INTERCEPTED"]);
});

test("a DENIED racing an AUTHORIZED: first writer wins and the other sees the terminal case", async () => {
  const { engine, starts, storage } = setup();
  await engine.verify(poisoned());
  await engine.advance("pay_240k");
  const { challengeId, responderToken } = starts[0];
  const [x, y] = await Promise.all([
    engine.resolveChallenge({ challengeId, verdict: "DENIED" }),
    engine.resolveChallenge({ challengeId, verdict: "AUTHORIZED", responderToken }),
  ]);
  assert.equal(x.state, y.state);
  assert.equal(x.version, y.version);
  assert.equal((await eventsOf(storage)).filter((e) => e === "CALL_RESULT").length, 1);
});
