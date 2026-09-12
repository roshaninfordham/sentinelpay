> **Note (Sep 12, 2026):** pre-build planning doc. The Rho API was unavailable, so the optional rail integration is the **Column bank sandbox** (`PAYMENT_SOURCE=column`). The current system is documented in the [root README](../README.md) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

# SentinelPay — Build Guide

Everything to go from empty folder to a demo-ready app on your laptop. Solo, ~20 hours.

---

## 0. Prereqs
- Node ≥ 20, `pnpm` (or npm). `npm i -g pnpm`.
- A phone or second laptop for the voice demo (browser mode).
- Optional: a Twilio account (~$1 for a number) for the phone-ring version.

## 1. Scaffold
```bash
pnpm create next-app@latest sentinelpay --ts --app --tailwind --eslint --src-dir=false
cd sentinelpay
pnpm add better-sqlite3 framer-motion @elevenlabs/react @tavily/core
pnpm add -D tsx @types/better-sqlite3
```
(If `@tavily/core` isn't resolving, call Tavily's REST endpoint directly with `fetch` — it's a single POST; see §3.)

## 2. Environment keys

```bash
cp .env.example .env.local
```

| Var | Where to get it | Needed for |
|---|---|---|
| `TAVILY_API_KEY` | tavily.com → dashboard (free tier; grab sponsor credits at the event) | Forensics |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profile → API Keys (sponsor: 3 mo Scale for winners) | Voice |
| `ELEVENLABS_AGENT_ID` | Create a Conversational AI agent → copy its ID | Voice |
| `DEMO_MODE` | `live` or `cache` — flip to `cache` to run with wifi off | Demo safety |
| `PAYMENT_SOURCE` | `mock` (default) or `column` | Payment rail |
| `COLUMN_API_KEY` | dashboard.column.com → sandbox key `test_…` (optional) | Bank-sandbox rail |
| `TWILIO_*` | twilio.com console (optional) | Phone-ring stretch |
| `OPENSANCTIONS_API_KEY` | opensanctions.org (optional, has free use) | Sanctions stretch |

RDAP needs **no key**.

## 3. The three external calls (exact shapes)

**RDAP (domain age, free, no key):**
```ts
const r = await fetch(`https://rdap.org/domain/${domain}`);
const j = await r.json();
const reg = j.events?.find((e:any)=>e.eventAction==="registration")?.eventDate;
const ageDays = reg ? Math.floor((Date.now()-Date.parse(reg))/864e5) : null;
```

**Tavily (corporate OSINT):**
```ts
const r = await fetch("https://api.tavily.com/search", {
  method:"POST", headers:{ "Content-Type":"application/json" },
  body: JSON.stringify({
    api_key: process.env.TAVILY_API_KEY,
    query: `${legalName} headquarters corporate phone`,
    search_depth: "advanced",
    include_domains: ["sec.gov","opencorporates.com","bloomberg.com"],
    max_results: 5,
  }),
});
```

**ElevenLabs (browser agent):** mint a signed token server-side, then start the conversation client-side.
```ts
// server: /api/voice/token
const r = await fetch(
  `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
  { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! } });
// client: const conv = useConversation(); await conv.startSession({ conversationToken });
```
Register client tools `approve_payment` / `freeze_payment` in the agent so it calls back into `/api/governor/decide`. (Check the current `@elevenlabs/react` README when you wire this — the SDK moves fast; the token-then-startSession pattern is stable.)

## 4. Run
```bash
pnpm seed         # writes sentinel.db with the Meridian scenario + fixtures
pnpm dev          # localhost:3000
```

`package.json` scripts:
```json
{ "scripts": {
  "dev": "next dev",
  "seed": "tsx scripts/seed.ts",
  "demo:reset": "tsx scripts/seed.ts --reset"
}}
```

---

## 5. Fallbacks (rehearse the wifi-off run)
`DEMO_MODE=cache` must make the whole path run offline:
- **RDAP** → serve `fixtures/rdap.json` (72h age for the request domain).
- **Tavily** → serve `fixtures/tavily.json` (verified line `(312) 555-0198`, entity match).
- **Voice** → browser agent still works on local network; if the venue blocks it, fall back to a pre-recorded "we never requested a bank change" outcome that still triggers `freeze_payment`.
- Record your capture of the live calls *during setup* so the fixtures are real, not invented.

Test it: turn wifi **off**, `DEMO_MODE=cache`, run the full click-through. If it completes, you're safe.

---

## 6. Optional: real outbound phone call (Twilio) — the podium drama
1. Buy a Twilio number (Voice-capable).
2. ElevenLabs dashboard → **Phone Numbers** → import the Twilio number (Account SID + Auth Token). ElevenLabs auto-configures the voice webhook.
3. Assign your agent to the number.
4. Trigger the outbound call (dashboard "Outbound call" button, or the ElevenLabs API) to the *verified* number — on stage, your own phone on speaker.
5. Same client tools fire from the spoken denial. Keep the browser version wired as the fallback.

## 7. Optional: Column bank-sandbox rail (replaces the unavailable Rho API)
- dashboard.column.com → copy the **sandbox** key (`test_…`) into `COLUMN_API_KEY`.
- `pnpm column:setup` creates a funded AP bank account and counterparties (vendor accounts on file + the attacker's account).
- Set `PAYMENT_SOURCE=column` and `DEMO_MODE=live`. The gate reads beneficiaries from Column; a verified release creates a sandbox wire and a freeze creates none.

---

## 8. 20-hour timeline (Sat noon → Sun 8am, submit noon)

| Block | Goal | Exit check |
|---|---|---|
| **Sat 12:30–15:00** | Spine: scaffold, `types.ts`, `db.ts`, `seed.ts`, mock source, gate, `/api/webhook` | Posting the poisoned payment → `PENDING_REVIEW` |
| **Sat 15:00–18:00** | Forensics: RDAP → policy → Tavily; `/api/investigate`; cache fixtures | Seeded payment returns `CRITICAL` + verified phone |
| **Sat 18:00–21:00** | Ledger + governor + receipt; dashboard skeleton with live terminal | Two decisions form a valid hash chain; terminal streams |
| **Sat 21:00–01:00** | Voice: ElevenLabs browser agent + tools wired to governor | Say "no" in browser → wire `QUARANTINED` |
| **Sat 01:00–04:00** | Integration: full E2E on one click; `DEMO_MODE=cache`; frozen-shield polish | Wifi-off click-through completes < 60s |
| **Sat 04:00–06:00** | (sleep / buffer) | — |
| **Sun 06:00–09:00** | Stretch (pick ONE): Column sandbox rail **or** Twilio call **or** sanctions | The chosen bonus visible in demo |
| **Sun 09:00–11:00** | Record 3-min video; social post; README from-clone check; rehearse | Cold clone runs; video done |
| **Sun 11:00–12:00** | Buffer + submit (repo shared with `lockinhack@rho.co` if private) | Submitted |

Guardrail: if you're behind at **Sat 01:00**, cut voice to browser-only + cached outcome and cut all stretch. A crisp interception with a narrated call beats a broken live call.

---

## 9. Submission checklist (from the Rho brief)
- [ ] Working project (runs from clone)
- [ ] Project description (what it does + how it works)
- [ ] Demo video **< 3 min**, audio covering the tech stack
- [ ] Social post on LinkedIn or X (use Rho's template)
- [ ] Repo URL — public with a license, **or** private and shared with `lockinhack@rho.co`
- [ ] README with setup, sample data, run instructions
