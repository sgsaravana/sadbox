// The proxy's request log. Every request is published live (the detail view's
// SSE stream) and kept in a per-project ring of the most recent ones, and is
// written to the database in batches (net_requests) where it stays for
// config.netLogDays. After a restart the ring refills from the database, and
// longer ranges (by host over a day or a week, older requests) are queried there.
import { config } from "../config";
import { db } from "../db";

export type NetEvent =
  | { type: "request"; entry: RequestEntry }
  | { type: "pending"; pending: PendingView }
  | { type: "pending-resolved"; id: string; action: string; reason?: string }
  | { type: "cutoff"; on: boolean };

export interface RequestEntry {
  id: string;
  ts: number;
  method: string;
  scheme: string;
  host: string;
  path: string;
  status: number | null;
  decision: "allowed" | "blocked";
  ruleId?: string | null;
  reqBytes: number;
  respBytes: number;
  durationMs: number;
  error?: string;
  credentials?: string[];     // proxy secrets swapped into this request (names, never values)
  redacted?: string[];        // proxy secrets whose real value was scrubbed from the response headers
  credentialInUrl?: string[]; // placeholders seen in the URL (never swapped)
}

export interface PendingView {
  id: string; projectId: string; host: string; method: string; scheme: string; path: string; ts: number;
  expiresAt: number; // when the held request is denied if nobody answers
  credential?: { name: string }; // set when the question is "send this secret to this host?"
}

type Listener = (ev: NetEvent) => void;
const listeners = new Map<string, Set<Listener>>();
const ring = new Map<string, RequestEntry[]>();
const CAP = 500;

export function subscribe(projectId: string, fn: Listener): () => void {
  let set = listeners.get(projectId);
  if (!set) { set = new Set(); listeners.set(projectId, set); }
  set.add(fn);
  return () => { set!.delete(fn); if (set!.size === 0) listeners.delete(projectId); };
}

export function publish(projectId: string, ev: NetEvent): void {
  const set = listeners.get(projectId);
  if (!set) return;
  for (const fn of set) { try { fn(ev); } catch {} }
}

export function recordRequest(projectId: string, entry: RequestEntry): void {
  let arr = ring.get(projectId);
  if (!arr) { arr = []; ring.set(projectId, arr); }
  arr.push(entry);
  if (arr.length > CAP) arr.splice(0, arr.length - CAP);
  queue.push([projectId, entry]);
  if (!flushTimer) flushTimer = setTimeout(flushRequests, FLUSH_MS);
  publish(projectId, { type: "request", entry });
}

/** The most recent requests (up to CAP), oldest first. The first call for a
 *  project after a restart (or a rebuild) fills the ring from the database. */
export function recentRequests(projectId: string): RequestEntry[] {
  if (!loaded.has(projectId)) {
    loaded.add(projectId);
    flushRequests(); // so nothing recorded so far is missed or doubled
    const have = ring.get(projectId) ?? [];
    const ids = new Set(have.map((e) => e.id));
    const older = requestsBefore(projectId, Number.MAX_SAFE_INTEGER, CAP).filter((e) => !ids.has(e.id));
    const merged = [...older, ...have].sort((a, b) => a.ts - b.ts).slice(-CAP);
    ring.set(projectId, merged);
  }
  return ring.get(projectId) ?? [];
}

export function clearProjectFeed(projectId: string): void {
  ring.delete(projectId);
  loaded.delete(projectId); // the database keeps the history; the ring refills from it
  listeners.delete(projectId);
}

// ---- persistence ----

