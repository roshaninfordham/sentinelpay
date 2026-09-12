@AGENTS.md

# CLAUDE.md — Build orchestration for SentinelPay

> This file is the entry point for the coding agent. It defines a **lead (orchestrator) agent** and **7 specialized sub-agents**, the contracts they share, what runs in parallel vs. serial, and a task board. Read [ARCHITECTURE.md](./References/ARCHITECTURE.md) and [PRD.md](./References/PRD.md) first — they are the source of truth this file coordinates. (Rename/symlink to `AGENTS.md` if your tool prefers that.)

## Prime directive
Ship a **working end-to-end interception demo** (PRD §4.1) before anything else. A payment gets frozen, investigated, challenged by voice, and resolved with an audit receipt — on a single click, locally. Stretch items only after that path runs green.

## Golden rules for every sub-agent
1. **Contracts are law.** Import types from `src/lib/types.ts` (ARCHITECTURE §3). Never redefine a shared type locally. If a contract needs to change, the orchestrator changes it once, everyone re-syncs.
2. **Fallback or it didn't ship.** Every external call (`rdap`, `tavily`, ElevenLabs, Column) needs a cached/mock path guarded by an env flag (`DEMO_MODE=cache`). A demo that dies on venue wifi is a lost demo.
3. **The money decision is deterministic.** Risk `score`/`level` come from `policy.ts` (pure function). An LLM may phrase prose; it may never set the verdict.
4. **Keep it one repo, one language.** TypeScript + Next.js App Router. No Python service, no extra process. SQLite dialect via `@libsql/client` (Turso on Vercel, local file offline).
5. **Small, verifiable commits.** Each sub-agent leaves its slice runnable and adds a one-line note to the task board below.

---

## The team

### 🧭 orchestrator (lead — you)
Owns the spine and integration. Does **not** delegate these:
- Scaffold Next.js + Tailwind + Framer Motion; add `better-sqlite3`.
- Write `src/lib/types.ts` (paste from ARCHITECTURE §3) and `src/lib/db.ts`.
- Write `scripts/seed.ts` (the demo vendor + poisoned payment — see Seed data below).
- Define the `PaymentSource` / `VendorDirectory` interfaces and the `DEMO_MODE` env contract.
- Wire sub-agents' slices together; run the end-to-end smoke test after each merge.
- Own the build order (ARCHITECTURE §8) and unblock sub-agents.

Spin up the sub-agents below. **Wave 1** (data-agent, forensics-agent, ledger-agent) can run fully in parallel once the spine exists — they share only `types.ts`. **Wave 2** (frontend-agent, voice-agent) depend on Wave 1 endpoints. **Wave 3** (integration-agent, then demo-agent) close it out.

---

### 🗄️ data-agent  · Wave 1 · owns `src/lib/providers/`, `app/api/webhook/route.ts`, `src/lib/gate.ts`
**Charter:** ingest disbursement events and freeze on beneficiary mismatch.
- Implement `MockPaymentSource` (reads SQLite) implementing `PaymentSource`.
- Implement `gate.ts`: compare `claimedBankLast4`/`requestSourceDomain` to the vendor master; set `PENDING_REVIEW` + trigger investigation, else `CLEARED`.
- `POST /api/webhook` accepts a `Payment`-shaped body and runs the gate.
- **Stretch:** `ColumnPaymentSource` — beneficiary from Column sandbox counterparties; verified release creates a sandbox wire (Rho API unavailable). Env: `PAYMENT_SOURCE=mock|column`.
**Done when:** posting the seeded poisoned payment lands it in `PENDING_REVIEW` and emits an investigation trigger.

### 🔎 forensics-agent  · Wave 1 · owns `src/lib/forensics/`, `app/api/investigate/route.ts`
**Charter:** turn a frozen payment into a `RiskAssessment` with a verified callback number.
- `rdap.ts`: `GET https://rdap.org/domain/{domain}`, parse `events[].eventAction == "registration"` → `domain_age_days`. No key. Cache the seeded domain's response to `fixtures/rdap.json`.
- `tavily.ts`: Tavily `search` (`search_depth:"advanced"`, `include_domains` registry set) to resolve the verified corporate phone + entity match. Cache to `fixtures/tavily.json`. Honor `DEMO_MODE=cache`.
- `policy.ts`: the pure risk function (ARCHITECTURE §4 Node 2). Unit-test it with 3 cases (clean / new-domain / sanctioned).
- `index.ts`: run RDAP + Tavily in parallel, merge into `RiskAssessment`, stream each `ForensicSignal.detail` line to the terminal (via the stream endpoint).
**Done when:** `/api/investigate` returns `CRITICAL` for the seeded payment with `verifiedCallbackPhone` set and 3–5 terminal lines.

### 🔐 ledger-agent  · Wave 1 · owns `src/lib/ledger.ts`, `app/api/governor/decide/route.ts`, `app/api/incident/[id]/route.ts`
**Charter:** durable, tamper-evident decisions.
- `appendLedger(event, paymentId, payload)` — SHA-256 hash chain (ARCHITECTURE §4 Node 4). `verifyChain()` recomputes and returns ok/broken.
- `decide(paymentId, verdict)` — set `QUARANTINED`/`CLEARED`, append ledger, return the receipt.
- Incident receipt: JSON + a print-friendly HTML route (`window.print()` → PDF; no dependency).
**Done when:** two decisions produce a chain that `verifyChain()` validates, and tampering one row fails it.

