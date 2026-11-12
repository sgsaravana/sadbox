import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { config, dbPath } from "./config";

mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(dbPath(), { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// --- migration: workers-era schema → projects-era (rename tables/columns) ---
// A microVM used to be a "worker"; it is now a "project". Rename in place so an
// existing dev DB keeps its rows. RENAME TABLE also rewrites child tables' FK
// clauses to follow the new name, so order doesn't orphan references.
const tableExists = (name: string) =>
  db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;

if (tableExists("workers") && !tableExists("projects")) {
  db.run("PRAGMA foreign_keys = OFF");
  db.run("ALTER TABLE workers RENAME TO projects");
  if (tableExists("secrets")) db.run("ALTER TABLE secrets RENAME COLUMN worker_id TO project_id");
  if (tableExists("worker_secrets")) {
    db.run("ALTER TABLE worker_secrets RENAME TO project_secrets");
    db.run("ALTER TABLE project_secrets RENAME COLUMN worker_id TO project_id");
  }
  if (tableExists("events")) db.run("ALTER TABLE events RENAME COLUMN worker_id TO project_id");
  // drop old index names (recreated below under new names)
  for (const idx of ["workers_active_name", "secrets_worker_name"]) {
    db.run(`DROP INDEX IF EXISTS ${idx}`);
  }
  db.run("PRAGMA foreign_keys = ON");
}

db.run(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'creating',   -- creating|running|stopped|error|destroyed
    source_path TEXT NOT NULL,
    source_branch TEXT,
    base_sha TEXT,
    last_synced_sha TEXT,
    apps TEXT NOT NULL DEFAULT '[]',
    git_remote TEXT,                          -- optional external git remote (origin)
    git_token_enc TEXT,                       -- encrypted access token for git_remote
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
// add git columns to a pre-git projects table
// sync_path: a local folder connected after the fact to a project that was
// created from a git URL (source_path ''), so its work can be synced back. Kept
// apart from source_path, which is what a Rebuild recreates the VM from.
for (const [col, ddl] of [["git_remote", "git_remote TEXT"], ["git_token_enc", "git_token_enc TEXT"], ["sync_path", "sync_path TEXT"],
  // memory_mb: the VM's memory, per project (NULL on rows from before it was
  // recorded — those VMs were created with whatever the default was then)
  ["memory_mb", "memory_mb INTEGER"],
  // branch: the branch the VM had checked out when last seen (NULL: never asked)
  ["branch", "branch TEXT"],
  // net_cutoff: 1 = the proxy refuses every request from this VM (one-click "internet off")
  ["net_cutoff", "net_cutoff INTEGER NOT NULL DEFAULT 0"],
  // history_mounted: 1 = the VM was created with the project's agent history
  // mounted (research/13, A2); 0 = an older VM that keeps it on its own disk
  ["history_mounted", "history_mounted INTEGER NOT NULL DEFAULT 0"],
  // empty: 1 = created with neither a folder nor a git remote — the VM starts
  // with an empty workdir and repositories are cloned into it from the terminal
  ["empty", "empty INTEGER NOT NULL DEFAULT 0"]]) {
  const has = db.query<{ name: string }, []>("PRAGMA table_info(projects)").all().some((c) => c.name === col);
  if (!has) db.run(`ALTER TABLE projects ADD COLUMN ${ddl}`);
}
// name uniqueness applies only to live projects — destroyed rows stay as history
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS projects_active_name
        ON projects(name) WHERE state != 'destroyed'`);

// Corrective migration: SQLite's RENAME TABLE above does not rewrite child FK
// references while foreign_keys is OFF, so secrets/project_secrets can be left
// pointing at the vanished "workers" table (FK checks then fail with
// "no such table: main.workers"). Rebuild any such table against `projects`.
const refsOldTable = (table: string) => {
  const row = db.query<{ sql: string }, [string]>(
    "SELECT sql FROM sqlite_master WHERE name = ?").get(table);
  return row != null && /REFERENCES\s+workers/i.test(row.sql);
};
if (refsOldTable("secrets") || refsOldTable("project_secrets")) {
  db.run("PRAGMA foreign_keys = OFF");
  db.run(`CREATE TABLE secrets_fix (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    name TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`INSERT INTO secrets_fix SELECT id, project_id, name, value_enc, created_at FROM secrets`);
  db.run("DROP TABLE secrets");
  db.run("ALTER TABLE secrets_fix RENAME TO secrets");

  db.run(`CREATE TABLE project_secrets_fix (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (project_id, secret_id)
  )`);
  db.run(`INSERT INTO project_secrets_fix SELECT project_id, secret_id, status FROM project_secrets`);
  db.run("DROP TABLE project_secrets");
  db.run("ALTER TABLE project_secrets_fix RENAME TO project_secrets");
  db.run("PRAGMA foreign_keys = ON");
}

// secrets: the vault's items (docs/research/12). The table keeps its old name
// so placeholders, bindings and header rules keep pointing at it. Which
// projects may use an item is project_secrets. secrets.project_id is from
// before the vault (a project-specific secret) — migrateToVault() empties it.
db.run(`
  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    name TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
db.run(`
  CREATE TABLE IF NOT EXISTS project_secrets (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending|injected|stale
    PRIMARY KEY (project_id, secret_id)
  )`);
// delivery: how an item reaches a VM (docs/research/11, 12).
//   proxy  the VM gets a placeholder; the egress proxy swaps in the real value
//          on requests to the item's bindings, so it never enters the VM
//   fetch  nothing in the VM; fetched at runtime (`in_env`: also written to
//          the env file, as every secret was before the vault)
//   env    before the vault: the real value in the env file → fetch + in_env
// kind: variable (value shown in the UI) | secret (hidden until revealed)
// value_type: string | number | json
// ask_on_fetch: a fetch waits for the owner's approval
// swap_url / swap_body: a proxy item is swapped in the URL / the request body
//   too, not only in headers (docs/research/12, V3–V4)
let addedNote = false;
for (const [col, ddl] of [
  ["delivery", "delivery TEXT NOT NULL DEFAULT 'env'"],
  ["kind", "kind TEXT NOT NULL DEFAULT 'secret'"],
  ["value_type", "value_type TEXT NOT NULL DEFAULT 'string'"],
  ["in_env", "in_env INTEGER NOT NULL DEFAULT 0"],
  ["ask_on_fetch", "ask_on_fetch INTEGER NOT NULL DEFAULT 1"],
  ["updated_at", "updated_at TEXT"],
  ["swap_url", "swap_url INTEGER NOT NULL DEFAULT 0"],
  ["swap_body", "swap_body INTEGER NOT NULL DEFAULT 0"],
  ["note", "note TEXT"],
]) {
  const has = db.query<{ name: string }, []>("PRAGMA table_info(secrets)").all().some((c) => c.name === col);
  if (!has) {
    db.run(`ALTER TABLE secrets ADD COLUMN ${ddl}`);
    if (col === "note") addedNote = true;
  }
}

/** Secrets → vault items (docs/research/12, V9). Idempotent, run at every start.
 *  An env secret becomes a fetch item still written to the env file, with no
 *  approval, so nothing using it breaks. A project-specific secret becomes an
 *  item its project has access to — and, as before, wins over an assigned
 *  global of the same name, which that project loses access to. Names are
 *  unique per project now, not across the vault. */
export function migrateToVault(): void {
  db.transaction(() => {
    db.run("DROP INDEX IF EXISTS secrets_global_name");
    db.run("DROP INDEX IF EXISTS secrets_project_name");
    db.run("UPDATE secrets SET delivery = 'fetch', in_env = 1, ask_on_fetch = 0 WHERE delivery = 'env'");
    db.run(`DELETE FROM project_secrets WHERE EXISTS (
              SELECT 1 FROM secrets g JOIN secrets own ON own.name = g.name AND own.id != g.id
              WHERE g.id = project_secrets.secret_id AND own.project_id = project_secrets.project_id)`);
    db.run(`INSERT OR IGNORE INTO project_secrets (project_id, secret_id, status)
            SELECT project_id, id, 'injected' FROM secrets WHERE project_id IS NOT NULL`);
    db.run("UPDATE secrets SET project_id = NULL WHERE project_id IS NOT NULL");
  })();
}
migrateToVault();
// First run with `note`: label existing git-token items with the one project
// they belong to, so duplicates made before notes existed are told apart (and
// the label survives that project being destroyed). Only once, so clearing a
// note later is not undone.
if (addedNote) {
  db.run(`UPDATE secrets SET note = 'for ' || (
            SELECT p.name FROM project_secrets ps JOIN projects p ON p.id = ps.project_id
            WHERE ps.secret_id = secrets.id LIMIT 1)
          WHERE note IS NULL
            AND name IN ('GITHUB_TOKEN', 'GITLAB_TOKEN', 'GIT_TOKEN')
            AND (SELECT COUNT(*) FROM project_secrets ps WHERE ps.secret_id = secrets.id) = 1`);
}
// One placeholder per (project, proxy secret), stable across restarts and
// rebuilds, different in every VM — a placeholder copied out of one VM is
// worthless from another. No cascade from projects: project rows are soft-
// deleted, so purgeProjectVault clears these explicitly.
db.run(`
  CREATE TABLE IF NOT EXISTS secret_placeholders (
    project_id TEXT NOT NULL REFERENCES projects(id),
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    placeholder TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, secret_id)
  )`);
// Where a proxy secret's real value may be sent. Matched like net_rules:
// host exact or *.suffix (never a bare *), optional path (exact | prefix*),
// method and header name. expires_at drives time-boxed approvals.
db.run(`
  CREATE TABLE IF NOT EXISTS secret_bindings (
    id TEXT PRIMARY KEY,
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    path TEXT,                                 -- exact | prefix* | NULL = any
    method TEXT,                               -- GET/POST/... | NULL = any
    header TEXT,                               -- lowercased | NULL = any header
    expires_at TEXT,                           -- ISO 8601 | NULL = permanent
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
db.run("CREATE INDEX IF NOT EXISTS secret_bindings_secret ON secret_bindings(secret_id)");
// A project may fetch a vault item at runtime without being asked again
// (docs/research/12, V6): made by an approval answered with a window or
// "always". expires_at NULL = until revoked. No cascade from projects (rows
// are soft-deleted): purgeProjectVault clears these.
db.run(`
  CREATE TABLE IF NOT EXISTS vault_fetch_grants (
    project_id TEXT NOT NULL REFERENCES projects(id),
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, secret_id)
  )`);
db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
db.run(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    type TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

// --- network proxy rules ---
// Egress firewall for the per-project proxy. scope 'global' (project_id NULL)
// applies to every VM; scope 'project' applies to one. Block beats allow; with
// no matching rule the request is held for interactive approval (block-by-
// default). expires_at drives the timed "allow for N minutes" approvals.
db.run(`
  CREATE TABLE IF NOT EXISTS net_rules (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,                       -- global | project
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    action TEXT NOT NULL,                      -- allow | block
    host TEXT NOT NULL,                        -- exact | *.suffix | *
    path TEXT,                                 -- glob prefix (foo*) | NULL = any
    method TEXT,                               -- GET/POST/... | NULL = any
    expires_at TEXT,                           -- ISO 8601 | NULL = permanent
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
db.run("CREATE INDEX IF NOT EXISTS net_rules_lookup ON net_rules(scope, project_id)");

// Header rewrites applied to matching requests/responses as they pass through.
// A 'set' value is either a literal (`value`) or resolved at proxy time from a
// secret (`value_secret_id`) — so a real token can be injected per-host without
// ever living inside the VM. No FK on value_secret_id: a dangling reference just
// resolves to "skip" rather than blocking the secret's deletion.
db.run(`
  CREATE TABLE IF NOT EXISTS net_header_rules (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,                       -- global | project
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    direction TEXT NOT NULL,                   -- request | response
    op TEXT NOT NULL,                          -- set | remove
    header TEXT NOT NULL,
    value TEXT,                                -- literal value for 'set'
    value_secret_id TEXT,                      -- resolve value from this secret instead
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
db.run("CREATE INDEX IF NOT EXISTS net_header_rules_lookup ON net_header_rules(scope, project_id)");
// add value_secret_id to a pre-secret-value net_header_rules table
{
  const has = db.query<{ name: string }, []>("PRAGMA table_info(net_header_rules)").all()
    .some((c) => c.name === "value_secret_id");
  if (!has) db.run("ALTER TABLE net_header_rules ADD COLUMN value_secret_id TEXT");
}

// Every request a VM made through the proxy (what the Network panel's Activity
// shows), kept for config.netLogDays and pruned hourly (net/events.ts). Names
// of secrets only — never values; paths can hold a placeholder, never a real one.
db.run(`
  CREATE TABLE IF NOT EXISTS net_requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    rid TEXT NOT NULL,                         -- the live feed's id for the row
    project_id TEXT NOT NULL,
    ts INTEGER NOT NULL,                       -- ms since epoch, when the request arrived
    method TEXT NOT NULL,
    scheme TEXT NOT NULL,
    host TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER,
    decision TEXT NOT NULL,                    -- allowed | blocked
    rule_id TEXT,
    req_bytes INTEGER NOT NULL DEFAULT 0,
    resp_bytes INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    credentials TEXT,                          -- JSON array of secret names swapped in
    redacted TEXT,                             -- JSON array of secret names scrubbed from the response
    credential_in_url TEXT                     -- JSON array of secret names whose placeholder was in the URL
  )`);
db.run("CREATE INDEX IF NOT EXISTS net_requests_project_ts ON net_requests(project_id, ts)");
db.run("CREATE INDEX IF NOT EXISTS net_requests_ts ON net_requests(ts)");

// Inbound port forwards: a listener on the supervisor host (host_port) piped to
// a port inside one project's VM (guest_port). host_port is unique across all
// projects — it is a real socket on this machine.
db.run(`
  CREATE TABLE IF NOT EXISTS port_forwards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host_port INTEGER NOT NULL UNIQUE,
    guest_port INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
// access: 'signin' = HTTP, only for a browser signed in to sadbox (net/forwards.ts);
// 'open' = raw TCP for anyone who reaches the port. Forwards made before this
// were open; they move behind sign-in.
{
  const has = db.query<{ name: string }, []>("PRAGMA table_info(port_forwards)").all()
    .some((c) => c.name === "access");
  if (!has) db.run("ALTER TABLE port_forwards ADD COLUMN access TEXT NOT NULL DEFAULT 'signin'");
}
// A browser's pass to one sign-in forward, handed out by a signed-in session of
// the web UI and ending with it (core/auth.ts). Only hashes are stored.
db.run(`
  CREATE TABLE IF NOT EXISTS forward_sessions (
    token_hash TEXT PRIMARY KEY,
    forward_id TEXT NOT NULL,
    session_hash TEXT,                         -- the UI session it came from (NULL with sign-in off)
    expires_at INTEGER NOT NULL                -- ms since epoch
  )`);

// Agent logins kept by the supervisor (core/logins.ts, research/13 A4 / A7):
// one per tool and provider, for every project. 'api' logins (an API key) are
// copied into VMs; an 'oauth' login (Claude) never is — sadbox holds the real
// tokens and refreshes them, VMs hold placeholders the proxy swaps.
db.run(`
  CREATE TABLE IF NOT EXISTS agent_logins (
    tool TEXT NOT NULL,                        -- claude | omp | opencode
    provider TEXT NOT NULL,                    -- the tool's name for whose login it is (deepseek, claude.ai, …)
    kind TEXT NOT NULL,                        -- api | oauth
    data_enc TEXT NOT NULL,                    -- the login itself (JSON), encrypted
    from_project TEXT,                         -- name of the project it was captured from
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at INTEGER,                        -- oauth: when the access token runs out (ms)
    refreshed_at INTEGER,                      -- oauth: last refresh by sadbox (ms)
    status TEXT,                               -- null = usable; otherwise why not
    PRIMARY KEY (tool, provider)
  )`);
// A project's placeholders for an oauth login (stable across refreshes).
db.run(`
  CREATE TABLE IF NOT EXISTS login_placeholders (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    provider TEXT NOT NULL,
    field TEXT NOT NULL,                       -- access | refresh
    placeholder TEXT NOT NULL UNIQUE,
    PRIMARY KEY (project_id, tool, provider, field)
  )`);
// What sadbox last saw (or put) in a VM for an api login: a VM whose login
// differs from this has logged in anew, and its login becomes the one kept.
db.run(`
  CREATE TABLE IF NOT EXISTS login_seen (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    provider TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (project_id, tool, provider)
  )`);

// Project links (see net/links.ts): from_project may reach `port` inside
// to_project's VM, as <to-name>.sadbox.internal:<port> — one way, one port.
db.run(`
  CREATE TABLE IF NOT EXISTS project_links (
    id TEXT PRIMARY KEY,
    from_project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    port INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (from_project, to_project, port)
  )`);

// Browser sessions (see core/auth.ts). Only a hash of each token is stored.
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL                -- ms since epoch
  )`);

export function logEvent(projectId: string | null, type: string, detail = "") {
  db.query("INSERT INTO events (project_id, type, detail) VALUES (?, ?, ?)").run(
    projectId, type, detail,
  );
}
