import { getDb } from "./db";
import type { TimelineKind, TimelineLine } from "./types";

export function emit(paymentId: string, kind: TimelineKind, text: string): void {
  getDb()
    .prepare(`INSERT INTO timeline (paymentId, kind, text, ts) VALUES (?, ?, ?, ?)`)
    .run(paymentId, kind, text, new Date().toISOString());
}

export function readTimeline(): TimelineLine[] {
  return getDb().prepare(`SELECT * FROM timeline ORDER BY id`).all() as TimelineLine[];
}
