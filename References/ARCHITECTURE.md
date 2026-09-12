> **Note (Sep 12, 2026):** pre-build planning doc. The Rho API was unavailable, so the optional rail integration is the **Column bank sandbox** (`PAYMENT_SOURCE=column`). The current system is documented in the [root README](../README.md) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

# SentinelPay — Architecture

Design goal: **one repo, one language, one dev server, zero cloud** — so a solo builder can ship it in ~20 hours and demo it from a laptop. Everything is TypeScript in a single Next.js app. State lives in SQLite. External intelligence is Tavily + RDAP; voice is ElevenLabs. Every external dependency has a local fallback.

---

## 1. System diagram

```
                       ┌──────────────────────────────────────────────┐
                       │            Next.js app (localhost:3000)        │
                       │                                                │
  Disbursement event   │   ┌────────────────┐     ┌─────────────────┐  │
  (mock webhook OR ────┼──▶│ 1. Interception│────▶│ 2. Forensics    │  │
   bank sandbox)       │   │    & Policy Gate│     │    Engine       │  │
                       │   └────────────────┘     │  RDAP + Tavily  │  │
                       │            │              └────────┬────────┘  │
                       │            │                       │           │
                       │            ▼                       ▼           │
                       │   ┌────────────────┐     ┌─────────────────┐  │
                       │   │ 4. Settlement  │◀────│ 3. Voice Agent  │  │
                       │   │    Governor +  │     │  (ElevenLabs)   │  │
                       │   │    Audit Ledger│     │  challenge call │  │
                       │   └───────┬────────┘     └─────────────────┘  │
                       │           │                                    │
                       │           ▼                                    │
                       │   SQLite (payments, vendors, ledger)           │
                       └───────────────────────────────────────────────┘
                                   │
                                   ▼
                  Operator Dashboard (queue • live terminal • call state • frozen shield)
```

Data flows one direction through four nodes. The dashboard subscribes to state changes (SSE or polling) and renders each transition. The voice agent's client tools call back into the governor.

---

## 2. State machine (the payment's life)

```
RECEIVED ──▶ PENDING_REVIEW ──▶ INVESTIGATING ──▶ CHALLENGING ──▶ QUARANTINED
                  │                                     │
                  └────────(no beneficiary change)──────┴────▶ CLEARED
```

- `RECEIVED` — event ingested.
- `PENDING_REVIEW` — beneficiary changed vs. vendor master → frozen, do not release.
- `INVESTIGATING` — forensics running (RDAP + Tavily).
- `CHALLENGING` — voice agent on the call.
- `QUARANTINED` — fraud confirmed/denied change → wire held. Terminal.
- `CLEARED` — verified authorized → released. Terminal.

Every transition writes a ledger entry. Money never leaves `PENDING_REVIEW`/`CHALLENGING` without an explicit governor decision.

---

## 3. Core contracts (single source of truth)

All sub-agents build against these. Put them in `src/lib/types.ts`.

```ts
export type PaymentStatus =
  | "RECEIVED" | "PENDING_REVIEW" | "INVESTIGATING"
  | "CHALLENGING" | "QUARANTINED" | "CLEARED";

export type RiskLevel = "LOW" | "ELEVATED" | "CRITICAL";

export interface Vendor {
  id: string;
  legalName: string;              // "Meridian Global Logistics LLC"
  knownDomain: string;            // "meridianglobal.com"  (the REAL, long-lived domain)
  knownBankLast4: string;         // beneficiary on file
  verifiedPhone?: string;         // resolved on demand; never trusted from the invoice
  registryUrl?: string;           // SEC/state/opencorporates ref
}

export interface Payment {
  id: string;
  vendorId: string;
  amountCents: number;            // 24000000 = $240,000.00
  currency: "USD";
  // details as they arrive on THIS disbursement (attacker-controlled surface):
  claimedBankLast4: string;
  requestSourceDomain: string;    // domain the change request came from
  invoiceContactPhone?: string;   // the number printed on the invoice (do NOT trust)
  status: PaymentStatus;
  createdAt: string;
}

export interface ForensicSignal {
  key: "domain_age_days" | "entity_match" | "verified_phone" | "adverse_media" | "sanctions_hit";
  value: string | number | boolean;
  source: "rdap" | "tavily" | "opensanctions";
  detail?: string;                // human-readable line for the terminal
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;                  // 0..100
  signals: ForensicSignal[];
  verifiedCallbackPhone?: string; // the number the voice agent must dial
  rationale: string;              // one paragraph, plain English
}

export type Verdict = "AUTHORIZED" | "DENIED" | "INCONCLUSIVE";

export interface CallOutcome {
  paymentId: string;
  verdict: Verdict;
  transcript: string;
  toolInvoked: "approve_payment" | "freeze_payment" | null;
  durationSec: number;
}

export interface LedgerEntry {
  seq: number;
  paymentId: string;
  event: string;                  // "INTERCEPTED" | "FORENSICS" | "CALL_RESULT" | "FROZEN" | "CLEARED"
  payload: unknown;
  prevHash: string;               // hex
  entryHash: string;              // sha256(seq|paymentId|event|payload|prevHash)
  ts: string;
}
```

