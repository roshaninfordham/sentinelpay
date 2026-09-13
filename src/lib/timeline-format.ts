import type { CaseRecord, EngineEvent, ForensicSignal, Mismatch } from "payfirewall";
import type { TimelineKind } from "./types";

// EngineEvent -> investigation-terminal lines. Pure: the app's onEvent sink supplies the case context and does the
// writing and pacing. Line text is the dashboard's pre-engine wording, so the demo reads the same.

export interface TimelineBeat {
  kind: TimelineKind;
  text: string;
  /** Multiple of DEMO_PACE_MS to wait before writing this line. */
  pace: number;
}

export interface FormatContext {
  /** The case as committed when the event fired; null only if it cannot be read. */
  case: CaseRecord | null;
  /** Display names of the configured probes, e.g. ["RDAP", "Tavily"]. */
  probeLabels: string[];
  /** Principal the dashboard submits as; other requesters get a "via" tag. */
  appPrincipalId: string;
  /** Rail display name when a rail is configured, e.g. "Column sandbox". */
  railLabel?: string;
  /** Line shown when a payment is frozen on a configured rail. */
  railFrozenNote?: string;
}

export const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function describeMismatch(m: Mismatch): string {
  return m.code === "BENEFICIARY_CHANGED"
    ? `Beneficiary changed: ••${m.onFile} → ••${m.claimed}`
    : `Request domain ${m.claimed} ≠ vendor of record ${m.onFile}`;
}

