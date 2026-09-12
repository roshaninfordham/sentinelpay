// Records real RDAP + Tavily responses into fixtures/ so DEMO_MODE=cache replays genuine captures.
// Usage: TAVILY_API_KEY=tvly-... pnpm capture   (reads .env.local if present)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { queriesFor } from "../src/lib/forensics/tavily";
import { seedPayments, VENDORS } from "../src/lib/seed-data";

const root = path.join(__dirname, "..");
if (existsSync(path.join(root, ".env.local"))) {
  for (const line of readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  const rdapPath = path.join(root, "fixtures/rdap.json");
  const rdap = JSON.parse(readFileSync(rdapPath, "utf8"));
  const domains = new Set([...VENDORS.map((v) => v.knownDomain), ...seedPayments().map((p) => p.requestSourceDomain)]);

  for (const d of domains) {
    const res = await fetch(`https://rdap.org/domain/${d}`, { headers: { "user-agent": "SentinelPay/0.1 fixture-capture" } });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.events) {
      rdap.domains[d] = { events: body.events };
      rdap._provenance[d] = `Real capture from https://rdap.org/domain/${d} on ${new Date().toISOString().slice(0, 10)}.`;
      console.log(`rdap  ${d}: captured`);
    } else {
      console.log(`rdap  ${d}: ${res.status} ${body.title ?? ""} (kept existing fixture)`);
    }
  }
  writeFileSync(rdapPath, JSON.stringify(rdap, null, 2) + "\n");

  const key = process.env.TAVILY_API_KEY;
  if (!key) return console.log("tavily: TAVILY_API_KEY not set, skipped");

  const tavPath = path.join(root, "fixtures/tavily.json");
  const tav = JSON.parse(readFileSync(tavPath, "utf8"));
  for (const payment of seedPayments()) {
    const vendor = VENDORS.find((v) => v.id === payment.vendorId)!;
    const q = queriesFor(vendor, payment);
    const run = async (body: Record<string, unknown>) => {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ search_depth: "advanced", max_results: 5, ...body }),
      });
      if (!res.ok) throw new Error(`tavily ${res.status}`);
      const j = await res.json();
      return { query: j.query, results: j.results.map(({ title, url, content, score }: Record<string, unknown>) => ({ title, url, content, score })) };
    };
    const [entity, domain] = await Promise.all([run(q.entity), run(q.domain)]);
    console.log(`tavily ${vendor.id}: ${entity.results.length} entity / ${domain.results.length} domain results`);
    if (process.argv.includes("--write-tavily")) {
      tav.vendors[vendor.id] = { entity, domain };
      tav._provenance = `Real Tavily capture on ${new Date().toISOString().slice(0, 10)}.`;
    }
  }
  if (process.argv.includes("--write-tavily")) writeFileSync(tavPath, JSON.stringify(tav, null, 2) + "\n");
  else console.log("tavily: dry run. Re-run with --write-tavily to overwrite fixtures/tavily.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
