// Interactive approvals: when a request has no matching rule (block-by-default),
// the proxy holds it here and asks the UI. The user answers Allow (once / a
// timed window / forever) or Block; timed/forever answers persist as a rule so
// later requests to the same host skip the prompt. Concurrent requests to the
// same host coalesce into one prompt and resolve together.
//
// The same machinery asks about credentials (docs/research/11): a request
// carrying a proxy secret's placeholder to a host none of its bindings name is
// held as a `credential` approval. Allowing it for a window or always binds the
// secret to that host; blocking only refuses this request.
//
// And about fetches (docs/research/12, V6): a VM fetching a vault item that
// asks first is held as a `fetch` approval. Allowing it for a window or always
// lets that project fetch that item without asking; blocking refuses this one.
import { config } from "../config";
import { publish, type PendingView } from "./events";
import { createRule } from "./rules";
import { bindFromApproval } from "./credentials";
import { grantFetch } from "./fetchgrants";

export type Decision = "allow" | "block";

interface Pending {
  id: string;
  projectId: string;
  host: string;
  method: string;
  scheme: string;
  path: string;
  credential?: { secretId: string; name: string };
  fetch?: { secretId: string; name: string };
  ts: number;
  waiters: ((d: Decision) => void)[];
  timer: ReturnType<typeof setTimeout>;
}

const byId = new Map<string, Pending>();
const byKey = new Map<string, Pending>(); // `${projectId}|${host}`, + `|cred:${secretId}` / `|fetch:${secretId}`

const keyOf = (p: { projectId: string; host: string; credential?: { secretId: string }; fetch?: { secretId: string } }) =>
  `${p.projectId}|${p.host}${p.credential ? `|cred:${p.credential.secretId}` : ""}${p.fetch ? `|fetch:${p.fetch.secretId}` : ""}`;

// duration token -> lifetime in ms (null = permanent rule; "once" makes no rule)
const DURATIONS: Record<string, number | null> = {
  once: 0,
  "1m": 60_000,
  "5m": 300_000,
  "30m": 1_800_000,
  "60m": 3_600_000,
  forever: null,
};

function view(p: Pending): PendingView {
  return {
    id: p.id, projectId: p.projectId, host: p.host, method: p.method, scheme: p.scheme, path: p.path, ts: p.ts,
    expiresAt: p.ts + config.approvalTimeoutMs,
    ...(p.credential ? { credential: { name: p.credential.name } } : {}),
    ...(p.fetch ? { fetch: { name: p.fetch.name } } : {}),
  };
}

/** Hold a request until it is approved or denied. Resolves with the decision. */
export function requestApproval(desc: {
  projectId: string; host: string; method: string; scheme: string; path: string;
  credential?: { secretId: string; name: string };
  fetch?: { secretId: string; name: string };
}): Promise<Decision> {
  const key = keyOf(desc);
  let p = byKey.get(key);
  if (!p) {
    const id = crypto.randomUUID().slice(0, 8);
    const created: Pending = {
      id, ...desc, ts: Date.now(), waiters: [],
      timer: setTimeout(() => finish(id, "block", undefined, "timeout"), config.approvalTimeoutMs),
    };
    p = created;
    byId.set(id, created);
    byKey.set(key, created);
    publish(desc.projectId, { type: "pending", pending: view(created) });
  }
  return new Promise<Decision>((res) => p!.waiters.push(res));
}

export function listPending(projectId?: string): PendingView[] {
  return [...byId.values()]
    .filter((p) => !projectId || p.projectId === projectId)
    .map(view);
}

/** { projectId: pendingCount } across all projects — for nav badges. */
export function pendingCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of byId.values()) out[p.projectId] = (out[p.projectId] ?? 0) + 1;
  return out;
}

/** Resolve a pending approval from the UI. duration applies to allow (window)
 *  and to block (once vs. permanent). Returns false if the id is unknown. */
export function resolveApproval(id: string, action: Decision, duration?: string): boolean {
  return finish(id, action, duration);
}

function finish(id: string, action: Decision, duration?: string, reason?: string): boolean {
  const p = byId.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  byId.delete(id);
  byKey.delete(keyOf(p));

  if (duration && duration !== "once" && duration in DURATIONS) {
    const ms = DURATIONS[duration];
    const expiresAt = ms == null ? null : new Date(Date.now() + ms).toISOString();
    if (p.credential) {
      // a credential answer persists only as a binding; a block refuses this request alone
      if (action === "allow") try { bindFromApproval(p.credential.secretId, p.host, expiresAt); } catch {}
    } else if (p.fetch) {
      // a fetch answer persists only as a grant; a block refuses this fetch alone
      if (action === "allow") try { grantFetch(p.projectId, p.fetch.secretId, expiresAt); } catch {}
    } else try {
      createRule({
        scope: "project", projectId: p.projectId, action, host: p.host,
        expiresAt, note: `via approval (${duration})`,
      });
    } catch {}
  }

  for (const w of p.waiters) { try { w(action); } catch {} }
  publish(p.projectId, { type: "pending-resolved", id, action, reason });
  return true;
}

/** Deny + clear a project's pending prompts (destroy-time cleanup, or the
 *  project's network being cut off). */
export function clearProjectApprovals(projectId: string, reason = "project destroyed"): void {
  for (const p of [...byId.values()]) {
    if (p.projectId === projectId) finish(p.id, "block", undefined, reason);
  }
}
