export interface RecordedCall { url: string; method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal | null }

/** A fetch stub that records every call and answers from `respond`. */
export function stubFetch(respond: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: RecordedCall = {
      url: String(input),
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal,
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
