import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEngine, humanApprovalChallenger, type PaymentInput, type Principal, type PayFirewall, type Vendor } from "payfirewall";
import { fixtureProbe } from "payfirewall/adapters/fixtures";
import { memoryStorage, memoryVendors } from "payfirewall/adapters/memory";
import { createHandler } from "payfirewall/http";
import { createMcpServer, type McpServerOptions } from "../src/server";

export const AGENT: Principal = { id: "agent:ap-bot", kind: "agent", roles: ["requester"] };
export const APPROVER: Principal = { id: "human:controller-desk", kind: "human", roles: ["operator"] };

export const MERIDIAN: Vendor = {
  id: "v_meridian", legalName: "Meridian Global Logistics LLC", knownDomain: "meridianglobal.com", knownBankLast4: "4471",
};

export function poisoned(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    id: "pay_240k", vendorId: "v_meridian", amountCents: 24_000_000, currency: "USD",
    beneficiary: { accountLast4: "9821" }, requestSourceDomain: "meridian-global.co",
    invoiceContactPhone: "+1-000-000-0000", memo: "URGENT: pay today, call the number above to confirm",
    ...overrides,
  };
}

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}.json`, import.meta.url)), "utf8"));

export const AGENT_API_KEY = "sk_agent_test";

/** The agent's API key as a bearer, or the approval page's session cookie (which the requester never holds). */
async function authenticate(req: Request): Promise<Principal | null> {
  if (req.headers.get("authorization") === `Bearer ${AGENT_API_KEY}`) return AGENT;
  return /(?:^|;\s*)session=approver(?:;|$)/.test(req.headers.get("cookie") ?? "") ? APPROVER : null;
}

export interface DeliveredLink { url: string; summary: string; challengeId: string; token: string }

/** Engine per §7.3, the MCP server over it with a linked in-memory client, and the host's HTTP handler. */
export async function connectedScenario(serverOpts: McpServerOptions = { principal: AGENT }) {
  const links: DeliveredLink[] = [];
  const storage = memoryStorage();
  const engine = createEngine({
    environment: "test",
    storage,
    vendors: memoryVendors([MERIDIAN]),
    probes: [fixtureProbe("rdap", fixture("rdap")), fixtureProbe("tavily", fixture("tavily"))],
    challengers: [humanApprovalChallenger({
      approvalBaseUrl: "https://payfirewall.test/approve",
      deliver: async (m) => {
        const url = new URL(m.url);
        links.push({ url: m.url, summary: m.summary, challengeId: decodeURIComponent(url.pathname.split("/").pop()!), token: url.hash.replace(/^#t=/, "") });
      },
    })],
    secrets: { tokenPepper: "pepper-for-mcp-tests-0123456789abcdef" },
    payer: { name: "Acme Treasury" },
    principal: AGENT,
  });
  const handler = createHandler(engine, { authenticate });
  const { client, close } = await connect(engine, serverOpts);
  return { engine, storage, links, handler, client, close };
}

export async function connect(api: PayFirewall, serverOpts: McpServerOptions = {}) {
  const server = createMcpServer(api, serverOpts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "headless-agent", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // A real host lists tools first, which is also what arms the SDK client's outputSchema validation.
  await client.listTools();
  return { client, server, close: () => client.close() };
}

/** POSTs a verdict to the host's result route, as the /approve page would. */
export async function postResult(
  handler: (req: Request) => Promise<Response>,
  link: DeliveredLink,
  body: unknown,
  auth: { token?: boolean; session?: boolean },
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.token) headers.authorization = `Bearer ${link.token}`;
  if (auth.session) headers.cookie = "session=approver";
  const res = await handler(new Request(`https://payfirewall.test/api/v1/challenges/${encodeURIComponent(link.challengeId)}/result`, {
    method: "POST", headers, body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}
