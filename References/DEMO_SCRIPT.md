# SentinelPay — Demo Script & Judge Prep

Total: **under 3 minutes.** No intro slides. Open on the live dashboard. The demo *is* the pitch.

---

## The 2:30 run

### 0:00–0:20 — The setup (dashboard already open)
**On screen:** treasury dashboard, a **pending $240,000 wire to Meridian Global**, and an "urgent routing update" request next to it.
**You say:**
> "Every year, US companies lose billions to business email compromise — $2.77 billion last year alone by the FBI's own numbers. An attacker gets into a vendor's email, quietly changes a routing number on a real invoice, and accounts payable wires the money. Once it hits the rail, it's gone. Watch SentinelPay stop it."

Click **Release payment.**

### 0:20–0:50 — The interception + live forensics
**On screen:** the wire snaps to `PENDING_REVIEW`; the **investigation terminal** streams:
```
⚠ Beneficiary changed: ••4471 → ••9821 — releasing HELD
▶ RDAP  meridian-global.co … registered 72 hours ago
▶ Tavily  resolving real entity … Meridian Global Logistics, 20-yr registry footprint
▶ Tavily  verified corporate line: (312) 555-0198  (invoice number differs)
● RISK: CRITICAL (score 90)
```
**You say:**
> "SentinelPay froze the payment the instant the bank details changed. It doesn't trust the PDF. It runs Tavily and a domain check live: the *request* came from a domain registered 72 hours ago — but the real Meridian has existed for twenty years. So it ignores the number on the invoice and pulls the *real* controller's line from public registries."

### 0:50–1:40 — The out-of-band call (the star)
**On screen:** Call Console lights up; waveform moves.
**Browser mode:** the agent speaks through your laptop; you answer on a second device.
**Phone mode (stretch):** your phone rings on the podium; you put it on speaker.

**Agent (ElevenLabs):**
> "Hello, this is the SentinelPay settlement desk calling on behalf of Acme Corp. We have a pending $240,000 wire to Meridian Global, and we received a request to change your bank routing to an account ending 9821. Did your treasury team authorize this change?"

**You (as the real vendor):**
> "No — we did not. Our account hasn't changed. That's fraudulent."

**Agent:**
> "Understood. I'm freezing the wire now and generating a forensic report."

*(The agent invokes `freeze_payment` mid-call.)*

### 1:40–2:10 — The resolution
**On screen:** dashboard flips to a red shield — **PAYMENT FROZEN · $240,000 SAVED** — and an **audit receipt** appears (hash-chained entry + timestamp).
**You say:**
> "Forty-five seconds. Zero human hours. The real vendor was reached out-of-band on a number the attacker couldn't fake, the wire was stopped before settlement, and every step is written to a tamper-evident audit trail the CFO can sign."

### 2:10–2:30 — The close
> "SentinelPay is a verification control plane that sits in front of the payment rail — exactly where Rho moves money. It's the layer that makes autonomous AP safe. Tavily is the investigator, ElevenLabs is the out-of-band challenge, and the decision is deterministic and auditable. That's how you stop a $2.77-billion-a-year problem, one payment at a time."

---

## Delivery notes
- Have the dashboard **pre-loaded and pre-seeded** before you walk up. Never seed live.
- Run `DEMO_MODE=cache` unless venue wifi is proven solid in the room. Cached fixtures are *real captures*, so it's honest.
- Keep the second device unlocked with the agent URL open, volume up.
- If the call misbehaves, narrate over the cached outcome — the interception + shield still land.
- Time it. 2:30 leaves margin under the 3:00 cap for the video.

---

## Judge Q&A — have crisp answers ready

**"Did you actually stop a real wire?"**
> It's a control plane in front of the rail. The freeze is enforced through the same disbursement webhook a bank or AP system would honor before release. On the Column sandbox rail, a cleared payment creates a sandbox wire and a frozen one never calls the wire API; in production that hook is where a bank returns HOLD.

**"Isn't the domain-age check trivial to evade?"**
> It's one signal, not the verdict. The decision is a scored policy — domain age, entity match, invoice-vs-registry phone mismatch, sanctions. The *decisive* step is the out-of-band human confirmation on an independently-sourced number. That's the control the FBI itself recommends; we just made it automatic on every payment instead of a skipped manual step.

**"Why voice instead of email/SMS confirmation?"**
> Because the compromise is *in* the email channel. Verification has to leave the channel the attacker controls. A live voice challenge on a registry-sourced number does exactly that.

**"What's the business model / who pays?"**
> Priced per verified payment or as a percent of protected volume — trivial next to a single six-figure loss (average BEC hit is well into six figures). It's a safety layer AP platforms and banks attach to disbursement.

**"How is this different from existing fraud tooling?"**
> Most tools *score* and alert, leaving a human to make the call — which gets skipped under load. SentinelPay *closes the loop*: it does the out-of-band verification itself, autonomously, and produces the audit artifact.

**"What did you build vs. mock?"**
> Real: the interception gate, RDAP domain forensics, Tavily entity resolution, the deterministic risk policy, the hash-chained audit ledger, and the live ElevenLabs voice challenge with tool calls. Mocked for the demo: the AP disbursement feed (the rail can run on the Column bank sandbox, where a verified release creates a real sandbox wire) and, in browser mode, the telephony transport.

---

## Track-specific one-liners (drop the right one for each judge)
- **Rho / Money:** "This lives exactly where Rho moves money — the AP disbursement — and makes autonomous AP safe."
- **Tavily:** "Tavily resolves the real callback identity that flips the decision. Without live web retrieval, there is no verification."
- **ElevenLabs:** "The agent isn't reading a report — it's running a challenge–response interrogation and pulling the trigger on `freeze_payment` mid-call."
- **Solo builder:** "One repo, one weekend, built solo with a coding agent orchestrating sub-agents across the slices."

---

## Submission (Sunday, deadline 12:00pm)
- [ ] Repo public+licensed, or private + shared with `lockinhack@rho.co`
- [ ] README runs from clone; `pnpm seed && pnpm dev`
- [ ] < 3-min video, audio walks the stack
- [ ] LinkedIn/X post (Rho template)
- [ ] Project description written
