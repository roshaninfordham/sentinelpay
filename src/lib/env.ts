import type { DemoMode } from "./types";

export function demoMode(): DemoMode {
  return process.env.DEMO_MODE === "cache" ? "cache" : "live";
}

/** Milliseconds between terminal beats so the investigation is watchable. 0 in tests. */
export function paceMs(): number {
  const v = Number(process.env.DEMO_PACE_MS);
  return Number.isFinite(v) && process.env.DEMO_PACE_MS !== undefined ? v : 900;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
