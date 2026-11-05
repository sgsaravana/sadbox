// Egress rule engine: allow/block decisions and request/response header
// rewrites, keyed by host (exact, *.suffix, or *), optional path glob + method.
// Global rules apply to every project; project rules apply to one. Block wins
// over allow; no match → "ask" (interactive approval, block-by-default).
//
// A project's proxy vault items also allow the hosts they are bound to (their
// bindings' host, path, method and expiry): giving a project GITHUB_TOKEN bound
// to github.com lets `git clone` through, including git's first, unauthenticated
// request. These are derived, not stored, so they come and go with the item's
// access, mode and bindings; listRules shows them read-only (source "vault").
// The rules people write still decide first: a block rule wins over them.
import { db } from "../db";
import { decrypt } from "../crypto";

export interface NetRule {
  id: string;
  scope: "global" | "project";
  project_id: string | null;
  action: "allow" | "block";
  host: string;
  path: string | null;
  method: string | null;
  expires_at: string | null;
  note: string | null;
  created_at: string;
  source?: "vault";        // derived from a proxy vault item's binding (read-only)
  secret_id?: string;
  secret_name?: string;
}

export interface HeaderRule {
  id: string;
  scope: "global" | "project";
  project_id: string | null;
  host: string;
  direction: "request" | "response";
  op: "set" | "remove";
  header: string;
  value: string | null;
  value_secret_id: string | null;   // when set, value is resolved from this secret
  value_secret_name?: string | null; // joined for display (never the value itself)
  created_at: string;
}

export type Verdict = { decision: "allow" | "block" | "ask"; rule?: NetRule };

// ---- rule CRUD ----

export function listRules(projectId?: string): NetRule[] {
  return projectId
    ? [...db.query<NetRule, [string]>(
        "SELECT * FROM net_rules WHERE scope='global' OR project_id=? ORDER BY scope, created_at DESC",
      ).all(projectId), ...vaultRules(projectId)]
    : db.query<NetRule, []>(
        "SELECT * FROM net_rules WHERE scope='global' ORDER BY created_at DESC",
      ).all();
}

export const VAULT_RULE_PREFIX = "vault-";
export const isVaultRule = (id: string) => id.startsWith(VAULT_RULE_PREFIX);

/** The allows a project's proxy vault items give it: one per binding. */
export function vaultRules(projectId: string): NetRule[] {
  return db.query<{ id: string; host: string; path: string | null; method: string | null; expires_at: string | null;
    created_at: string; secret_id: string; name: string }, [string]>(
    `SELECT b.id, b.host, b.path, b.method, b.expires_at, b.created_at, s.id AS secret_id, s.name
     FROM secret_bindings b JOIN secrets s ON s.id = b.secret_id
     JOIN project_secrets ps ON ps.secret_id = s.id
     WHERE ps.project_id = ? AND s.delivery = 'proxy' ORDER BY s.name, b.rowid`,
  ).all(projectId).map((b) => ({
    id: VAULT_RULE_PREFIX + b.id, scope: "project", project_id: projectId, action: "allow",
    host: b.host, path: b.path, method: b.method, expires_at: b.expires_at,
    note: `vault item ${b.name}`, created_at: b.created_at,
    source: "vault", secret_id: b.secret_id, secret_name: b.name,
  }));
}

