// Secrets: encrypted at rest (crypto.ts), delivered as a 0600 env file in the
// guest, sourced by the shell (docs/research/05). Values are write-only via
// the API — reads return names/metadata only.
//
// Two scopes:
//   global            project_id NULL — assignable to many projects (project_secrets)
//   project-specific  project_id set  — owned by one project, deleted with it;
//                     overrides a global of the same name on injection
//
// Two deliveries (docs/research/11):
//   env    the real value goes into the env file
//   proxy  the env file gets a per-project placeholder; the egress proxy swaps
//          in the real value on requests matching one of the secret's bindings
import { config } from "../config";
import { decrypt, encrypt } from "../crypto";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { getProject, refFor } from "./projects";
import { dropPlaceholders, existingPlaceholder, placeholderFor } from "./placeholders";
import { normalizeHost } from "../net/rules";

const driver = getDriver();

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export type Delivery = "env" | "proxy";

export interface BindingInput {
  host: string;
  path?: string | null;
  method?: string | null;
  header?: string | null;
  expiresAt?: string | null;
}

export interface Binding {
  id: string;
  secret_id: string;
  host: string;
  path: string | null;
  method: string | null;
  header: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface SecretOptions {
  delivery?: Delivery;
  bindings?: BindingInput[];
}

export function listGlobalSecrets() {
  const rows = db.query<{ id: string; name: string; delivery: Delivery; created_at: string }, []>(
    "SELECT id, name, delivery, created_at FROM secrets WHERE project_id IS NULL ORDER BY name",
  ).all();
  return rows.map((r) => ({ ...r, bindings: listBindings(r.id) }));
}

export function createGlobalSecret(name: string, value: string, opts: SecretOptions = {}) {
  return insertSecret(null, name, value, opts);
}

export function createProjectSecret(projectId: string, name: string, value: string, opts: SecretOptions = {}) {
  if (!getProject(projectId)) throw new Error("project not found");
  return insertSecret(projectId, name, value, opts);
}

function insertSecret(projectId: string | null, name: string, value: string, opts: SecretOptions) {
  if (!SECRET_NAME.test(name)) {
    throw new Error("secret name must be an env-var style identifier (A-Z, 0-9, _)");
  }
  const delivery = opts.delivery ?? "env";
  if (delivery !== "env" && delivery !== "proxy") throw new Error("delivery must be env or proxy");
  const bindings = (opts.bindings ?? []).map(validBinding);
  if (delivery === "proxy" && !bindings.length) {
    throw new Error("a proxy-delivered secret needs at least one host it may be sent to");
  }
  if (delivery === "env" && bindings.length) {
    throw new Error("bindings only apply to proxy-delivered secrets");
  }
  const id = crypto.randomUUID().slice(0, 8);
  db.transaction(() => {
    db.query("INSERT INTO secrets (id, project_id, name, value_enc, delivery) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, name, encrypt(value), delivery);
    for (const b of bindings) insertBinding(id, b);
  })();
  logEvent(projectId, "secret.create", `${name} (${projectId ? "project-specific" : "global"}, ${delivery})`);
  return { id, name, scope: projectId ? "project" : "global", delivery };
}

// ---- bindings: where a proxy secret's real value may go ----

export function listBindings(secretId: string): Binding[] {
  return db.query<Binding, [string]>(
    "SELECT * FROM secret_bindings WHERE secret_id = ? ORDER BY rowid", // insertion order
  ).all(secretId);
}

export function addBinding(secretId: string, input: BindingInput): Binding {
  const s = db.query<{ delivery: Delivery; project_id: string | null }, [string]>(
    "SELECT delivery, project_id FROM secrets WHERE id = ?",
  ).get(secretId);
  if (!s) throw new Error("secret not found");
  if (s.delivery !== "proxy") throw new Error("bindings only apply to proxy-delivered secrets");
  const id = insertBinding(secretId, validBinding(input));
  logEvent(s.project_id, "secret.bind", `${secretId} → ${input.host}`);
  return db.query<Binding, [string]>("SELECT * FROM secret_bindings WHERE id = ?").get(id)!;
}

export function deleteBinding(secretId: string, bindingId: string): void {
  const n = db.query("DELETE FROM secret_bindings WHERE id = ? AND secret_id = ? RETURNING id")
    .all(bindingId, secretId).length;
  if (!n) throw new Error("binding not found");
}

function insertBinding(secretId: string, b: Required<BindingInput>): string {
  const id = crypto.randomUUID().slice(0, 8);
  db.query(
    `INSERT INTO secret_bindings (id, secret_id, host, path, method, header, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, secretId, b.host, b.path, b.method, b.header, b.expiresAt);
  return id;
}

/** Normalize a binding, or throw saying what is wrong with it. A binding is
 *  deliberately narrower than a net rule: no bare "*", no "*.com". */
function validBinding(input: BindingInput): Required<BindingInput> {
  const host = normalizeHost(input.host ?? "");
  if (!host) throw new Error("a binding needs a host (e.g. api.github.com or *.github.com)");
  if (host === "*") throw new Error("a secret can't be bound to every host — name the hosts it belongs to");
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  if (bare.includes("*")) throw new Error(`bad host pattern: ${host} (use exact or *.domain)`);
  if (host.startsWith("*.") && !bare.includes(".")) throw new Error(`host pattern too broad: ${host}`);

  const path = input.path?.trim() || null;
  if (path && (!path.startsWith("/") || path.slice(0, -1).includes("*"))) {
    throw new Error(`bad path: ${path} (an exact path, or a prefix ending in *)`);
  }
  const method = input.method?.trim().toUpperCase() || null;
  if (method && !/^[A-Z]+$/.test(method)) throw new Error(`bad method: ${method}`);
  const header = input.header?.trim().toLowerCase() || null;
  if (header && !/^[a-z0-9-]+$/.test(header)) throw new Error(`bad header name: ${header}`);
  const expiresAt = input.expiresAt || null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error(`bad expiry: ${expiresAt}`);
  return { host, path, method, header, expiresAt };
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
  dropPlaceholders(projectId); // before the secrets go: some rows point at globals
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
  const before = db.query<{ secret_id: string }, [string]>(
    "SELECT secret_id FROM project_secrets WHERE project_id = ?",
  ).all(projectId).map((r) => r.secret_id);
  // an unassigned secret's placeholder must stop meaning anything for this project
  dropPlaceholders(projectId, before.filter((sid) => !secretIds.includes(sid)));
  db.query("DELETE FROM project_secrets WHERE project_id = ?").run(projectId);
  const ins = db.query(
    "INSERT INTO project_secrets (project_id, secret_id, status) VALUES (?, ?, 'pending')",
  );
  for (const sid of secretIds) ins.run(projectId, sid);
}

export function projectSecretView(projectId: string) {
  const assigned = db.query(
    `SELECT s.id, s.name, s.delivery, ps.status FROM project_secrets ps
     JOIN secrets s ON s.id = ps.secret_id WHERE ps.project_id = ? ORDER BY s.name`,
  ).all(projectId) as { id: string; name: string; delivery: Delivery; status: string }[];
  const own = db.query(
    `SELECT id, name, delivery, created_at FROM secrets WHERE project_id = ? ORDER BY name`,
  ).all(projectId) as { id: string; name: string; delivery: Delivery; created_at: string }[];
  // a proxy secret shows the placeholder this VM holds (not sensitive) and its bindings
  const proxyInfo = (s: { id: string; delivery: Delivery }) => s.delivery === "proxy"
    ? { placeholder: existingPlaceholder(projectId, s.id), bindings: listBindings(s.id) }
    : {};
  return {
    assigned: assigned.map((a) => ({ ...a, ...proxyInfo(a) })),
    own: own.map((o) => ({ ...o, status: "injected", ...proxyInfo(o) })),
  };
}

/** Write (or rewrite) the project's env file: assigned globals first, then the
 *  project's own secrets — later lines win, so project-specific overrides global. */
export async function injectSecrets(projectId: string) {
  const p = getProject(projectId);
  if (!p) throw new Error("project not found");
  type Row = { id: string; name: string; value_enc: string; delivery: Delivery };
  const globals = db.query(
    `SELECT s.id, s.name, s.value_enc, s.delivery FROM project_secrets ps
     JOIN secrets s ON s.id = ps.secret_id WHERE ps.project_id = ? ORDER BY s.name`,
  ).all(projectId) as Row[];
  const own = db.query(
    `SELECT id, name, value_enc, delivery FROM secrets WHERE project_id = ? ORDER BY name`,
  ).all(projectId) as Row[];

  // a proxy secret's real value never leaves the supervisor: the VM gets its placeholder
  const lines = [...globals, ...own]
    .map((r) => {
      const real = decrypt(r.value_enc);
      return `${r.name}=${shellQuote(r.delivery === "proxy" ? placeholderFor(projectId, r.id, real) : real)}`;
    })
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
