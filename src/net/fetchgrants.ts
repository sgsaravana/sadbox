// Standing answers to "may this project fetch this vault item?" (docs/research/12,
// V6) — kept apart from the fetch endpoint so approvals can record one without
// an import cycle.
import { db } from "../db";

/** Let a project fetch an item without asking, until `expiresAt` (null: until revoked). */
export function grantFetch(projectId: string, secretId: string, expiresAt: string | null): void {
  db.query(
    `INSERT INTO vault_fetch_grants (project_id, secret_id, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id, secret_id) DO UPDATE SET expires_at = excluded.expires_at, created_at = datetime('now')`,
  ).run(projectId, secretId, expiresAt);
}

export function hasFetchGrant(projectId: string, secretId: string, now = Date.now()): boolean {
  const g = db.query<{ expires_at: string | null }, [string, string]>(
    "SELECT expires_at FROM vault_fetch_grants WHERE project_id = ? AND secret_id = ?",
  ).get(projectId, secretId);
  return !!g && (g.expires_at == null || Date.parse(g.expires_at) > now);
}

/** The projects that may fetch an item without asking, now. */
export function listFetchGrants(secretId: string, now = Date.now()): { projectId: string; expiresAt: string | null }[] {
  return db.query<{ project_id: string; expires_at: string | null }, [string]>(
    "SELECT project_id, expires_at FROM vault_fetch_grants WHERE secret_id = ? ORDER BY created_at",
  ).all(secretId)
    .filter((g) => g.expires_at == null || Date.parse(g.expires_at) > now)
    .map((g) => ({ projectId: g.project_id, expiresAt: g.expires_at }));
}

/** Take back a project's standing answer for one item, or for all of them. */
export function revokeFetchGrants(projectId: string, secretIds?: string[]): void {
  if (!secretIds) { db.query("DELETE FROM vault_fetch_grants WHERE project_id = ?").run(projectId); return; }
  const q = db.query("DELETE FROM vault_fetch_grants WHERE project_id = ? AND secret_id = ?");
  for (const sid of secretIds) q.run(projectId, sid);
}
