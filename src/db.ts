import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { config, dbPath } from "./config";

mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(dbPath(), { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'creating',   -- creating|running|stopped|error|destroyed
    source_path TEXT NOT NULL,
    source_branch TEXT,
    base_sha TEXT,
    last_synced_sha TEXT,
    apps TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
// name uniqueness applies only to live workers — destroyed rows stay as history
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS workers_active_name
        ON workers(name) WHERE state != 'destroyed'`);
// secrets.worker_id: NULL = global (assignable to many workers via
// worker_secrets); set = VM-specific (implicitly attached to that worker,
// deleted when the worker is destroyed)
db.run(`
  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    worker_id TEXT REFERENCES workers(id),
    name TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
// migrate a pre-worker_id table (dev-era schema). SQLite's documented recipe:
// FKs off, build the NEW table, copy, drop old, rename new into place —
// renaming the OLD table instead would rewrite other tables' FK clauses to
// follow it ("secrets_old") and orphan them.
const secretCols = db.query<{ name: string }, []>("PRAGMA table_info(secrets)").all();
if (!secretCols.some((c) => c.name === "worker_id")) {
  db.run("PRAGMA foreign_keys = OFF");
  db.run(`CREATE TABLE secrets_new (
    id TEXT PRIMARY KEY,
    worker_id TEXT REFERENCES workers(id),
    name TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`INSERT INTO secrets_new (id, name, value_enc, created_at)
          SELECT id, name, value_enc, created_at FROM secrets`);
  db.run("DROP TABLE secrets");
  db.run("ALTER TABLE secrets_new RENAME TO secrets");
  db.run("PRAGMA foreign_keys = ON");
}
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS secrets_global_name
        ON secrets(name) WHERE worker_id IS NULL`);
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS secrets_worker_name
        ON secrets(worker_id, name) WHERE worker_id IS NOT NULL`);
db.run(`
  CREATE TABLE IF NOT EXISTS worker_secrets (
    worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending|injected|stale
    PRIMARY KEY (worker_id, secret_id)
  )`);
db.run(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT,
    type TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

export function logEvent(workerId: string | null, type: string, detail = "") {
  db.query("INSERT INTO events (worker_id, type, detail) VALUES (?, ?, ?)").run(
    workerId, type, detail,
  );
}
