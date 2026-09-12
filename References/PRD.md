> **Note (Sep 12, 2026):** pre-build planning doc. The Rho API was unavailable, so the optional rail integration is the **Column bank sandbox** (`PAYMENT_SOURCE=column`). The current system is documented in the [root README](../README.md) and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

# SentinelPay — Product Requirements Document

**Version:** 1.0 · **Author:** Roshan · **Event:** LOCK IN Hack @ Rho (Sep 12–13, 2026)
**One-liner:** An autonomous pre-settlement control plane that intercepts business-email-compromise (BEC) wire fraud at the point of AP disbursement, using live web forensics and an out-of-band voice challenge, before funds settle on an irrevocable rail.

---

## 1. Problem

Corporate accounts payable moves real money on rails where settlement is final. Attackers exploit the weakest link — human trust in an email thread. They compromise a legitimate vendor's mailbox, lurk in an active billing thread, and inject a **new routing/account number** onto a pending invoice. Modern AP tooling happily extracts the data, matches the PO, and schedules the wire. Governance *requires* an out-of-band phone call to confirm bank-detail changes, but under volume, staff skip it — or call the spoofed number in the attacker's email footer. Once a Fedwire/SWIFT instruction clears, recovery is close to impossible.

The gap is not detection of *what* the invoice says. It is **independent verification of who you are actually paying**, executed fast enough to matter, and cheap enough to run on every changed-beneficiary payment.

### 1.1 Why now
- The verification step is a phone call and a background check — exactly the two things an autonomous agent with live web access and low-latency voice can now do end to end, in under a minute, on every payment rather than a sampled few.
- Rho's own thesis is that manual AP is obsolete. SentinelPay is the safety layer that makes *autonomous* AP trustworthy: money movement bound by external verification.

---

## 2. Market & impact (defensible figures)