const FLUSH_MS = 1000;
const loaded = new Set<string>();
let queue: [string, RequestEntry][] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const insertRow = db.query(
  `INSERT INTO net_requests (rid, project_id, ts, method, scheme, host, path, status, decision, rule_id,
     req_bytes, resp_bytes, duration_ms, error, credentials, redacted, credential_in_url)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const list = (a?: string[]) => (a && a.length ? JSON.stringify(a) : null);

/** Write everything recorded since the last flush, in one transaction. */
export function flushRequests(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    db.transaction(() => {
      for (const [pid, e] of batch) {
        insertRow.run(e.id, pid, e.ts, e.method, e.scheme, e.host, e.path, e.status, e.decision, e.ruleId ?? null,
          e.reqBytes, e.respBytes, e.durationMs, e.error ?? null, list(e.credentials), list(e.redacted), list(e.credentialInUrl));
      }
    })();
  } catch (err) {
    console.error(`⚠ network log: ${batch.length} request(s) not saved: ${(err as Error).message}`);
  }
}

interface Row {
  rid: string; ts: number; method: string; scheme: string; host: string; path: string; status: number | null;
  decision: "allowed" | "blocked"; rule_id: string | null; req_bytes: number; resp_bytes: number; duration_ms: number;
  error: string | null; credentials: string | null; redacted: string | null; credential_in_url: string | null;
}

function toEntry(r: Row): RequestEntry {
  const e: RequestEntry = {
    id: r.rid, ts: r.ts, method: r.method, scheme: r.scheme, host: r.host, path: r.path, status: r.status,
    decision: r.decision, ruleId: r.rule_id, reqBytes: r.req_bytes, respBytes: r.resp_bytes, durationMs: r.duration_ms,
  };
  if (r.error) e.error = r.error;
  if (r.credentials) e.credentials = JSON.parse(r.credentials);
  if (r.redacted) e.redacted = JSON.parse(r.redacted);
  if (r.credential_in_url) e.credentialInUrl = JSON.parse(r.credential_in_url);
  return e;
}

/** Up to `limit` requests made before `beforeTs`, oldest first (for paging back). */
export function requestsBefore(projectId: string, beforeTs: number, limit = 200): RequestEntry[] {
  flushRequests();
  return db.query<Row, [string, number, number]>(
    `SELECT * FROM net_requests WHERE project_id = ? AND ts < ? ORDER BY ts DESC, seq DESC LIMIT ?`,
  ).all(projectId, beforeTs, Math.min(Math.max(limit, 1), 1000)).reverse().map(toEntry);
}

export interface HostSummary {
  host: string; requests: number; ok: number; errors: number; blocked: number;
  last: number; respBytes: number; credentials: string[]; lastError: string | null;
}

/** Requests per host since `sinceTs` — the Activity tab over a day or a week. */
export function hostSummary(projectId: string, sinceTs: number): HostSummary[] {
  flushRequests();
  const rows = db.query<{
    host: string; requests: number; ok: number; errors: number; blocked: number; last: number; resp_bytes: number;
    creds: string | null; last_error: string | null;
  }, [string, number]>(
    `SELECT host, COUNT(*) AS requests,
       SUM(decision = 'allowed' AND status IS NOT NULL AND status < 400) AS ok,
       SUM(decision = 'allowed' AND (status IS NULL OR status >= 400)) AS errors,
       SUM(decision = 'blocked') AS blocked,
       MAX(ts) AS last, SUM(resp_bytes) AS resp_bytes,
       GROUP_CONCAT(DISTINCT credentials) AS creds,
       (SELECT error FROM net_requests e WHERE e.project_id = r.project_id AND e.host = r.host AND e.error IS NOT NULL
          ORDER BY ts DESC LIMIT 1) AS last_error
     FROM net_requests r WHERE project_id = ? AND ts >= ? GROUP BY host ORDER BY last DESC`,
  ).all(projectId, sinceTs);
  return rows.map((r) => {
    const names = new Set<string>();
    // GROUP_CONCAT joins the distinct JSON arrays with commas: '["A"],["A","B"]'
    if (r.creds) for (const n of JSON.parse(`[${r.creds}]`).flat()) names.add(n);
    return {
      host: r.host, requests: r.requests, ok: r.ok, errors: r.errors, blocked: r.blocked, last: r.last,
      respBytes: r.resp_bytes, credentials: [...names], lastError: r.last_error,
    };
  });
}

/** Drop log rows older than the retention window. Returns how many went. */
export function pruneRequests(days = config.netLogDays, now = Date.now()): number {
  flushRequests();
  return db.query("DELETE FROM net_requests WHERE ts < ?").run(now - days * 86_400_000).changes;
}

let retention: ReturnType<typeof setInterval> | null = null;
/** Prune now and then hourly; flush what's queued when the process exits. */
export function startRequestLog(): void {
  if (retention) return;
  const run = () => {
    try {
      const n = pruneRequests();
      if (n) console.log(`network log: pruned ${n} request(s) older than ${config.netLogDays} days`);
    } catch (err) { console.error(`⚠ network log prune: ${(err as Error).message}`); }
  };
  run();
  retention = setInterval(run, 3_600_000);
  retention.unref?.();
  process.on("exit", flushRequests);
  // Ctrl-C / kill: save the last second's requests, then exit as before
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { flushRequests(); process.exit(0); });
}