**Provider interfaces** (lets mock ↔ Column sandbox swap without touching the pipeline):

```ts
export interface PaymentSource {
  listPending(): Promise<Payment[]>;
  get(id: string): Promise<Payment>;
  // enforcement hook — in prod a bank/AP system honors this; in demo it just updates state
  setStatus(id: string, status: PaymentStatus): Promise<void>;
}

export interface VendorDirectory {
  get(vendorId: string): Promise<Vendor>;
}
```

---

## 4. Components (node by node)

### Node 1 — Interception & Policy Gate  (`src/lib/gate.ts`, `app/api/webhook/route.ts`)
- Entry: `POST /api/webhook` (mock ERP/AP event) **or** the bank-sandbox rail.
- Logic: load vendor master; if `payment.claimedBankLast4 !== vendor.knownBankLast4` **or** `requestSourceDomain !== vendor.knownDomain` → `PENDING_REVIEW`, kick off forensics. Else `CLEARED`.
- Output: payment frozen + `investigation.start(paymentId)`.

### Node 2 — Forensics Engine  (`src/lib/forensics/`)
Two independent probes, run in parallel, merged into a `RiskAssessment`.

- **RDAP probe** (`rdap.ts`) — deterministic, free, **no key**. `GET https://rdap.org/domain/{domain}` → parse the `registration` event date → `domain_age_days`. A domain < 30 days old on a $100k+ change request is a hard CRITICAL signal.
- **Tavily probe** (`tavily.ts`) — corporate identity resolution. Queries (advanced depth):
  - `"{vendor.legalName} headquarters corporate phone"` restricted to registry domains (`sec.gov`, `opencorporates.com`, `bloomberg.com`).
  - `"{requestSourceDomain} whois legitimacy"` for corroboration.
  - Extract the **verified corporate phone** → `verifiedCallbackPhone`. This is the number the voice node dials — never the invoice number.
- **Risk policy** (`policy.ts`) — pure function, no LLM:
  ```
  score = 0
  if domain_age_days < 30      → +50, note "request domain registered {n} days ago"
  if entity_match == false      → +20
  if verified_phone != invoice_phone → +20, note "invoice number differs from registry number"
  if sanctions_hit             → +40
  level = score>=60 CRITICAL | score>=30 ELEVATED | LOW
  ```
  Deterministic and reproducible — this is what auditors and judges trust. (An LLM may *phrase* the rationale, but must not change `score`/`level`.)

### Node 3 — Voice Agent  (`src/lib/voice/`, `app/api/voice/`)
ElevenLabs Conversational AI. Two modes behind one component:

