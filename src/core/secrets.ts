// Secrets: encrypted at rest (crypto.ts), delivered as a 0600 env file in the
// guest, sourced by the shell (docs/research/05). Values are write-only via
// the API — reads return names/metadata only.
//
// Two scopes:
//   global            project_id NULL — assignable to many projects (project_secrets)
//   project-specific  project_id set  — owned by one project, deleted with it;
//                     overrides a global of the same name on injection
import { config } from "../config";
import { decrypt, encrypt } from "../crypto";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { getProject, refFor } from "./projects";

const driver = getDriver();

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export function listGlobalSecrets() {
  return db.query(
    "SELECT id, name, created_at FROM secrets WHERE project_id IS NULL ORDER BY name",
  ).all();
}

export function createGlobalSecret(name: string, value: string) {
  return insertSecret(null, name, value);
}

export function createProjectSecret(projectId: string, name: string, value: string) {
  if (!getProject(projectId)) throw new Error("project not found");
  return insertSecret(projectId, name, value);
}

function insertSecret(projectId: string | null, name: string, value: string) {
  if (!SECRET_NAME.test(name)) {
    throw new Error("secret name must be an env-var style identifier (A-Z, 0-9, _)");
  }
  const id = crypto.randomUUID().slice(0, 8);
  db.query("INSERT INTO secrets (id, project_id, name, value_enc) VALUES (?, ?, ?, ?)")
    .run(id, projectId, name, encrypt(value));
  logEvent(projectId, "secret.create", `${name} (${projectId ? "project-specific" : "global"})`);
  return { id, name, scope: projectId ? "project" : "global" };
}

/** Projects that see this secret (owner, or every assignee of a global). */
function dependentProjects(secretId: string): string[] {
  const own = db.query<{ project_id: string }, [string]>(
    "SELECT project_id FROM secrets WHERE id = ? AND project_id IS NOT NULL",
  ).get(secretId);
  if (own) return [own.project_id];
  return db.query<{ project_id: string }, [string]>(
    "SELECT project_id FROM project_secrets WHERE secret_id = ?",
  ).all(secretId).map((r) => r.project_id);
}

export async function deleteSecret(id: string) {
  const affected = dependentProjects(id);
  db.query("DELETE FROM secrets WHERE id = ?").run(id);
  logEvent(null, "secret.delete", id);
  // refresh env files so the value stops reaching new shells
  for (const pid of affected) {
    const p = getProject(pid);
    if (p && p.state === "running") await injectSecrets(pid).catch(() => {});
  }
}

/** Destroy-time cleanup: project-specific secrets die with the project. */
export function purgeProjectSecrets(projectId: string) {
  const n = db.query("DELETE FROM secrets WHERE project_id = ? RETURNING id").all(projectId).length;
  db.query("DELETE FROM project_secrets WHERE project_id = ?").run(projectId);
  if (n) logEvent(projectId, "secret.purge", `${n} project-specific secrets deleted`);
}

export function assignSecrets(projectId: string, secretIds: string[]) {
  const globals = new Set(
    db.query<{ id: string }, []>("SELECT id FROM secrets WHERE project_id IS NULL").all()
      .map((r) => r.id),
  );
  for (const sid of secretIds) {
    if (!globals.has(sid)) throw new Error(`not a global secret: ${sid}`);
  }
  db.query("DELETE FROM project_secrets WHERE project_id = ?").run(projectId);
  const ins = db.query(
    "INSERT INTO project_secrets (project_id, secret_id, status) VALUES (?, ?, 'pending')",
  );
  for (const sid of secretIds) ins.run(projectId, sid);
}

export function projectSecretView(projectId: string) {
  const assigned = db.query(
    `SELECT s.id, s.name, ps.status FROM project_secrets ps
     JOIN secrets s ON s.id = ps.secret_id WHERE ps.project_id = ? ORDER BY s.name`,
  ).all(projectId) as { id: string; name: string; status: string }[];
  const own = db.query(
    `SELECT id, name, created_at FROM secrets WHERE project_id = ? ORDER BY name`,
  ).all(projectId) as { id: string; name: string; created_at: string }[];
  return { assigned, own: own.map((o) => ({ ...o, status: "injected" })) };
}

/** Write (or rewrite) the project's env file: assigned globals first, then the
 *  project's own secrets — later lines win, so project-specific overrides global. */
export async function injectSecrets(projectId: string) {
  const p = getProject(projectId);
  if (!p) throw new Error("project not found");
  const globals = db.query(
    `SELECT s.name, s.value_enc FROM project_secrets ps
     JOIN secrets s ON s.id = ps.secret_id WHERE ps.project_id = ? ORDER BY s.name`,
  ).all(projectId) as { name: string; value_enc: string }[];
  const own = db.query(
    `SELECT name, value_enc FROM secrets WHERE project_id = ? ORDER BY name`,
  ).all(projectId) as { name: string; value_enc: string }[];

  const lines = [...globals, ...own]
    .map((r) => `${r.name}=${shellQuote(decrypt(r.value_enc))}`)
    .join("\n") + "\n";
  const r = await driver.execWithStdin(
    refFor(p.name),
    `mkdir -p $(dirname ${config.guestSecretsFile}) && umask 077 && cat > ${config.guestSecretsFile}`,
    new TextEncoder().encode(lines),
  );
  if (r.exitCode !== 0) throw new Error(`secret injection failed: ${r.stderr}`);
  db.query("UPDATE project_secrets SET status = 'injected' WHERE project_id = ?").run(projectId);
  logEvent(projectId, "secrets.inject", `${globals.length} global + ${own.length} project-specific`);
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