export function createRule(o: {
  scope: "global" | "project";
  projectId?: string | null;
  action: "allow" | "block";
  host: string;
  path?: string | null;
  method?: string | null;
  expiresAt?: string | null;
  note?: string | null;
}): NetRule {
  const host = normalizeHost(o.host);
  if (!host) throw new Error("host is required (e.g. api.github.com, *.github.com, or *)");
  if (o.action !== "allow" && o.action !== "block") throw new Error("action must be allow or block");
  if (o.scope === "project" && !o.projectId) throw new Error("a project rule needs a projectId");
  const id = crypto.randomUUID().slice(0, 8);
  db.query(
    `INSERT INTO net_rules (id, scope, project_id, action, host, path, method, expires_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, o.scope, o.scope === "project" ? o.projectId! : null, o.action, host,
    o.path?.trim() || null, o.method ? o.method.toUpperCase() : null,
    o.expiresAt || null, o.note || null,
  );
  return db.query<NetRule, [string]>("SELECT * FROM net_rules WHERE id=?").get(id)!;
}

export function deleteRule(id: string): void {
  db.query("DELETE FROM net_rules WHERE id=?").run(id);
}

/** Move a rule between this project and all projects (global), keeping its
 *  action, host, path, method and expiry. If the target scope already has the
 *  same rule, the moved one is dropped instead of duplicated. Returns the rule
 *  that now stands in the target scope. */
export function moveRule(id: string, scope: "global" | "project", projectId?: string | null): NetRule {
  const r = db.query<NetRule, [string]>("SELECT * FROM net_rules WHERE id=?").get(id);
  if (!r) throw new Error("rule not found");
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
  if (scope === "project" && !projectId) throw new Error("moving a rule to a project needs the project");
  const target = scope === "global" ? null : projectId!;
  if (r.scope === scope && r.project_id === target) return r;
  const twin = db.query<NetRule, [string, string, string | null, string, string | null, string | null]>(
    `SELECT * FROM net_rules WHERE scope=? AND action=? AND project_id IS ? AND host=?
       AND path IS ? AND method IS ? AND expires_at IS NULL`,
  ).get(scope, r.action, target, r.host, r.path, r.method);
  if (twin && !r.expires_at) {
    deleteRule(id); // the target already has it, permanently
    return twin;
  }
  db.query("UPDATE net_rules SET scope=?, project_id=? WHERE id=?").run(scope, target, id);
  return db.query<NetRule, [string]>("SELECT * FROM net_rules WHERE id=?").get(id)!;
}

// ---- header rule CRUD ----

const HEADER_SELECT =
  `SELECT h.*, s.name AS value_secret_name
   FROM net_header_rules h LEFT JOIN secrets s ON s.id = h.value_secret_id`;

export function listHeaderRules(projectId?: string): HeaderRule[] {
  return projectId
    ? db.query<HeaderRule, [string]>(
        `${HEADER_SELECT} WHERE h.scope='global' OR h.project_id=? ORDER BY h.scope, h.created_at DESC`,
      ).all(projectId)
    : db.query<HeaderRule, []>(
        `${HEADER_SELECT} WHERE h.scope='global' ORDER BY h.created_at DESC`,
      ).all();
}

export function createHeaderRule(o: {
  scope: "global" | "project";
  projectId?: string | null;
  host: string;
  direction: "request" | "response";
  op: "set" | "remove";
  header: string;
  value?: string | null;
  valueSecretId?: string | null;
}): HeaderRule {
  const host = normalizeHost(o.host);
  if (!host) throw new Error("host is required");
  const header = o.header.trim();
  if (!header) throw new Error("header name is required");
  if (o.direction !== "request" && o.direction !== "response") throw new Error("direction must be request or response");
  if (o.op !== "set" && o.op !== "remove") throw new Error("op must be set or remove");
  if (o.scope === "project" && !o.projectId) throw new Error("a project rule needs a projectId");

  let valueSecretId: string | null = null;
  if (o.op === "set" && o.valueSecretId) {
    const s = db.query<{ id: string }, [string]>("SELECT id FROM secrets WHERE id=?").get(o.valueSecretId);
    if (!s) throw new Error("vault item not found");
    // a project's rule may only use what the project has access to; a global
    // rule fills the header only in projects that have (see applyHeaders)
    if (o.scope === "project" && !db.query("SELECT 1 FROM project_secrets WHERE project_id=? AND secret_id=?").get(o.projectId!, s.id)) {
      throw new Error("this project has no access to that vault item");
    }
    valueSecretId = s.id;
  }
  if (o.op === "set" && !valueSecretId && (o.value ?? "") === "") {
    throw new Error("a 'set' rule needs a value or a secret");
  }

  const id = crypto.randomUUID().slice(0, 8);
  db.query(
    `INSERT INTO net_header_rules (id, scope, project_id, host, direction, op, header, value, value_secret_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, o.scope, o.scope === "project" ? o.projectId! : null, host,
    o.direction, o.op, header,
    o.op === "set" && !valueSecretId ? (o.value ?? "") : null, valueSecretId,
  );
  return db.query<HeaderRule, [string]>(`${HEADER_SELECT} WHERE h.id=?`).get(id)!;
}

export function deleteHeaderRule(id: string): void {
  db.query("DELETE FROM net_header_rules WHERE id=?").run(id);
}

/** Remove all rules owned by a project (destroy-time cleanup — project rows are
 *  soft-deleted, so the ON DELETE CASCADE never fires). */
export function purgeProjectNet(projectId: string): void {
  db.query("DELETE FROM net_rules WHERE project_id=?").run(projectId);
  db.query("DELETE FROM net_header_rules WHERE project_id=?").run(projectId);
}

// ---- evaluation ----

export function evaluate(
  projectId: string | null,
  req: { host: string; path: string; method: string },
): Verdict {
  const now = Date.now();
  const rules = projectId
    ? db.query<NetRule, [string]>("SELECT * FROM net_rules WHERE scope='global' OR project_id=?").all(projectId)
    : db.query<NetRule, []>("SELECT * FROM net_rules WHERE scope='global'").all();
  const matches = rules.filter(
    (r) => (!r.expires_at || Date.parse(r.expires_at) > now) && matchRule(r, req),
  );
  const block = matches.find((r) => r.action === "block");
  if (block) return { decision: "block", rule: block };
  const allow = matches.find((r) => r.action === "allow");
  if (allow) return { decision: "allow", rule: allow };
  if (projectId) {
    // a binding's path is matched without the query string, as the swap matches it
    const bare = { ...req, path: req.path.split("?")[0] };
    const vault = vaultRules(projectId).find((r) => (!r.expires_at || Date.parse(r.expires_at) > now) && matchRule(r, bare));
    if (vault) return { decision: "allow", rule: vault };
  }
  return { decision: "ask" };
}

/** Apply header rewrites in place. `headers` uses lowercased keys (node style). */
export function applyHeaders(
  projectId: string | null,
  host: string,
  direction: "request" | "response",
  headers: Record<string, unknown>,
): void {
  const rules = projectId
    ? db.query<HeaderRule, [string]>("SELECT * FROM net_header_rules WHERE scope='global' OR project_id=?").all(projectId)
    : db.query<HeaderRule, []>("SELECT * FROM net_header_rules WHERE scope='global'").all();
  for (const r of rules) {
    if (r.direction !== direction || !hostMatch(r.host, host)) continue;
    const lc = r.header.toLowerCase();
    if (r.op === "remove") {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === lc) delete headers[k];
      continue;
    }
    let value = r.value ?? "";
    if (r.value_secret_id) {
      // resolve from the vault — only an item this project has access to
      const s = db.query<{ value_enc: string }, [string, string | null]>(
        `SELECT s.value_enc FROM secrets s JOIN project_secrets ps ON ps.secret_id = s.id
         WHERE s.id=? AND ps.project_id=?`,
      ).get(r.value_secret_id, projectId);
      if (!s) continue; // secret gone or not accessible → leave the header untouched
      value = decrypt(s.value_enc);
    }
    for (const k of Object.keys(headers)) if (k.toLowerCase() === lc && k !== lc) delete headers[k];
    headers[lc] = value;
  }
}

// ---- matchers ----

function matchRule(r: NetRule, req: { host: string; path: string; method: string }): boolean {
  if (!hostMatch(r.host, req.host)) return false;
  if (r.method && r.method !== req.method.toUpperCase()) return false;
  if (r.path && !pathMatch(r.path, req.path)) return false;
  return true;
}

export function hostMatch(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const bare = pattern.slice(2);
    return host === bare || host.endsWith("." + bare);
  }
  return host === pattern;
}

export function pathMatch(pattern: string, path: string): boolean {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
}
