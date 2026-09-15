// Secrets: encrypted at rest (crypto.ts), delivered as a 0600 env file in the
// guest, sourced by the shell (docs/research/05). Values are write-only via
// the API — reads return names/metadata only.
//
// Two scopes:
//   global        worker_id NULL — assignable to many workers (worker_secrets)
//   VM-specific   worker_id set  — implicitly attached to one worker, deleted
//                 with it; overrides a global of the same name on injection
import { config } from "../config";
import { decrypt, encrypt } from "../crypto";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { getWorker, refFor } from "./workers";

const driver = getDriver();

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export function listGlobalSecrets() {
  return db.query(
    "SELECT id, name, created_at FROM secrets WHERE worker_id IS NULL ORDER BY name",
  ).all();
}

export function createGlobalSecret(name: string, value: string) {
  return insertSecret(null, name, value);
}

export function createWorkerSecret(workerId: string, name: string, value: string) {
  if (!getWorker(workerId)) throw new Error("worker not found");
  return insertSecret(workerId, name, value);
}

function insertSecret(workerId: string | null, name: string, value: string) {
  if (!SECRET_NAME.test(name)) {
    throw new Error("secret name must be an env-var style identifier (A-Z, 0-9, _)");
  }
  const id = crypto.randomUUID().slice(0, 8);
  db.query("INSERT INTO secrets (id, worker_id, name, value_enc) VALUES (?, ?, ?, ?)")
    .run(id, workerId, name, encrypt(value));
  logEvent(workerId, "secret.create", `${name} (${workerId ? "vm-specific" : "global"})`);
  return { id, name, scope: workerId ? "worker" : "global" };
}

/** Workers that see this secret (owner, or every assignee of a global). */
function dependentWorkers(secretId: string): string[] {
  const own = db.query<{ worker_id: string }, [string]>(
    "SELECT worker_id FROM secrets WHERE id = ? AND worker_id IS NOT NULL",
  ).get(secretId);
  if (own) return [own.worker_id];
  return db.query<{ worker_id: string }, [string]>(
    "SELECT worker_id FROM worker_secrets WHERE secret_id = ?",
  ).all(secretId).map((r) => r.worker_id);
}

export async function deleteSecret(id: string) {
  const affected = dependentWorkers(id);
  db.query("DELETE FROM secrets WHERE id = ?").run(id);
  logEvent(null, "secret.delete", id);
  // refresh env files so the value stops reaching new shells
  for (const wid of affected) {
    const w = getWorker(wid);
    if (w && w.state === "running") await injectSecrets(wid).catch(() => {});
  }
}

/** Destroy-time cleanup: VM-specific secrets die with the worker. */
export function purgeWorkerSecrets(workerId: string) {
  const n = db.query("DELETE FROM secrets WHERE worker_id = ? RETURNING id").all(workerId).length;
  db.query("DELETE FROM worker_secrets WHERE worker_id = ?").run(workerId);
  if (n) logEvent(workerId, "secret.purge", `${n} vm-specific secrets deleted`);
}

export function assignSecrets(workerId: string, secretIds: string[]) {
  const globals = new Set(
    db.query<{ id: string }, []>("SELECT id FROM secrets WHERE worker_id IS NULL").all()
      .map((r) => r.id),
  );
  for (const sid of secretIds) {
    if (!globals.has(sid)) throw new Error(`not a global secret: ${sid}`);
  }
  db.query("DELETE FROM worker_secrets WHERE worker_id = ?").run(workerId);
  const ins = db.query(
    "INSERT INTO worker_secrets (worker_id, secret_id, status) VALUES (?, ?, 'pending')",
  );
  for (const sid of secretIds) ins.run(workerId, sid);
}

export function workerSecretView(workerId: string) {
  const assigned = db.query(
    `SELECT s.id, s.name, ws.status FROM worker_secrets ws
     JOIN secrets s ON s.id = ws.secret_id WHERE ws.worker_id = ? ORDER BY s.name`,
  ).all(workerId) as { id: string; name: string; status: string }[];
  const own = db.query(
    `SELECT id, name, created_at FROM secrets WHERE worker_id = ? ORDER BY name`,
  ).all(workerId) as { id: string; name: string; created_at: string }[];
  return { assigned, own: own.map((o) => ({ ...o, status: "injected" })) };
}

/** Write (or rewrite) the worker's env file: assigned globals first, then the
 *  worker's own secrets — later lines win, so VM-specific overrides global. */
export async function injectSecrets(workerId: string) {
  const w = getWorker(workerId);
  if (!w) throw new Error("worker not found");
  const globals = db.query(
    `SELECT s.name, s.value_enc FROM worker_secrets ws
     JOIN secrets s ON s.id = ws.secret_id WHERE ws.worker_id = ? ORDER BY s.name`,
  ).all(workerId) as { name: string; value_enc: string }[];
  const own = db.query(
    `SELECT name, value_enc FROM secrets WHERE worker_id = ? ORDER BY name`,
  ).all(workerId) as { name: string; value_enc: string }[];

  const lines = [...globals, ...own]
    .map((r) => `${r.name}=${shellQuote(decrypt(r.value_enc))}`)
    .join("\n") + "\n";
  const r = await driver.execWithStdin(
    refFor(w.name),
    `mkdir -p $(dirname ${config.guestSecretsFile}) && umask 077 && cat > ${config.guestSecretsFile}`,
    new TextEncoder().encode(lines),
  );
  if (r.exitCode !== 0) throw new Error(`secret injection failed: ${r.stderr}`);
  db.query("UPDATE worker_secrets SET status = 'injected' WHERE worker_id = ?").run(workerId);
  logEvent(workerId, "secrets.inject", `${globals.length} global + ${own.length} vm-specific`);
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
