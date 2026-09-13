import type { EngineConfig } from "@sentinelpay/engine";
import { memoryStorage, memoryVendors } from "@sentinelpay/engine/adapters/memory";
import { pendingChallenger } from "@sentinelpay/engine/testing";

// Embedded-mode config for the stdio smoke test: in-memory, no probes, a challenger that never resolves.
const config: EngineConfig = {
  environment: "test",
  storage: memoryStorage(),
  vendors: memoryVendors([
    { id: "v_meridian", legalName: "Meridian Global Logistics LLC", knownDomain: "meridianglobal.com", knownBankLast4: "4471", verifiedPhone: "(312) 555-0198" },
  ]),
  challengers: [pendingChallenger()],
  allowTestChallengers: true,
  secrets: { tokenPepper: "pepper-for-mcp-stdio-0123456789abcdef" },
  payer: { name: "Acme Treasury" },
  principal: { id: "agent:stdio-smoke", kind: "agent", roles: ["requester"] },
};

export default config;