### 🖥️ frontend-agent  · Wave 2 · owns `app/page.tsx`, `src/components/`, `app/api/stream/route.ts`
**Charter:** the operator dashboard and the drama.
- Panels: `Queue`, `Terminal` (streams forensic lines), `CallConsole` (agent state + simple animated waveform), `ResolutionShield` (Framer Motion red shield: `PAYMENT FROZEN · $240,000 SAVED`, + receipt link).
- Live updates: SSE from `/api/stream`, or 1s polling (simpler — prefer if time-boxed).
- Dark, high-contrast, "treasury command center" look. Read `/mnt/skills/public/frontend-design/SKILL.md` for design tokens before styling.
**Done when:** clicking **Release** on the flagged wire visibly walks `PENDING → INVESTIGATING → CHALLENGING → FROZEN` with the terminal + shield.

### 📞 voice-agent  · Wave 2 · owns `src/lib/voice/`, `app/api/voice/token/route.ts`
**Charter:** the out-of-band challenge call — the ElevenLabs star.
- Configure the Conversational AI agent (persona = "SentinelPay settlement desk"), prompt + tool schema in `agent.config.md`.
- Client tools `approve_payment` / `freeze_payment` → `POST /api/governor/decide`. Register in `tools.ts`.
- Browser mode: `@elevenlabs/react` `useConversation()` in `CallConsole`; mint a signed session token server-side at `/api/voice/token`, inject dynamic vars (`amount`, `vendor`, `newLast4`).
- **Stretch:** ElevenLabs native Twilio outbound for the podium phone-ring (BUILD_GUIDE §Twilio).
**Done when:** in-browser, the agent asks the authorization question, you answer "no," and the wire flips to `QUARANTINED` via the tool call.

### 🔗 integration-agent  · Wave 3 · owns end-to-end glue + `DEMO_MODE`
**Charter:** make the four nodes one continuous flow; add every fallback.
- Chain gate → investigate → challenge → decide with correct state transitions and stream events.
- Implement `DEMO_MODE=cache` across rdap/tavily/voice so the full path runs with wifi off.
- Add a "reset demo" action that re-seeds in one click.
**Done when:** `pnpm seed && pnpm dev`, one click, wifi off → full interception completes < 60s.

### 🎬 demo-agent  · Wave 3 · owns `scripts/`, demo polish, README run-from-clone
**Charter:** the thing judges actually see.
- Verify the [DEMO_SCRIPT.md](./References/DEMO_SCRIPT.md) beats land on the real UI; tune copy/timing.
- Ensure README quickstart runs from a fresh clone; sample data included.
- Prep the 3-min recording path + the social post from the event template.
**Done when:** a cold clone → running demo in < 5 min following only the README.

---

## Seed data (orchestrator writes; everyone codes against it)

```ts
// scripts/seed.ts — the one scenario the whole demo hangs on
const vendor = {
  id: "v_meridian",
  legalName: "Meridian Global Logistics LLC",
  knownDomain: "meridianglobal.com",      // long-lived, real-looking
  knownBankLast4: "4471",                  // beneficiary on file
  registryUrl: "https://opencorporates.com/…",
};
const poisonedPayment = {
  id: "pay_240k",
  vendorId: "v_meridian",
  amountCents: 24000000,                   // $240,000.00
  currency: "USD",
  claimedBankLast4: "9821",                // CHANGED → triggers the gate
  requestSourceDomain: "meridian-global.co", // registered ~72h ago
  invoiceContactPhone: "+1-000-000-0000",  // attacker's footer number — never trusted
  status: "RECEIVED",
};
// Fixtures: fixtures/rdap.json (72h age for meridian-global.co),
//           fixtures/tavily.json (verified line (312) 555-0198 for the real entity)
```

Pick a `requestSourceDomain` you can actually control so RDAP returns a genuinely young age live; otherwise rely on the cached fixture. Keep the *real* domain as something with real registry history for the contrast.

---

## Task board (append one line per completed slice; keep it honest)

- [x] orchestrator — scaffold (Next 16) + types + db + seed (`src/lib/{types,db,seed-data}.ts`, `@/*` → `src/*`)
- [x] data-agent — mock source + gate + webhook + `/api/release`
- [x] forensics-agent — rdap + tavily + policy (+tests) + investigate; `.co` has no RDAP server → scenario fixture
- [x] ledger-agent — hash chain + governor (fail-closed) + JSON receipt + printable `/incident/[id]`
- [x] frontend-agent — dashboard + polling `/api/stream` + terminal + call console + frozen shield
- [x] voice-agent — ElevenLabs browser agent (token route, client tools, agent.config.md) + scripted fallback on the same tools. Live agent NOT exercised yet (no keys).
- [x] integration-agent — one-click E2E, `DEMO_MODE=cache`, reset button; verified in browser (~25s click → frozen)
- [x] deploy — Vercel production (https://sentinelpay-sigma.vercel.app) on Turso; libSQL async data layer; E2E verified on prod (release → forensics → call → FROZEN, chain ok)
- [x] docs — landing README (problem, tracks, solution, sourced + measured numbers, mermaid architecture), docs/ARCHITECTURE.md, MIT LICENSE
- [ ] demo-agent — record video, rehearse; replace authored Tavily fixture with a real capture (`pnpm capture --write-tavily`)
- [x] (stretch) data-agent — Column sandbox rail (`providers/column*.ts`, `pnpm column:setup`, 3 tests). Not yet run against a real sandbox key.
- [ ] (stretch) voice-agent — Twilio outbound
- [ ] (stretch) forensics-agent — OpenSanctions screen

## Definition of done (the whole thing)
`git clone` → `pnpm install` → `cp .env.example .env.local` (keys) → `pnpm seed` → `pnpm dev` → one click freezes a $240k wire, runs live forensics, challenges by voice, and shows an auditable frozen-shield receipt — with a wifi-off fallback that still completes.
