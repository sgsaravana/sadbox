// Sampled resource usage for the detail view's 15m / 1h / 12h graphs. The
// supervisor samples running VMs every 30 s; a detail page's faster poll adds
// finer points too. Samples are pruned to a little over 12 hours.
import { db } from "../db";

export interface ResourceSample {
  ts: number;
  cpu: number | null;
  memUsed: number | null;
  memLimit: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  netRx: number | null;
  netTx: number | null;
}

export const RESOURCE_RANGE_MS: Record<string, number> = {
  "3m": 3 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "12h": 12 * 60 * 60_000,
};

const MAX_POINTS = 360;
const KEEP_MS = 13 * 60 * 60_000;
const lastRecorded = new Map<string, number>();
let lastPrune = 0;

function prune(now: number): void {
  if (now - lastPrune < 60 * 60_000) return;
  lastPrune = now;
  try { db.query("DELETE FROM resource_samples WHERE ts < ?").run(now - KEEP_MS); } catch {}
}

/** Record a sample unless one was taken a moment ago (the live poll runs much
 *  faster than the 30 s supervisor sampler). */
export function recordResourceSample(projectId: string, s: ResourceSample, minGapMs = 5_000): void {
  const last = lastRecorded.get(projectId) ?? 0;
  if (s.ts - last < minGapMs) return;
  lastRecorded.set(projectId, s.ts);
  try {
    db.query(
      `INSERT OR REPLACE INTO resource_samples
         (project_id, ts, cpu_percent, memory_used, memory_limit, disk_used, disk_total, net_rx, net_tx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, s.ts, s.cpu, s.memUsed, s.memLimit, s.diskUsed, s.diskTotal, s.netRx, s.netTx);
    prune(s.ts);
  } catch {}
}

/** Samples in the range, downsampled to a few hundred points for drawing. */
export function resourceSamples(projectId: string, rangeMs: number, maxPoints = MAX_POINTS): ResourceSample[] {
  const since = Date.now() - rangeMs;
  const rows = db.query<ResourceSample, [string, number]>(
    `SELECT ts, cpu_percent AS cpu, memory_used AS memUsed, memory_limit AS memLimit,
            disk_used AS diskUsed, disk_total AS diskTotal, net_rx AS netRx, net_tx AS netTx
       FROM resource_samples WHERE project_id = ? AND ts >= ? ORDER BY ts`,
  ).all(projectId, since);
  if (rows.length <= maxPoints) return rows;
  const bucket = rangeMs / maxPoints;
  const out: ResourceSample[] = [];
  let at = -1;
  for (const row of rows) {
    const b = Math.floor((row.ts - since) / bucket);
    if (b !== at) { out.push(row); at = b; }
    else out[out.length - 1] = row; // keep the last point in each bucket
  }
  return out;
}