- **Browser (default, reliable):** `@elevenlabs/react` `useConversation()` mounts the agent in the dashboard over WebRTC. Client tools `approve_payment` / `freeze_payment` fire from the spoken outcome and `POST /api/governor/decide`.
- **Phone (stretch, dramatic):** ElevenLabs native Twilio integration. Import a Twilio number, trigger an outbound call to the verified number (on stage, the presenter's phone). Same agent, same tools via server webhook.

Agent config lives in the ElevenLabs dashboard; prompt + tool schema are version-controlled in `src/lib/voice/agent.config.md`. Dynamic variables (`amount`, `vendor`, `newLast4`) are injected per call.

### Node 4 — Settlement Governor + Audit Ledger  (`src/lib/ledger.ts`, `app/api/governor/`)
- `decide(paymentId, verdict)` → set `QUARANTINED` (DENIED) or `CLEARED` (AUTHORIZED); write ledger entry.
- **Hash chain:** `entryHash = sha256(seq | paymentId | event | JSON(payload) | prevHash)`. Genesis `prevHash = "0"×64`. A `verifyChain()` recomputes every hash — one tampered row breaks the chain. Cheap, honest "immutability," no blockchain needed.
- `GET /api/incident/{paymentId}` → JSON receipt + a print-friendly HTML page (`window.print()` → PDF, no lib).

### Dashboard  (`app/page.tsx`, `src/components/`)
Panels: **Payment Queue** (status pills) · **Investigation Terminal** (streams `ForensicSignal.detail` lines) · **Call Console** (agent state + a lightweight waveform) · **Resolution** (the red `PAYMENT FROZEN · $X SAVED` shield + receipt). Live updates via SSE (`app/api/stream/route.ts`) or 1s polling — polling is fine and simpler; use it if SSE eats time.

---

## 5. External services & why each is safe/free

| Service | Role | Cost | Fallback |
|---|---|---|---|
| **RDAP** (`rdap.org`) | Domain age — the hard signal | Free, no key | Bundled WHOIS JSON for the demo domain |
| **Tavily** | Corporate identity / real phone / adverse media | Free tier + sponsor credits | Cached JSON response for the seeded vendor |
| **ElevenLabs** | Out-of-band voice challenge + tool calls | Free tier + sponsor credits | Browser agent; pre-recorded outcome as last resort |
| **Column sandbox** (optional) | Beneficiary records + sandbox wires on release | Free sandbox | Mock provider (default) |
| **Twilio** (optional) | Real outbound phone call | ~$1 number | Browser WebRTC (default) |
| **OpenSanctions** (optional) | Beneficiary screening | Free API | Skip; P2 only |
| LLM (optional) | Narrative incident summary only | Any free tier | Templated string |

No secret is ever shipped to the client except the ElevenLabs **signed conversation token** minted server-side per session.

---

## 6. Data model (SQLite)

```
vendors(id, legalName, knownDomain, knownBankLast4, verifiedPhone, registryUrl)
payments(id, vendorId, amountCents, currency, claimedBankLast4,
         requestSourceDomain, invoiceContactPhone, status, createdAt)
ledger(seq PK, paymentId, event, payload_json, prevHash, entryHash, ts)
```

`better-sqlite3` (synchronous, zero-config, single file `sentinel.db`). Seed script writes the demo vendor (real 20-yr domain) + the poisoned payment (72h domain, new last4).

---

## 7. Directory layout

```
sentinelpay/
├─ app/
│  ├─ page.tsx                     # dashboard
│  ├─ api/
│  │  ├─ webhook/route.ts          # ingest disbursement
│  │  ├─ investigate/route.ts      # run forensics for a payment
│  │  ├─ voice/token/route.ts      # mint ElevenLabs session token
│  │  ├─ governor/decide/route.ts  # approve/freeze + ledger
│  │  ├─ incident/[id]/route.ts    # receipt
│  │  └─ stream/route.ts           # SSE (or poll)
├─ src/
│  ├─ lib/
│  │  ├─ types.ts                  # §3 contracts
│  │  ├─ db.ts                     # better-sqlite3
│  │  ├─ gate.ts                   # Node 1
│  │  ├─ forensics/{rdap,tavily,policy,index}.ts   # Node 2
│  │  ├─ voice/{agent.config.md,tools.ts}          # Node 3
│  │  ├─ ledger.ts                 # Node 4 (hash chain)
│  │  └─ providers/{mock,column}.ts   # PaymentSource impls
│  └─ components/{Queue,Terminal,CallConsole,ResolutionShield}.tsx
├─ scripts/seed.ts
├─ .env.example
└─ [docs]
```

---

## 8. Build order (dependency-correct)
1. `types.ts` + `db.ts` + `scripts/seed.ts` — the spine. Everything imports these.
2. Mock `PaymentSource` + `gate.ts` + `/api/webhook` — you can now freeze a payment.
3. Forensics (`rdap` → `policy` → `tavily`) — RDAP first (works offline against a real domain), Tavily second.
4. Ledger + governor — decisions become durable + auditable.
5. Dashboard wiring — make state visible.
6. Voice (browser) — the star; needs 2–4 above to have something to decide.
7. Polish + fallbacks + (optional) Column/Twilio/sanctions.

This order guarantees a *working end-to-end path by step 5* even if voice slips — you can always narrate the interception. See [CLAUDE.md](./CLAUDE.md) for the sub-agent assignment of these slices.
