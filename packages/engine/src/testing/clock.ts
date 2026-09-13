/** A clock that only moves when told to. Pass `now` as EngineConfig.clock. */
export function fixedClock(iso: string): { now: () => Date; advance(ms: number): void } {
  let t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`fixedClock: invalid ISO timestamp ${iso}`);
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
  };
}

/** Deterministic id source for EngineConfig.ids: chl_0001, chl_0002, ... */
export function seqIds(prefix = "chl"): () => string {
  let n = 0;
  return () => `${prefix}_${String(++n).padStart(4, "0")}`;
}
