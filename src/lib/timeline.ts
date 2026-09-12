import { all, run } from "./db";
import type { TimelineKind, TimelineLine } from "./types";

export async function emit(paymentId: string, kind: TimelineKind, text: string): Promise<void> {
  await run(`INSERT INTO timeline (paymentId, kind, text, ts) VALUES (?, ?, ?, ?)`, [paymentId, kind, text, new Date().toISOString()]);
}

export function readTimeline(): Promise<TimelineLine[]> {
  return all<TimelineLine>(`SELECT * FROM timeline ORDER BY id`);
}
