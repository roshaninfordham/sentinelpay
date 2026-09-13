import type { Metadata } from "next";
import Link from "next/link";

// Static on purpose: no database, auth or env reads, so this page prerenders and ships no page JavaScript.

export const metadata: Metadata = {
  title: "Connect an agent · SentinelPay",
  description: "Give a payment agent three tools that verify a vendor’s bank change out of band before any money moves.",
};

const API_BASE = "https://sentinelpay-sigma.vercel.app/api/v1";

const MCP_CONFIG = `{
  "mcpServers": {
    "payfirewall": {
      "command": "npx",
      "args": ["-y", "payfirewall-mcp"],
      "env": {
        "PAYFIREWALL_URL": "${API_BASE}",
        "PAYFIREWALL_API_KEY": "<your requester API key>"
      }
    }
  }
}`;

const CLAUDE_CODE = `claude mcp add payfirewall \\
  -e PAYFIREWALL_URL=${API_BASE} \\
  -e PAYFIREWALL_API_KEY=<your requester API key> \\
  -- npx -y payfirewall-mcp`;

const LOOP = `import Anthropic from "@anthropic-ai/sdk";
import { createHttpClient } from "payfirewall/client";
import { callTool, toAnthropicTools } from "payfirewall/tools";

const firewall = createHttpClient({ baseUrl: "${API_BASE}", apiKey: process.env.PAYFIREWALL_API_KEY! });
const anthropic = new Anthropic();
const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Pay Meridian invoice INV-2291: $240,000 to account ending 9821." }];

for (;;) {
  const res = await anthropic.messages.create({ model: "claude-opus-5", max_tokens: 4096, tools: toAnthropicTools() as Anthropic.Tool[], messages });
  messages.push({ role: "assistant", content: res.content });
  if (res.stop_reason !== "tool_use") break;
  const results = await Promise.all(res.content.filter((b) => b.type === "tool_use").map(async (b) => {
    const result = await callTool(firewall, b.name, b.input);
    return { type: "tool_result" as const, tool_use_id: b.id, content: JSON.stringify(result), is_error: !result.ok };
  }));
  messages.push({ role: "user", content: results });
}`;

const TOOLS = [
  {
    name: "verify_payment",
    does: "Submits a vendor payment before it is sent. Idempotent on the payment id, so a retry never pays twice.",
  },
  {
    name: "get_verification",
    does: "Long-polls a payment the agent submitted while it is investigated and confirmed with the vendor.",
  },
  {
    name: "block_payment",
    does: "Stops a payment the agent believes is fraudulent. It can only move a payment toward not paying.",
  },
];

const DECISIONS = [
  { decision: "PAY", tone: "text-cleared", meaning: "Verified with the vendor. Pay exactly this payment, unless the answer says the rail already released it." },
  { decision: "WAIT", tone: "text-brass", meaning: "Held while the change is investigated or the vendor is being called. Do not pay yet; keep polling." },
  { decision: "DO_NOT_PAY", tone: "text-signal", meaning: "Frozen. The vendor denied the change, the confirmation expired, or someone blocked it. Stop." },
];

const NEXT_ACTIONS = [
  ["POLL", "Call get_verification with the arguments given, after afterMs."],
  ["AWAIT_OUT_OF_BAND", "A person is confirming on another channel. Keep polling."],
  ["PAY", "Pay exactly this payment, or nothing when the rail already released it."],
  ["DO_NOT_PAY", "Stop. When terminal is true, this payment id is finished."],
  ["ESCALATE_TO_HUMAN", "Stop and show the message to a person."],
  ["RETRY", "Storage or the rail was unavailable. Submit the same payment again after afterMs."],
] as const;

const GUARDRAILS = [
  ["No approve tool.", "An agent can submit, poll and block. Only the vendor, reached on a number from public registries, can authorize a bank change."],
  ["The invoice number is never dialed.", "Phone numbers, domains and memos from the request arrive in an untrusted block the model must not act on."],
  ["Tokens stay out of reach.", "No tool returns or accepts a responder token, so an agent cannot be talked into approving its own payment."],
  ["Failure means held.", "An error, timeout or unreachable service never answers PAY, and the error’s nextActions never say PAY."],
  ["Every step is on the record.", "Each decision is written to a SHA-256 hash chain with a receipt you can fetch and verify."],
] as const;