/** "(312) •••-0198": enough to recognise the pinned number without printing it in full. */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) •••-${d.slice(6)}`;
  return d.length >= 4 ? `•••-${d.slice(-4)}` : "•••";
}

export const callbackPhoneOf = (c: CaseRecord): string | null => c.vendorSnapshot.verifiedPhone ?? c.risk?.verifiedCallbackPhone ?? null;

const LEVEL_WORD = { LOW: "Low", ELEVATED: "Elevated", CRITICAL: "Critical" } as const;

const beat = (kind: TimelineKind, text: string, pace = 0): TimelineBeat => ({ kind, text, pace });

const cachedTag = (origin: string, note?: string) => (origin === "fixture" ? `  [cached${note ? `: ${note}` : ""}]` : "");

const find = (signals: ForensicSignal[], key: ForensicSignal["key"]) => signals.find((s) => s.key === key);

function probeBeats(e: Extract<EngineEvent, { type: "probe" }>, c: CaseRecord): TimelineBeat[] {
  const domain = c.payment.requestSourceDomain;
  const legalName = c.vendorSnapshot.legalName;
  if (e.origin === "error") {
    return [beat("warn", `✖ ${e.probe} probe failed (${e.note ?? "no detail"}) — missing evidence scored as adverse`, 1)];
  }
  const tag = cachedTag(e.origin, e.note);
  const out: TimelineBeat[] = [];

  const age = find(e.signals, "domain_age_days");
  if (age?.detail) {
    // The probe's detail is "<domain>: <description>", e.g. "meridian-global.co: registered 72 hours ago".
    const description = age.detail.slice(age.detail.indexOf(": ") + 2);
    out.push(beat("probe", `▶ RDAP    ${domain} … ${description}${tag}`, 1));
  }

  const entity = find(e.signals, "entity_match");
  if (entity) {
    const linked = entity.value === true;
    const sources = /\(([^)]*)\)$/.exec(entity.detail ?? "")?.[1];
    const resolved = linked || (sources !== undefined && sources !== "no sources");
    out.push(beat("probe", resolved
      ? `▶ Tavily  resolving real entity … ${legalName} confirmed${sources && sources !== "no sources" ? ` via ${sources}` : ""}${tag}`
      : `▶ Tavily  resolving real entity … no registry match for ${legalName}${tag}`, 1));
    out.push(linked
      ? beat("probe", `▶ Tavily  ${domain} is linked to the registered entity`, 0.6)
      : beat("warn", `▶ Tavily  ${domain} is not linked to ${legalName} in any registry source`, 0.6));
  }

  const phone = find(e.signals, "verified_phone");
  if (phone) {
    const invoice = c.payment.invoiceContactPhone;
    out.push(typeof phone.value === "string"
      ? beat("probe", `▶ Tavily  verified corporate line: ${phone.value}${invoice ? `  (invoice number ${invoice} ignored)` : ""}`, 1)
      : beat("warn", `▶ Tavily  could not resolve a registry phone number`, 1));
  }

  const adverse = find(e.signals, "adverse_media");
  if (adverse) out.push(beat("warn", `▶ Tavily  adverse media: ${String(adverse.value)}`, 0.6));
  return out;
}

function challengeOpened(c: CaseRecord, channel: string): TimelineBeat {
  const legalName = c.vendorSnapshot.legalName;
  const phone = callbackPhoneOf(c) ?? "no verified number";
  if (channel === "human_approval") {
    return beat("call", `☎ Challenge  confirmation link sent to an approver, who calls the ${legalName} controller at ${phone}`, 1);
  }
  // voice_browser runs in the operator's browser (operator_session assurance), so it is never called out of band here.
  if (channel === "voice_browser") return beat("call", `☎ Challenge  browser voice call to the ${legalName} controller at ${phone}`, 1);
  return beat("call", `☎ Challenge  ${channel} confirmation opened with the ${legalName} controller at ${phone}`, 1);
}

function frozenBeats(c: CaseRecord, ctx: FormatContext): TimelineBeat[] {
  const amount = usd(c.payment.amountCents);
  const out: TimelineBeat[] = [];
  switch (c.reason) {
    case "VENDOR_DENIED_CHANGE":
      out.push(beat("alert", `■ Vendor controller denied the change — ${amount} frozen`));
      break;
    case "CHALLENGE_EXPIRED":
      out.push(beat("alert", `■ Confirmation expired without an answer — failing closed, ${amount} frozen`));
      break;
    case "NO_CHALLENGE_CHANNEL":
      out.push(beat("call", `☎ Challenge  no verified number — escalate to manual review`, 1));
      out.push(beat("alert", `■ No independent channel to confirm the change — ${amount} frozen`));
      break;
    case "BLOCKED_BY_PRINCIPAL":
      out.push(beat("alert", `■ Payment frozen by ${c.challenge?.resolvedBy ?? "request"} — ${amount} held`));
      break;
    case "BENEFICIARY_PREVIOUSLY_DENIED":
      out.push(beat("alert", `■ Beneficiary ••${c.payment.beneficiary.accountLast4} was previously denied for ${c.vendorSnapshot.legalName} — ${amount} frozen`));
      break;
    default:
      out.push(beat("alert", `■ Confirmation inconclusive — failing closed, ${amount} frozen`));
  }
  if (ctx.railFrozenNote) out.push(beat("ok", `■ ${ctx.railFrozenNote}`));
  return out;
}

export function formatEvent(e: EngineEvent, ctx: FormatContext): TimelineBeat[] {
  const c = ctx.case;
  if (!c) return [];
  const amount = usd(c.payment.amountCents);

  switch (e.type) {
    case "gate": {
      const via = c.requestedBy === ctx.appPrincipalId ? "" : ` (via ${c.requestedBy})`;
      const out = [beat("info", `→ Release requested: ${amount} to ${c.vendorSnapshot.legalName}${via}`)];
      if (e.mismatches.length === 0) {
        out.push(beat("ok", `✔ Beneficiary matches vendor master (••${c.vendorSnapshot.knownBankLast4}) — released`));
        return out;
      }
      out.push(beat("alert", `⚠ ${describeMismatch(e.mismatches[0])} — release held`));
      for (const m of e.mismatches.slice(1)) out.push(beat("warn", `⚠ ${describeMismatch(m)}`));
      return out;
    }
    case "probe":
      return probeBeats(e, c);
    case "risk":
      return [beat("risk", `● ${LEVEL_WORD[e.risk.level]} risk, score ${e.risk.score}`, 1)];
    case "challenge":
      return e.status === "OPEN" ? [challengeOpened(c, e.channel)] : [];
    case "rail": {
      const label = ctx.railLabel ?? "Rail";
      return e.status === "RELEASED"
        ? [beat("ok", `✔ ${label} wire ${e.reference} created for ${amount}`)]
        : [beat("alert", `✖ ${label} release failed: ${e.error ?? "unknown error"}`)];
    }
    case "state":
      if (e.to === "INVESTIGATING") {
        return ctx.probeLabels.length
          ? [beat("info", `▶ Forensics  launching ${ctx.probeLabels.join(" + ")} probes in parallel`)]
          : [beat("warn", `▶ Forensics  no probes configured — missing evidence scored as adverse`)];
      }
      if (e.to === "QUARANTINED") return frozenBeats(c, ctx);
      if (e.to === "CLEARED" && e.from === "CHALLENGING") return [beat("ok", `✔ Vendor controller authorized the change — ${amount} released`)];
      return [];
  }
}
