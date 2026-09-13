import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { constantTimeEqual, hashResponderToken, newChallengeId, newResponderToken, responderTokenMatches } from "../../src/core/token";

test("challengeId is chl_ + 16 random bytes in base32; tokens are 32 random bytes base64url", () => {
  const ids = new Set(Array.from({ length: 100 }, newChallengeId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^chl_[a-z2-7]{26}$/);
  const token = newResponderToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, newResponderToken());
});

test("token hash is sha256(pepper || token) and matching is exact", async () => {
  const pepper = "p".repeat(32);
  const token = newResponderToken();
  const stored = await hashResponderToken(pepper, token);
  assert.equal(stored, createHash("sha256").update(pepper + token).digest("hex"));
  assert.equal(await responderTokenMatches(pepper, token, stored), true);
  assert.equal(await responderTokenMatches(pepper, `${token}x`, stored), false);
  assert.equal(await responderTokenMatches("q".repeat(32), token, stored), false);
  assert.equal(await responderTokenMatches(pepper, token, ""), false, "an empty stored hash never matches");
});

test("constantTimeEqual", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
});