export default function AgentsPage() {
  return (
    <div className="mx-auto max-w-[46rem] px-4 pb-16 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-4">
        <Link href="/" className="flex items-center gap-3 rounded-sm">
          <svg width="20" height="24" viewBox="0 0 22 26" aria-hidden className="text-brass">
            <path d="M11 1 21 4.5v7.8c0 6-4.2 10.7-10 12.7C5.2 23 1 18.3 1 12.3V4.5L11 1Z" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M6.5 13 9.8 16.2 15.8 9.6" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span className="font-display text-xl font-semibold tracking-tight">SentinelPay</span>
        </Link>
        <Link href="/" className="text-sm text-muted underline underline-offset-4 hover:text-paper">
          Operator console
        </Link>
      </header>

      <main>
        <section className="pt-10 pb-2 md:pt-14">
          <h1 className="font-display text-[clamp(2rem,5.5vw,3rem)] font-semibold leading-[1.05] tracking-tight">Connect a payment agent</h1>
          <p className="mt-4 max-w-[38rem] text-lg leading-relaxed text-paper/90">
            Before your agent pays a vendor, SentinelPay checks the bank details against the vendor master, calls the vendor on a number it
            finds itself, and answers with one decision your agent must follow.
          </p>
        </section>

        <Step n={1} title="Add the MCP server">
          <p>
            Claude Desktop, Cursor and most MCP clients read this block. Ask the SentinelPay operator for an API key with the requester role;
            the key decides who the agent is.
          </p>
          <Code label="MCP client configuration (JSON)">{MCP_CONFIG}</Code>
          <p className="text-sm text-muted">In Claude Code:</p>
          <Code label="Claude Code command">{CLAUDE_CODE}</Code>
        </Step>

        <Step n={2} title="Your agent gets three tools">
          <dl className="divide-y divide-rule border-y border-rule">
            {TOOLS.map((t) => (
              <div key={t.name} className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[11rem_1fr]">
                <dt className="font-mono text-sm text-paper">{t.name}</dt>
                <dd className="text-[15px] leading-relaxed text-paper/85">{t.does}</dd>
              </div>
            ))}
          </dl>
          <p>
            Not using MCP? The same tools run in any tool-calling loop. This one uses Claude; <code className="font-mono text-sm">toOpenAITools</code>{" "}
            and <code className="font-mono text-sm">toAiSdkTools</code> work the same way.
          </p>
          <Code label="Tool-calling loop (TypeScript)">{LOOP}</Code>
        </Step>

        <Step n={3} title="Follow the decision">
          <p>
            Every tool answers with a verification. Read <code className="font-mono text-sm">decision</code>, then do{" "}
            <code className="font-mono text-sm">nextActions[0]</code>. Only <span className="font-mono text-sm text-cleared">PAY</span> moves money.
          </p>
          <div className="overflow-hidden rounded-md border border-rule bg-panel">
            {DECISIONS.map((d) => (
              <div key={d.decision} className="grid gap-x-6 gap-y-1 border-t border-rule px-4 py-3 first:border-t-0 sm:grid-cols-[9rem_1fr]">
                <p className={`font-mono text-[15px] font-semibold ${d.tone}`}>{d.decision}</p>
                <p className="text-[15px] leading-relaxed">{d.meaning}</p>
              </div>
            ))}
          </div>

          <div>
            <p id="next-actions" className="text-[15px] text-paper">
              What <code className="font-mono text-sm">nextActions[0].type</code> tells the agent to do
            </p>
            <dl aria-labelledby="next-actions" className="mt-2 divide-y divide-rule border-y border-rule text-sm">
              {NEXT_ACTIONS.map(([type, what]) => (
                <div key={type} className="grid gap-x-6 gap-y-0.5 py-2 sm:grid-cols-[11rem_1fr]">
                  <dt className="font-mono text-paper">{type}</dt>
                  <dd className="text-paper/85">{what}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="text-sm text-muted">
            Each answer also carries <code className="font-mono">reason</code> (one machine-readable code, such as{" "}
            <code className="font-mono">VENDOR_DENIED_CHANGE</code>) and <code className="font-mono">mustNot</code>, the things the agent must
            never do for this payment.
          </p>
        </Step>

        <section aria-labelledby="guardrails" className="mt-14">
          <h2 id="guardrails" className="font-display text-2xl font-semibold">
            What an agent cannot do
          </h2>
          <ul className="mt-4 flex flex-col gap-3">
            {GUARDRAILS.map(([head, body]) => (
              <li key={head} className="border-l-2 border-brass/70 pl-4 text-[15px] leading-relaxed">
                <span className="font-medium text-paper">{head}</span> <span className="text-paper/85">{body}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="reference" className="mt-14 border-t border-rule pt-6">
          <h2 id="reference" className="font-display text-2xl font-semibold">
            Reference
          </h2>
          <ul className="mt-3 grid gap-x-8 gap-y-2 text-[15px] sm:grid-cols-2">
            <RefLink href="/api/v1/openapi.json" label="OpenAPI 3.1 document" note="/api/v1/openapi.json" />
            <RefLink href="/api/v1/tools" label="Tool definitions" note="/api/v1/tools" />
            <RefLink href="https://www.npmjs.com/package/payfirewall-mcp" label="payfirewall-mcp on npm" note="The MCP server" />
            <RefLink href="https://www.npmjs.com/package/payfirewall" label="payfirewall on npm" note="The engine, tools and HTTP client" />
          </ul>
        </section>
      </main>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="mt-12">
      <h2 id={`step-${n}`} className="flex items-baseline gap-3 font-display text-2xl font-semibold">
        <span className="font-display text-base font-semibold text-brass" aria-hidden>
          {n}
        </span>
        <span>
          <span className="sr-only">Step {n}: </span>
          {title}
        </span>
      </h2>
      <div className="mt-3 flex flex-col gap-4 text-[15px] leading-relaxed text-paper/90">{children}</div>
    </section>
  );
}

function Code({ label, children }: { label: string; children: string }) {
  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{label}</figcaption>
      <pre
        tabIndex={0}
        className="scroll-thin overflow-x-auto rounded-md border border-rule bg-[#08121a] px-4 py-3 font-mono text-[12.5px] leading-6 text-paper"
      >
        <code>{children}</code>
      </pre>
    </figure>
  );
}

function RefLink({ href, label, note }: { href: string; label: string; note: string }) {
  const external = href.startsWith("http");
  return (
    <li className="flex flex-col py-1">
      <a href={href} className="text-paper underline underline-offset-4 hover:text-white" {...(external ? { rel: "noreferrer" } : {})}>
        {label}
      </a>
      <span className="text-sm text-muted">{note}</span>
    </li>
  );
}