| Indicator | Figure | Source |
|---|---|---|
| US BEC losses, 2024 | **$2.77B** across **21,442** reported incidents (2nd-largest loss category at IC3) | FBI IC3 2024 Annual Report (released Apr 2025) |
| BEC losses reported to IC3, 2022–2024 | **~$8.5B** | FBI IC3 / Nacha |
| BEC losses since 2015 | **$17.1B** | FBI IC3 |
| Organizations hit by payments-fraud attacks/attempts in 2024 | **79%** (63% name BEC the #1 avenue for attempts) | AFP 2025 Payments Fraud & Control Survey |
| Total IC3 cybercrime losses, 2024 | **$16.6B** (+33% YoY) | FBI IC3 2024 |
| Recovery when reported fast | IC3 Recovery Asset Team reports a **~66%** freeze-success rate on flagged transfers acted on quickly | FBI IC3 2024 |

> **The thesis in one line:** recovery works *only* if you catch it before settlement. SentinelPay's entire job is to move the verification to the pre-settlement window and make it automatic.

**Note on sourcing:** Use the figures above, not larger unverifiable numbers. The $2.77B / 21,442 / 63% figures are directly traceable to the FBI IC3 2024 report and the AFP survey, which judges can check. See Sources at the end.

---

## 3. Users & jobs-to-be-done

| User | Job | SentinelPay delivers |
|---|---|---|
| AP specialist / controller | "Release this batch without becoming the person who wired $240k to a mule." | Auto-verification on every changed-beneficiary payment; no manual call needed. |
| CFO / Treasury | "Prove to the board and auditors we have controls on outbound money." | Immutable, hash-chained audit receipt per decision; incident report export. |
| Vendor's real controller | "Stop people wiring my payments to an impostor." | Receives a clear out-of-band challenge call on their *real* number. |
| Rho (platform) | "Make autonomous AP safe enough to trust." | A verification control plane that plugs in front of the disbursement. |

---

## 4. Scope

### 4.1 In scope (demo-critical — must ship)
1. **Interception gate** — detect a payment whose beneficiary bank details differ from the vendor master; freeze it in `PENDING_REVIEW`.
2. **Forensics engine** — RDAP domain-age lookup (deterministic) + Tavily corporate OSINT (real phone, entity confirmation, adverse signals). Produce a risk score + the *verified* callback number.
3. **Out-of-band voice challenge** — ElevenLabs Conversational AI agent calls the verified controller, runs a scripted challenge–response, and invokes `freeze_payment` / `approve_payment` from the spoken outcome.
4. **Settlement governor + audit ledger** — set final state (`QUARANTINED` / `CLEARED`), write a SHA-256 hash-chained ledger entry, generate an exportable incident receipt.
5. **Operator dashboard** — payment queue, live investigation terminal, call state + waveform, and the dramatic frozen-shield resolution.

### 4.2 Stretch (differentiators, only after 4.1 is demo-proof)
- **Bank-API sandbox rail** — read beneficiaries from Column sandbox counterparties and create a real sandbox wire only on a verified release (replaces the unavailable Rho API).
- **Real outbound phone call** via ElevenLabs native Twilio integration (→ podium phone-ring drama).
- **Sanctions/mule screening** of the beneficiary via a free sanctions dataset (OpenSanctions).

### 4.3 Out of scope (say so if asked)
- Actually halting a live wire on a real bank rail (SentinelPay is a *recommendation/control* layer; the enforcement hook is a webhook a bank would honor).
- Production auth, multi-tenant, SOC2. This is a control-plane prototype.
- Email ingestion / mailbox monitoring — the trigger is the AP disbursement event, not the inbox.

---

## 5. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | System ingests a disbursement event (webhook or bank-sandbox rail) and compares beneficiary details to the vendor master. | P0 |
| FR-2 | On a beneficiary mismatch, the payment is frozen before any release and enters the forensics pipeline. | P0 |
| FR-3 | Forensics resolves domain registration age via RDAP and returns a numeric age in days. | P0 |
| FR-4 | Forensics uses Tavily (`search_depth: "advanced"`) to retrieve the vendor's verified corporate phone and corroborate the legal entity; it **ignores** the contact info on the disputed invoice. | P0 |
| FR-5 | A deterministic risk policy converts signals into `LOW / ELEVATED / CRITICAL` with a human-readable rationale. | P0 |
| FR-6 | The voice agent calls the verified number, states the payment + the requested change, and asks a yes/no authorization question. | P0 |
| FR-7 | The agent invokes `freeze_payment` or `approve_payment` from the spoken answer, updating state in real time. | P0 |
| FR-8 | Every decision writes a hash-chained ledger entry (`prev_hash` + payload → `entry_hash`); the chain is verifiable. | P0 |
| FR-9 | Dashboard reflects each state transition live (`PENDING → INVESTIGATING → CALLING → FROZEN/CLEARED`). | P0 |
| FR-10 | An incident receipt (JSON + printable) is generated per resolved case. | P1 |
| FR-11 | Data layer swaps between `mock` and `column` (sandbox) providers behind one interface. | P1 |
| FR-12 | Beneficiary is screened against a sanctions/mule list. | P2 |

---

## 6. Non-functional requirements
- **Runs fully locally** on a laptop; single `pnpm dev`. No cloud deploy required for judging.
- **Demo-safe:** every external call has a cached/mock fallback so a wifi drop can't kill the demo (see BUILD_GUIDE §Fallbacks).
- **End-to-end interception completes in < 60s** on stage.
- **Auditable & deterministic** where it matters: the risk decision is rule-based and reproducible; the LLM is used only for narrative, never for the money decision.

---

## 7. Success metrics

**Product (what we claim on stage):**
- Time-to-verification: **< 60s** autonomous vs. the manual out-of-band call that gets skipped under load.
- Coverage: verification runs on **100%** of changed-beneficiary payments, not a sample.
- Dollars protected in the demo scenario: **$240,000**, intercepted pre-settlement.
- Audit: **1** immutable, verifiable receipt per decision.

**Hackathon (how we win):**
- Working end-to-end prototype demoed live (interception fires on a real click).
- Tavily and ElevenLabs each do *load-bearing* work visible in the demo.
- Clean, dramatic 3-minute video; repo + README that runs from clone.

---

## 8. Demo requirements (drives the whole build)
The demo is the product. Everything in §4.1 exists to make this sequence land:
1. Dashboard shows the pending $240k wire + the "urgent routing update" request.
2. Operator clicks **Release** → SentinelPay intercepts and freezes.
3. Terminal streams live Tavily/RDAP findings: `Domain age: 72h`, `Verified corporate line: (312) 555-0198`, `Risk: CRITICAL`.
4. The voice challenge runs (browser or live phone). The "vendor" denies the change.
5. Dashboard flips to a red **PAYMENT FROZEN · $240,000 SAVED** shield; the audit receipt appears.

Detailed choreography and script: **[DEMO_SCRIPT.md](./DEMO_SCRIPT.md)**.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Live voice call flakes on venue wifi | Default to browser WebRTC agent; cache the "denied" outcome; second-device fallback. |
| Tavily returns noise for the mock vendor | Seed the demo vendor so RDAP + a curated Tavily query return crisp results; cache responses. |
| Judges ask "did you really stop a wire?" | Be honest: control plane in front of the rail; the freeze is enforced via the disbursement webhook a bank/AP system would call. |
| Scope creep kills the demo | §4.1 is the only must-ship. Stretch items are strictly after a working end-to-end path. |
| Rho API access not available | Confirmed unavailable. Mock provider is primary; Column sandbox rail is the optional real-API integration. |

---

## 10. Alignment matrix (map to the prize rubric)

| Prize | Rubric | How SentinelPay hits it |
|---|---|---|
| Fintech / Money Track (Rho) | Real CFO/finance pain; modernizes commercial banking | Intercepts fraud at AP disbursement — Rho's highest-exposure surface; makes autonomous AP safe. |
| Best Use of Tavily | Autonomous web research driving agent decisions | Tavily resolves the *real* callback identity that flips the decision; not decoration. |
| Best ElevenLabs Project | Low-latency conversational AI, creative tool calls | Voice agent runs a live challenge–response and executes `freeze_payment` mid-call. |
| Grand Prize | Depth, working E2E, business model, engagement | Stops a $240k theft live; clear ROI; auditable; enterprise-ready UI. |
| Jalen Brunson (best solo) | Solo builder | Single-repo TS app; coding-agent sub-agents parallelize the slices. |

---

## Sources
- FBI IC3 2024 Internet Crime Report — BEC $2.77B / 21,442 incidents; $16.6B total (+33% YoY): https://www.ic3.gov
- Nacha summary (BEC ~$8.5B over 2022–2024): https://www.nacha.org/news/fbis-ic3-finds-almost-85-billion-lost-business-email-compromise-last-three-years
- AFP 2025 Payments Fraud & Control Survey (63% experienced BEC): https://www.afponline.org
- Column sandbox and testing: https://docs.column.com/guides/sandbox-and-testing
- Tavily docs: https://docs.tavily.com
- ElevenLabs Conversational AI: https://elevenlabs.io/docs/agents-platform
