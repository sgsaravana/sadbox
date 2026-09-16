// In-memory live feed for the proxy: a per-project ring of recent requests plus
// a pub/sub the detail-view SSE stream subscribes to. Not persisted — this is a
// live monitor, and history resets when the supervisor restarts.

export type NetEvent =
  | { type: "request"; entry: RequestEntry }
  | { type: "pending"; pending: PendingView }
  | { type: "pending-resolved"; id: string; action: string; reason?: string };

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
}

export interface PendingView {
  id: string; projectId: string; host: string; method: string; scheme: string; path: string; ts: number;
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
  publish(projectId, { type: "request", entry });
}

export function recentRequests(projectId: string): RequestEntry[] {
  return ring.get(projectId) ?? [];
}

export function clearProjectFeed(projectId: string): void {
  ring.delete(projectId);
  listeners.delete(projectId);
}
