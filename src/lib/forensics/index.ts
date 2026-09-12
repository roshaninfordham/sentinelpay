import { one, run } from "../db";
import { paceMs, sleep } from "../env";
import { appendLedger } from "../ledger";
import { paymentSource, vendorDirectory } from "../providers";
import { emit } from "../timeline";
import type { ForensicSignal, RiskAssessment } from "../types";
import { assessRisk } from "./policy";
import { lookupDomain, type RdapResult } from "./rdap";
import { investigateEntity } from "./tavily";

const cachedTag = (origin: "live" | "cache", note?: string) => (origin === "cache" ? `  [cached${note ? `: ${note}` : ""}]` : "");

function describeAge(r: RdapResult): string {
  if (!r.found) return "no registry record";
  if (r.ageHours === null || r.ageDays === null) return "registered (date not published)";
  if (r.ageHours <= 96) return `registered ${r.ageHours} hours ago`;
  if (r.ageDays < 365) return `registered ${r.ageDays} days ago`;
  return `registered ${Math.floor(r.ageDays / 365)} years ago (${r.registeredAt!.slice(0, 10)})`;
}

const running = new Set<string>();

/**
 * Node 2 — runs RDAP + Tavily in parallel for a frozen payment, scores it, streams terminal lines,
 * and moves the payment to CHALLENGING so the voice node can place the call.
 */
export async function investigate(paymentId: string): Promise<RiskAssessment> {
  const source = paymentSource();
  const payment = await source.get(paymentId);
  const existing = await readAssessment(paymentId);
  if (existing && payment.status !== "PENDING_REVIEW") return existing;
  if (running.has(paymentId)) throw new Error(`investigation already running for ${paymentId}`);
  if (payment.status !== "PENDING_REVIEW") throw new Error(`payment ${paymentId} is ${payment.status}, not PENDING_REVIEW`);

  running.add(paymentId);
  try {
    const vendor = await vendorDirectory().get(payment.vendorId);
    const pace = paceMs();

    await source.setStatus(paymentId, "INVESTIGATING");
    await appendLedger("INVESTIGATION_STARTED", paymentId, { status: "INVESTIGATING" });
    await emit(paymentId, "info", `▶ Forensics  launching RDAP + Tavily probes in parallel`);

    const [reqRdap, knownRdap, entity] = await Promise.all([
      lookupDomain(payment.requestSourceDomain),
      lookupDomain(vendor.knownDomain).catch(() => null),
      investigateEntity(vendor, payment),
    ]);

    await sleep(pace);
    await emit(paymentId, "probe", `▶ RDAP    ${payment.requestSourceDomain} … ${describeAge(reqRdap)}${cachedTag(reqRdap.origin, reqRdap.note)}`);
    if (knownRdap) {
      await sleep(pace * 0.6);
      await emit(paymentId, "probe", `▶ RDAP    ${vendor.knownDomain} (vendor of record) … ${describeAge(knownRdap)}${cachedTag(knownRdap.origin, knownRdap.note)}`);
    }

    await sleep(pace);
    await emit(
      paymentId,
      "probe",
      entity.entityResolved
        ? `▶ Tavily  resolving real entity … ${vendor.legalName} confirmed via ${entity.entitySources.join(", ")}${cachedTag(entity.origin, entity.note)}`
        : `▶ Tavily  resolving real entity … no registry match for ${vendor.legalName}${cachedTag(entity.origin, entity.note)}`,
    );
    await sleep(pace * 0.6);
    await emit(
      paymentId,
      entity.requestDomainLinked ? "probe" : "warn",
      entity.requestDomainLinked
        ? `▶ Tavily  ${payment.requestSourceDomain} is linked to the registered entity`
        : `▶ Tavily  ${payment.requestSourceDomain} is NOT linked to ${vendor.legalName} in any registry source`,
    );

    await sleep(pace);
    const invoiceDiffers = entity.verifiedPhone && payment.invoiceContactPhone;
    await emit(
      paymentId,
      entity.verifiedPhone ? "probe" : "warn",
      entity.verifiedPhone
        ? `▶ Tavily  verified corporate line: ${entity.verifiedPhone}${invoiceDiffers ? `  (invoice number ${payment.invoiceContactPhone} ignored)` : ""}`
        : `▶ Tavily  could not resolve a registry phone number`,
    );

    const signals: ForensicSignal[] = [
      {
        key: "domain_age_days",
        value: reqRdap.found ? reqRdap.ageDays : null,
        source: "rdap",
        detail: `${payment.requestSourceDomain}: ${describeAge(reqRdap)}`,
      },
      {
        key: "entity_match",
        value: entity.requestDomainLinked,
        source: "tavily",
        detail: entity.requestDomainLinked
          ? `${payment.requestSourceDomain} belongs to ${vendor.legalName}`
          : `${payment.requestSourceDomain} not linked to ${vendor.legalName} (${entity.entitySources.join(", ") || "no sources"})`,
      },
      {
        key: "verified_phone",
        value: entity.verifiedPhone ?? false,
        source: "tavily",
        detail: entity.verifiedPhone ? `registry line ${entity.verifiedPhone}` : "no registry phone found",
      },
    ];
    if (entity.adverseMedia) {
      signals.push({ key: "adverse_media", value: entity.adverseMedia, source: "tavily", detail: entity.adverseMedia });
    }

    const assessment = assessRisk(signals, payment.invoiceContactPhone);
    if (assessment.verifiedCallbackPhone) {
      await run(`UPDATE vendors SET verifiedPhone = ? WHERE id = ?`, [assessment.verifiedCallbackPhone, vendor.id]);
    }
    await run(`INSERT OR REPLACE INTO assessments (paymentId, json) VALUES (?, ?)`, [paymentId, JSON.stringify(assessment)]);
    await appendLedger("FORENSICS", paymentId, assessment);

    await sleep(pace);
    await emit(paymentId, "risk", `● RISK: ${assessment.level} (score ${assessment.score})`);

    await sleep(pace);
    await source.setStatus(paymentId, "CHALLENGING");
    await appendLedger("CHALLENGE_STARTED", paymentId, { dial: assessment.verifiedCallbackPhone ?? null });
    await emit(
      paymentId,
      "call",
      assessment.verifiedCallbackPhone
        ? `☎ Challenge  out-of-band call to ${vendor.legalName} controller at ${assessment.verifiedCallbackPhone}`
        : `☎ Challenge  no verified number — escalate to manual review`,
    );
    return assessment;
  } catch (err) {
    await emit(paymentId, "alert", `✖ Forensics error: ${(err as Error).message} — payment remains held`);
    throw err;
  } finally {
    running.delete(paymentId);
  }
}

export async function readAssessment(paymentId: string): Promise<RiskAssessment | undefined> {
  const row = await one<{ json: string }>(`SELECT json FROM assessments WHERE paymentId = ?`, [paymentId]);
  return row ? (JSON.parse(row.json) as RiskAssessment) : undefined;
}
