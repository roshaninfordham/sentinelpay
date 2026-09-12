> **Note (Sep 12, 2026):** original pre-build README. The Rho API was unavailable, so the optional rail integration is the **Column bank sandbox** (`PAYMENT_SOURCE=column`). The current system is documented in the [root README](../README.md) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

# SentinelPay 🛡️

**Autonomous pre-settlement verification control plane for corporate wire disbursements.**

SentinelPay sits in front of the payment rail. When an accounts-payable disbursement carries a **changed vendor bank account**, SentinelPay freezes it, runs live OSINT forensics (domain age via RDAP, real corporate identity via Tavily), places an **out-of-band voice call** to the *real* vendor controller via ElevenLabs, and either clears or quarantines the wire — writing an immutable, hash-chained audit receipt for CFO sign-off. All before the money settles on an irrevocable rail.

Built for **LOCK IN Hack @ Rho** (Sep 12–13, 2026).

- **Money Track (Rho):** intercepts fraud at the exact point of AP disbursement — Rho's core surface.
- **Best Use of Tavily:** Tavily is the investigative engine; no local model can retrieve live corporate registry + domain data.
- **Best ElevenLabs Project:** the voice agent is an active out-of-band *investigator* that runs a challenge–response call and executes a `freeze_payment` tool mid-conversation.

---

## The 45-second story

> A $240,000 wire to "Meridian Global" is pending. An email arrives asking to update the vendor's routing number. Accounts payable is about to pay it. SentinelPay intercepts. Tavily shows the sender domain was registered 72 hours ago; the real Meridian controller's number is pulled from public registries. The agent calls that real number. The controller says: *"We never requested a bank change."* The wire is frozen. $240,000 saved. Zero human hours.

---

## Quickstart

```bash
# 1. Install
pnpm install            # or npm install

# 2. Configure keys (see .env.example for where to get each — all have free tiers)
cp .env.example .env.local

# 3. Seed the demo scenario
pnpm seed

# 4. Run
pnpm dev                # http://localhost:3000
```

Then open the dashboard, click **"Release payment"** on the flagged Meridian wire, and watch the interception fire.

Full setup, API key walkthrough, fallbacks, and the 20-hour build timeline: **[BUILD_GUIDE.md](./BUILD_GUIDE.md)**

---

## Docs

| Doc | What it is |
|-----|-----------|
| [PRD.md](./PRD.md) | Product requirements — problem, users, scope, metrics, success criteria |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, data flow, component contracts, free-API choices |
| [CLAUDE.md](./CLAUDE.md) | Build orchestration for the coding agent + the 7 sub-agents + task board |
| [BUILD_GUIDE.md](./BUILD_GUIDE.md) | Local setup, env keys, run commands, demo fallbacks, hour-by-hour plan |
| [DEMO_SCRIPT.md](./DEMO_SCRIPT.md) | 3-minute live demo choreography + submission checklist |

---

## Stack (all local, all free-tier)

Next.js (App Router, TypeScript) · Tailwind + Framer Motion · SQLite (`better-sqlite3`) · Tavily · ElevenLabs Conversational AI · RDAP (no key) · optional Twilio (~$1) · optional Column bank sandbox.

## Status

Scaffold-ready. Hand [CLAUDE.md](./CLAUDE.md) to your coding agent and let its sub-agents build the vertical slices in parallel.
