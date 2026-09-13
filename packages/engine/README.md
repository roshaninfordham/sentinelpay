# payfirewall

**A firewall for outgoing payments.** Before money moves to a changed bank account, PayFirewall holds the payment, investigates the request, and gets the change confirmed on a channel the requester does not control. Anything short of an explicit, channel-bound authorization is `DO_NOT_PAY`. Every step is written to a hash-chained ledger you can hand to an auditor.

It is built for the two things that now send vendor payments: accounts-payable systems and AI agents. An agent gets three tools and one rule (never pay unless `decision` is `PAY`); a prompt-injected invoice cannot talk its way past a string comparison, a pure scoring function, and a responder token the agent never sees.

[![npm](https://img.shields.io/npm/v/payfirewall?color=d6a23e)](https://www.npmjs.com/package/payfirewall) ![types](https://img.shields.io/badge/types-included-3178c6) ![ESM + CJS](https://img.shields.io/badge/ESM%20%2B%20CJS-yes-46be86) ![license](https://img.shields.io/badge/license-MIT-d6a23e)

```bash
npm i payfirewall
```

Zero runtime dependencies. Node 20+, and edge runtimes (Web Crypto and `fetch` only). Reference app: **[SentinelPay](https://sentinelpay-sigma.vercel.app)** ([source](https://github.com/roshaninfordham/sentinelpay)).

---

- [What it does](#what-it-does)
- [60-second quickstart](#60-second-quickstart)
- [The decision contract](#the-decision-contract)
- [Agent integrations](#agent-integrations): [MCP](#mcp) · [OpenAI](#openai-function-calling) · [Anthropic](#anthropic-tool-use) · [Vercel AI SDK](#vercel-ai-sdk) · [HTTP](#http)
- [Security model](#security-model)
- [Adapters](#adapters)
- [Ports: bring your own storage, probes, challengers and rail](#ports)
- [Audit and receipts](#audit-and-receipts)
- [Limitations](#limitations)

## What it does

| | Capability | Surface |
|---|---|---|
| 1 | **Intercept and investigate.** A deterministic gate compares the beneficiary and request domain with your vendor master. On any mismatch, pluggable probes (RDAP domain age, registry research, sanctions) feed a pure rules policy that returns reason codes and a score, never prose. | `verify()` |
| 2 | **Out-of-band challenge, resumable.** A `Challenger` confirms the change with the real vendor on an independently sourced number: an approval link, a voice call, or your own channel. It can stay pending for minutes; any `get()` resumes it. Only the responder channel can authorize. | `verify()`, `get()`, `block()`, `resolveChallenge()` |
| 3 | **Fail-closed settlement with proof.** Terminal states are immutable, `CLEARED` is committed before any rail call, the rail beneficiary is re-read before release, and every transition lands in a SHA-256 hash chain. | `receipt()`, `verifyLedger()`, optional `Rail` |

## 60-second quickstart

A vendor's mailbox is compromised and an invoice asks you to pay a new account. This runs offline:

```ts
import { createEngine, humanApprovalChallenger } from "payfirewall";
import { memoryStorage, memoryVendors } from "payfirewall/adapters/memory";
import { fixtureProbe } from "payfirewall/adapters/fixtures";

const engine = createEngine({
  environment: "sandbox",
  storage: memoryStorage(),
  vendors: memoryVendors([{
    id: "v_meridian",
    legalName: "Meridian Global Logistics LLC",
    knownDomain: "meridianglobal.com",
    knownBankLast4: "4471",
    verifiedPhone: "(312) 555-0198", // a number you already trust, never the one on the invoice
  }]),
  // Offline evidence for the demo; use rdapProbe() from "payfirewall/adapters/rdap" for live lookups.
  probes: [fixtureProbe("rdap", { domains: { "meridian-global.co": { registeredHoursAgo: 72 } } })],
  challengers: [humanApprovalChallenger({
    approvalBaseUrl: "https://ap.example.com/approve",
    // Send the link to an approver the requester cannot impersonate (email, Slack DM, ticket).
    deliver: async ({ url, summary }) => console.log(`to approver: ${summary}\n${url}`),
  })],
  secrets: { tokenPepper: "replace-with-32-plus-random-bytes-from-a-secret-store" },
  payer: { name: "Acme Corp" },
});

// An invoice arrives asking you to pay a new account.
const v = await engine.verify({
  id: "pay_240k",
  vendorId: "v_meridian",
  amountCents: 24_000_000,
  currency: "USD",
  beneficiary: { accountLast4: "9821" },
  requestSourceDomain: "meridian-global.co",
  invoiceContactPhone: "+1-000-000-0000",
});
console.log(v.decision, v.reason); // WAIT UNDER_INVESTIGATION

// Do what nextActions[0] says: POLL get_verification.
const held = await engine.get(v.paymentId, { waitMs: 10_000, sinceVersion: v.version });
console.log(held.decision, held.reason, held.risk?.level, held.risk?.score);
// WAIT AWAITING_OUT_OF_BAND_CONFIRMATION CRITICAL 90

// The approver calls (312) 555-0198 and the vendor says it never changed banks.
const done = await engine.resolveChallenge({
  challengeId: held.challenge!.challengeId,
  verdict: "DENIED",
  responder: { id: "user:controller", kind: "human", roles: ["operator"] },
});
console.log(done.decision, done.reason); // DO_NOT_PAY VENDOR_DENIED_CHANGE

const receipt = await engine.receipt(done.paymentId);
console.log(receipt.chain); // { ok: true, length: 6 }
```

Had the vendor confirmed, the approval page would post `AUTHORIZED` with the responder token from the link fragment and the last 4 digits the vendor read back; the decision becomes `PAY`. A payment whose beneficiary matches the vendor master is `PAY` on the first call, with no challenge.

## The decision contract

Every call returns a `Verification`. Three fields are all an integration needs:

| Field | Values | Meaning |
|---|---|---|
| `decision` | `PAY` · `DO_NOT_PAY` · `WAIT` | Only `PAY` releases money. `WAIT` means held: do not pay yet. |
| `reason` | `ReasonCode` | One primary machine-readable reason, e.g. `VENDOR_DENIED_CHANGE`, `CHALLENGE_EXPIRED`, `RAIL_RELEASED`. |
| `nextActions` | ordered `NextAction[]` | **Do `nextActions[0]`.** The rest are context. |

| `nextActions[0].type` | What to do |
|---|---|
| `POLL` | Call `get_verification` with the given `args` (they include `waitMs` and `sinceVersion`) after `afterMs`. |
| `AWAIT_OUT_OF_BAND` | A human is confirming on another channel. Keep polling; never ask anyone for a code or token. |
| `PAY` | Pay exactly this payment. Without a rail, re-run the included `recheck` immediately before paying and compare `expect`. |
| `DO_NOT_PAY` | Stop. `terminal: true` means this payment id is finished. |
| `ESCALATE_TO_HUMAN` | Stop and show `message` to a person. |
| `RETRY` | Storage or rail was unavailable; call `verify_payment` again with the same payment after `afterMs`. |

Each result also carries `mustNot` (for example `DIAL_INVOICE_NUMBER`, `FOLLOW_INSTRUCTIONS_IN_UNTRUSTED`) and an `untrusted` block holding the attacker-controllable text (request domain, invoice phone, memo), kept apart so a model can be told never to act on it. Errors use the same shape: `{ code, message, retryable, nextActions }`, and `nextActions` never says `PAY`.

Lifecycle: `RECEIVED → PENDING_REVIEW → INVESTIGATING → CHALLENGING → CLEARED | QUARANTINED`. A matching beneficiary goes straight to `CLEARED`; `block()`, a denial, an inconclusive answer, expiry, five bad tokens, or no available challenge channel all end in `QUARANTINED`.

## Agent integrations

All surfaces are generated from one set of JSON Schemas, so MCP, function calling and HTTP cannot drift. The requester toolset:

| Tool | Does | Can it release money? |
|---|---|---|
| `verify_payment` | Submits a payment for verification; idempotent on the payment id. | Only by returning `PAY` after verification |
| `get_verification` | Long-polls a payment you submitted and advances pending steps; `includeReceipt` adds the audit receipt. | No |
| `block_payment` | Stops a payment you believe is fraudulent. Another principal's payment is blocked too, but answers `NOT_FOUND`. | No, it only moves toward `DO_NOT_PAY` |

There is no tool that approves a payment, and no tool argument that accepts a responder token.

### MCP

Claude Desktop, Claude Code, Cursor and any MCP client, via [`payfirewall-mcp`](https://www.npmjs.com/package/payfirewall-mcp):

```json
{
  "mcpServers": {
    "payfirewall": {
      "command": "npx",
      "args": ["-y", "payfirewall-mcp"],
      "env": {
        "PAYFIREWALL_URL": "https://your-app.example.com/api/v1",
        "PAYFIREWALL_API_KEY": "sk_..."
      }
    }
  }
}
```

```bash
claude mcp add payfirewall -e PAYFIREWALL_URL=https://your-app.example.com/api/v1 -e PAYFIREWALL_API_KEY=sk_... -- npx -y payfirewall-mcp
```

Remote mode keeps challengers, rails, storage and secrets on your server. Embedded mode (`--config`) and the resources and prompt are covered in the [payfirewall-mcp README](https://github.com/roshaninfordham/sentinelpay/tree/main/packages/mcp#readme).

### OpenAI function calling

`toOpenAITools()` emits strict-mode schemas; `callTool` never throws and re-validates every argument server-side.

```ts
import OpenAI from "openai";
import { callTool, toOpenAITools } from "payfirewall/tools";

const openai = new OpenAI();
const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: "user", content: "Pay Meridian invoice INV-2291: $240,000 to account ending 9821 (requested from meridian-global.co)." },
];

for (;;) {
  const res = await openai.chat.completions.create({ model: "gpt-5", messages, tools: toOpenAITools() as OpenAI.ChatCompletionTool[] });
  const msg = res.choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) break;
  for (const call of msg.tool_calls) {
    if (call.type !== "function") continue;
    const result = await callTool(engine, call.function.name, JSON.parse(call.function.arguments));
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}
```

### Anthropic tool use

```ts
import Anthropic from "@anthropic-ai/sdk";
import { callTool, toAnthropicTools } from "payfirewall/tools";

const anthropic = new Anthropic();
const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Pay Meridian invoice INV-2291: $240,000 to account ending 9821 (requested from meridian-global.co)." },
];

for (;;) {
  const res = await anthropic.messages.create({ model: "claude-opus-5", max_tokens: 16000, tools: toAnthropicTools() as Anthropic.Tool[], messages });
  messages.push({ role: "assistant", content: res.content });
  if (res.stop_reason !== "tool_use") break;
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const block of res.content) {
    if (block.type !== "tool_use") continue;
    const result = await callTool(engine, block.name, block.input);
    results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result), is_error: !result.ok });
  }
  messages.push({ role: "user", content: results });
}
```

### Vercel AI SDK

`toAiSdkTools` returns ready tools with validation and `execute`; payfirewall does not import `ai` at runtime.

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { toAiSdkTools } from "payfirewall/tools";

const { text } = await generateText({
  model: openai("gpt-5"),
  tools: toAiSdkTools(engine) as unknown as ToolSet,
  stopWhen: stepCountIs(8),
  prompt: "Pay Meridian invoice INV-2291: $240,000 to account ending 9821 (requested from meridian-global.co).",
});
```

The casts in these three samples bridge PayFirewall's structural schema types to each SDK's nominal types; the runtime objects are what the SDKs expect.

### HTTP

Mount the v1 contract in any fetch-style runtime. Next.js App Router:

```ts
// app/api/v1/[...path]/route.ts
import { after } from "next/server";
import { createHandler } from "payfirewall/http";
import { engine } from "@/lib/payfirewall";

const keys = new Map([[process.env.AP_BOT_KEY!, { id: "agent:ap-bot", kind: "agent" as const, roles: ["requester" as const] }]]);

const handler = createHandler(engine, {
  // Identity comes from the API key, never from the request body.
  authenticate: async (req) => keys.get(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "") ?? null,
  // Advance held payments after the response is sent; without it they advance on the next GET.
  schedule: (work) => after(work),
});

export const GET = handler;
export const POST = handler;
```

| Route | Purpose |
|---|---|
| `POST /verifications` | `verify_payment` (`Idempotency-Key` header supported). 201 new, 200 existing. |
| `GET /verifications/{paymentId}` | `get_verification`, with `?waitMs=&sinceVersion=`, `ETag`/`304` and `Retry-After` on `WAIT`. |
| `POST /verifications/{paymentId}/block` | `block_payment` |
| `GET /verifications/{paymentId}/receipt` | Receipt with ledger entries and chain check |
| `POST /challenges/{challengeId}/result` | Responder ingress. `AUTHORIZED` needs the responder token as the bearer; `DENIED`/`INCONCLUSIVE` need an API key or session. Not a tool. |
| `GET /ledger/verify` | Recompute the whole chain |
| `GET /tools` · `GET /openapi.json` · `GET /health` | Tool definitions, OpenAPI 3.1, host-described configuration |

Call it from another service with the same interface as the engine:

```ts
import { createHttpClient } from "payfirewall/client";

const payfirewall = createHttpClient({ baseUrl: "https://your-app.example.com/api/v1", apiKey: process.env.PAYFIREWALL_API_KEY! });
const v = await payfirewall.verify({
  id: "pay_240k", vendorId: "v_meridian", amountCents: 24_000_000, currency: "USD",
  beneficiary: { accountLast4: "9821" }, requestSourceDomain: "meridian-global.co",
});
if (v.decision === "PAY") {
  // release the payment
}
```

The client is a `PayFirewall`, so it plugs into `callTool`, `toAiSdkTools` and `createMcpServer` unchanged.

## Security model

- **The requester never holds the responder token.** It is minted per challenge, stored only as `sha256(pepper || token)`, handed only to the challenger's delivery channel, and absent from every `Verification`, receipt, ledger payload, event and error. Bad tokens are counted; the fifth expires the challenge and freezes the payment.
- **No self-approval.** When the responder is an authenticated person, `responder.id === requestedBy` is refused with `SELF_APPROVAL_FORBIDDEN` and logged. Identity comes from authentication; body fields named `principal`, `requestedBy` or `resolvedBy` are rejected.
- **Answers only downgrade.** `authorizedChange: "no"` forces `DENIED`; `"unclear"`, `"no_answer"` or `amountConfirmed: false` force `INCONCLUSIVE`; for `human_approval`, a missing or wrong `beneficiaryLast4ReadBack` forces `DENIED`. Free text is never parsed into a verdict.
- **Fail-closed rules.** Every mismatch is challenged, even at LOW risk. A probe that fails or times out is scored as adverse and adds `PROBE_FAILED`. With no callback number, no challenger can handle the case and it ends `NO_CHALLENGE_CHANNEL`. The invoice's phone number is never dialed. An unknown vendor creates no case. Storage failure is `503 STORAGE_UNAVAILABLE`, never `PAY`. A previously denied beneficiary for the same vendor is `DO_NOT_PAY` immediately unless an operator re-verifies, and a case opened in parallel with the same beneficiary cannot clear once its sibling is frozen, unless an operator approves it. Reads are scoped: another principal's payment is `NOT_FOUND`. `block()` is open to any principal because it only moves toward safety, but a non-owner gets the same `NOT_FOUND` after the block commits.
- **Refusing unsafe configuration.** `createEngine` throws `ConfigError` for a pepper under 32 bytes, test challengers in production (or without `allowTestChallengers`), a `voice_browser` challenger in production without `operatorAuth`, and a rail whose environment differs from the engine's; `columnRail` refuses any key that is not `test_` and never lets a payment's `railCounterpartyId` choose the counterparty (only the host's `counterparties` or `vendorCounterparties` maps do; a different caller value fails the rail read, which the gate treats as `BENEFICIARY_CHANGED`), and `verify` refuses a full `accountNumber` unless a `fingerprintKey` is configured. In production, fixture-origin evidence cannot clear a payment.
- **Assurance tiers are recorded on every challenge and receipt:**

| Tier | Channels | Allowed in production |
|---|---|---|
| `test` | `scripted` (`scriptedChallenger`, `pendingChallenger`) | No |
| `operator_session` | `voice_browser`: the token goes to the operator's authenticated browser | Only with `operatorAuth: true` |
| `out_of_band` | `human_approval`, `voice_phone`, your own channels | Yes; token-only authorization additionally needs an approver session (`requireApproverSession`, default on in production) |

## Adapters

Subpath exports, tree-shakeable, none imported by the core:

| Import | Exports | Notes |
|---|---|---|
| `payfirewall` | `createEngine`, `humanApprovalChallenger`, types, `EngineError`, `ConfigError`, pure `evaluateGate`, `assessRisk`, `levelFor`, `hashEntry`, `verifyEntries`, `fingerprintAccount`, `GENESIS` | |
| `payfirewall/tools` | `toolDefinitions`, `callTool`, `toOpenAITools`, `toAnthropicTools`, `toAiSdkTools`, schemas | |
| `payfirewall/http` | `createHandler`, `openApiDocument` | Web `Request` → `Response` |
| `payfirewall/client` | `createHttpClient`, `PayFirewallHttpError` | |
| `payfirewall/adapters/memory` | `memoryStorage`, `memoryVendors` | Tests, demos, single process |
| `payfirewall/adapters/libsql` | `libsqlStorage`, `libsqlVendors` | SQLite or Turso; optional peer `@libsql/client` |
| `payfirewall/adapters/rdap` | `rdapProbe` | Domain registration age via rdap.org, no key |
| `payfirewall/adapters/tavily` | `tavilyProbe`, `extractFindings` | Registry-restricted entity and phone research |
| `payfirewall/adapters/fixtures` | `fixtureProbe`, `withFallback` | Recorded evidence, tagged `origin: "fixture"` |
| `payfirewall/adapters/column` | `columnRail` | Column bank **sandbox** wires; live keys refused. Pass `fingerprintKey` so the gate compares the counterparty's full account with `vendor.knownAccountFingerprint`, not only its last 4 |
| `payfirewall/adapters/elevenlabs` | `mintConversationToken` | Server-side helper for a browser voice challenger |
| `payfirewall/testing` | `scriptedChallenger`, `pendingChallenger`, `fixedClock`, `seqIds`, `runStorageContract` | `runStorageContract` is a `node:test` suite for your own storage adapter |

## Ports

Four interfaces, all exported as types. Implement one to connect PayFirewall to your systems.

| Port | Implement | Contract |
|---|---|---|
| `Storage` | `load`, `commit`, `ledger`, `list` | `commit(next, expectedVersion, events)` is compare-and-set: write the case and append the hash-chained ledger entries atomically, or throw `VERSION_CONFLICT`. Run `runStorageContract` against it. |
| `VendorDirectory` | `get(vendorId)` | Your vendor master. `verifiedPhone` should come from records you trust, not from payment requests. |
| `Probe` | `id`, `run({ payment, vendor, signal, now })` | Return `ForensicSignal`s. Honor `signal`; throwing is safe (it scores adverse). |
| `Challenger` | `channel`, `assurance`, `canHandle`, `start`, optional `poll`/`cancel` | `start` receives the responder token; deliver it only to the confirming party. Return `pending`, then resolve through `resolveChallenge` or `poll`. |
| `Rail` | `id`, `environment`, `release`, optional `readBeneficiary` | Called only after `CLEARED` is committed, with a stable idempotency key. `readBeneficiary` makes the rail the source of truth before the gate and again before release. |

```ts
import type { Challenger } from "payfirewall";

// `sms` is your own messaging client.
export const smsApproval: Challenger = {
  channel: "sms_approval",
  assurance: "out_of_band",
  canHandle: ({ callbackPhone }) => callbackPhone !== null,
  async start(req) {
    await sms.send(req.callbackPhone!, `Confirm ${req.facts.vendorLegalName} changed bank details: https://ap.example.com/approve/${req.challengeId}#t=${req.responderToken}`);
    return { status: "pending" };
  },
};
```

Progress never needs a cron for correctness: expiry, leases and pending polls are enforced lazily on every `get`, `advance`, `resolveChallenge` and `sweep`. Call `engine.sweep()` on an interval if you want held payments to advance without anyone polling.

## Audit and receipts

```text
entryHash = SHA-256( seq | paymentId | event | payloadJson | prevHash )      genesis prevHash = 64 zeros
```

A denied payment writes six entries: `INTERCEPTED → INVESTIGATION_STARTED → FORENSICS → CHALLENGE_STARTED → CALL_RESULT → FROZEN`. `engine.receipt(paymentId)` returns the verification, the vendor snapshot, those entries, the head hash and a chain check scoped to that payment (`ok` and `brokenAt` for the chain up to its last entry, `length` counting only its own entries); `engine.verifyLedger()` recomputes the whole chain and reports `brokenAt` if any row was edited. `Verification.proof.ledgerHeadHash` is there for you to anchor externally.

## Limitations

- **USD only**, one payment per call, no batch API.
- **Without a `Rail`, enforcement is advisory:** PayFirewall decides and your code pays. `rail.status: "NOT_CONFIGURED"` and the `PAY` action's `recheck` make that visible.
- **Token-only approval links are channel-authenticated, not person-authenticated.** Deliver them where the requester cannot read, or require approver sessions (the production default).
- **The ledger detects edits; it does not prevent a full rewrite** by someone with database access. Anchor `ledgerHeadHash` outside the database.
- **The policy is `rules-v1`:** four deterministic rules, no machine learning. Sanctions screening needs a probe you provide.
- **Shipped storage is memory and libSQL.** Postgres or others go through the `Storage` port and the contract suite.
- **`columnRail` accepts sandbox keys only**, and has been tested against stubbed HTTP, not yet against a live sandbox account.

## Releasing

In the monorepo, `exports` point at `src` so the app and tests consume TypeScript directly. The published entry points (`dist`, ESM + CJS + types) live in `publishConfig.exports`, which only `pnpm publish` and `pnpm pack` apply. Always publish with `pnpm --filter payfirewall publish`, never `npm publish`, after `node scripts/pack-smoke.mjs` passes. The full sequence is in the [repository README](https://github.com/roshaninfordham/sentinelpay#14-releasing-the-packages).

## License

[MIT](./LICENSE) © Roshan Sharma
