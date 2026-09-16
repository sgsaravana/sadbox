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
for (const [col, ddl] of [["git_remote", "git_remote TEXT"], ["git_token_enc", "git_token_enc TEXT"]]) {
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

// secrets.project_id: NULL = global (assignable to many projects via
// project_secrets); set = project-specific (owned by that project, deleted
// when the project is destroyed)
db.run(`
  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    name TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS secrets_global_name
        ON secrets(name) WHERE project_id IS NULL`);
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS secrets_project_name
        ON secrets(project_id, name) WHERE project_id IS NOT NULL`);
db.run(`
  CREATE TABLE IF NOT EXISTS project_secrets (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending|injected|stale
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

export function logEvent(projectId: string | null, type: string, detail = "") {
  db.query("INSERT INTO events (project_id, type, detail) VALUES (?, ?, ?)").run(
    projectId, type, detail,
  );
}
