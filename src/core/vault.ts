// Vault (docs/research/12): variables and secrets the VMs can use but not read.
// Every value is encrypted at rest (crypto.ts). An item is
//   a kind     variable — its value is shown in the UI
//              secret   — hidden, revealed on request (each reveal is logged)
//   a type     string | number | json (checked when the value is set)
//   a mode     proxy — the VM gets a placeholder; the egress proxy swaps in the
//                      real value on requests matching one of its bindings: in
//                      headers, and — if the item says so — in the URL and the
//                      request body
//              fetch — nothing in the VM; the app fetches it at runtime.
//                      `inEnv` also writes the real value into the VM's env
//                      file, as every secret was before the vault
// and the projects that may use it (project_secrets). A project refers to an
// item by its name, so a name is unique among one project's items — not
// across the vault.
import { config } from "../config";
import { decrypt, encrypt } from "../crypto";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { getProject, refFor } from "./projects";
import { dropItemPlaceholders, dropPlaceholders, existingPlaceholder, placeholderFor, prefixOf } from "./placeholders";
import { normalizeHost } from "../net/rules";

const driver = getDriver();

const ITEM_NAME = /^[A-Z][A-Z0-9_]*$/;

export type Kind = "variable" | "secret";
export type ValueType = "string" | "number" | "json";
export type Mode = "proxy" | "fetch";

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

export interface ItemInput {
  name: string;
  value: string;
  kind?: Kind;            // default secret
  type?: ValueType;       // default string
  mode?: Mode;            // default fetch
  inEnv?: boolean;        // fetch only; default false
  askOnFetch?: boolean;   // default: a secret asks, a variable does not
  swapUrl?: boolean;      // proxy: also swap in the URL (default off)
  swapBody?: boolean;     // proxy: also swap in request bodies (default off)
  bindings?: BindingInput[]; // used in proxy mode, which needs at least one
  projectIds?: string[];
}

export type ItemPatch = Partial<Omit<ItemInput, "bindings" | "projectIds">>;

interface ItemRow {
  id: string;
  name: string;
  kind: Kind;
  value_type: ValueType;
  delivery: Mode;
  in_env: number;
  ask_on_fetch: number;
  swap_url: number;
  swap_body: number;
  value_enc: string;
  created_at: string;
  updated_at: string | null;
}

const itemRow = (id: string) => db.query<ItemRow, [string]>("SELECT * FROM secrets WHERE id = ?").get(id);
const projectsOf = (id: string) => db.query<{ project_id: string }, [string]>(
  "SELECT project_id FROM project_secrets WHERE secret_id = ? ORDER BY project_id",
).all(id).map((r) => r.project_id);

/** How an item is shown: a variable with its value, a secret without. */
function view(r: ItemRow) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    type: r.value_type,
    mode: r.delivery,
    inEnv: !!r.in_env,
    askOnFetch: !!r.ask_on_fetch,
    swapUrl: !!r.swap_url,
    swapBody: !!r.swap_body,
    ...(r.kind === "variable" ? { value: decrypt(r.value_enc) } : {}),
    bindings: listBindings(r.id),
    projectIds: projectsOf(r.id),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
export type ItemView = ReturnType<typeof view>;

export function listItems(): ItemView[] {
  return db.query<ItemRow, []>("SELECT * FROM secrets ORDER BY name, created_at").all().map(view);
}

export function getItem(id: string): ItemView {
  const r = itemRow(id);
  if (!r) throw new Error("vault item not found");
  return view(r);
}

/** A secret's value, for the UI's eye icon. Logged: who looked is in the
 *  project-less event log with the item's name. */
export function revealItem(id: string): { value: string } {
  const r = itemRow(id);
  if (!r) throw new Error("vault item not found");
  logEvent(null, "vault.reveal", r.name);
  return { value: decrypt(r.value_enc) };
}

/** Check `value` against `type`; returns it as stored (json and numbers trimmed). */
function checkedValue(type: ValueType, value: unknown): string {
  if (typeof value !== "string") throw new Error("value must be a string");
  if (type === "number") {
    const v = value.trim();
    if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v) || !Number.isFinite(Number(v))) throw new Error(`not a number: ${value}`);
    return v;
  }
  if (type === "json") {
    try { JSON.parse(value); } catch (e) { throw new Error(`not valid JSON: ${(e as Error).message}`); }
    return value.trim();
  }
  return value;
}

function checkedShape(o: { name: string; kind: Kind; type: ValueType; mode: Mode; inEnv: boolean }) {
  if (!ITEM_NAME.test(o.name)) throw new Error("name must be an env-var style identifier (A-Z, 0-9, _)");
  if (o.kind !== "variable" && o.kind !== "secret") throw new Error("kind must be variable or secret");
  if (!["string", "number", "json"].includes(o.type)) throw new Error("type must be string, number or json");
  if (o.mode !== "proxy" && o.mode !== "fetch") throw new Error("mode must be proxy or fetch");
  if (o.inEnv && o.mode !== "fetch") throw new Error("only a fetch item can also be written to the env file");
}

/** A project refers to an item by name: refuse giving a project two of the same name. */
function checkNamesFree(name: string, projectIds: string[], exceptId: string | null) {
  const taken = db.query<{ project_id: string }, [string, string]>(
    `SELECT ps.project_id FROM project_secrets ps JOIN secrets s ON s.id = ps.secret_id
     WHERE s.name = ? AND s.id != ?`,
  ).all(name, exceptId ?? "");
  for (const { project_id } of taken) {
    if (projectIds.includes(project_id)) {
      throw new Error(`${getProject(project_id)?.name ?? project_id} already has a vault item named ${name}`);
    }
  }
}

function checkProjects(projectIds: string[]) {
  for (const pid of projectIds) {
    const p = getProject(pid);
    if (!p || p.state === "destroyed") throw new Error(`project not found: ${pid}`);
  }
}

export function createItem(input: ItemInput): ItemView {
  const kind = input.kind ?? "secret";
  const type = input.type ?? "string";
  const mode = input.mode ?? "fetch";
  const inEnv = !!input.inEnv;
  const name = String(input.name ?? "").trim();
  checkedShape({ name, kind, type, mode, inEnv });
  const value = checkedValue(type, input.value);
  const bindings = (input.bindings ?? []).map(validBinding);
  if (mode === "proxy" && !bindings.length) throw new Error("a proxy item needs at least one host it may be sent to");
  const projectIds = [...new Set(input.projectIds ?? [])];
  checkProjects(projectIds);
  checkNamesFree(name, projectIds, null);

  const id = crypto.randomUUID().slice(0, 8);
  db.transaction(() => {
    db.query(
      `INSERT INTO secrets (id, project_id, name, value_enc, delivery, kind, value_type, in_env, ask_on_fetch, swap_url, swap_body, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(id, name, encrypt(value), mode, kind, type, inEnv ? 1 : 0, (input.askOnFetch ?? kind === "secret") ? 1 : 0,
      input.swapUrl ? 1 : 0, input.swapBody ? 1 : 0);
    for (const b of bindings) insertBinding(id, b);
    const grant = db.query("INSERT INTO project_secrets (project_id, secret_id, status) VALUES (?, ?, 'pending')");
    for (const pid of projectIds) grant.run(pid, id);
  })();
  logEvent(null, "vault.create", `${name} (${kind}, ${type}, ${mode}${inEnv ? " + env" : ""})`);
  return getItem(id);
}

/** Change an item. The projects using it get their env file rewritten. */
export async function updateItem(id: string, patch: ItemPatch): Promise<ItemView> {
  const r = itemRow(id);
  if (!r) throw new Error("vault item not found");
  const name = patch.name != null ? String(patch.name).trim() : r.name;
  const kind = patch.kind ?? r.kind;
  const type = patch.type ?? r.value_type;
  const mode = patch.mode ?? r.delivery;
  // leaving fetch mode drops the env copy unless the patch says otherwise
  const inEnv = patch.inEnv ?? (mode === "fetch" ? !!r.in_env : false);
  checkedShape({ name, kind, type, mode, inEnv });
  const oldValue = decrypt(r.value_enc);
  // a new type is checked against the value it will have
  const value = checkedValue(type, patch.value ?? oldValue);
  if (mode === "proxy" && !listBindings(id).length) throw new Error("a proxy item needs at least one host it may be sent to — add one first");
  if (name !== r.name) checkNamesFree(name, projectsOf(id), id);

  db.query(
    `UPDATE secrets SET name = ?, kind = ?, value_type = ?, delivery = ?, in_env = ?, ask_on_fetch = ?,
       swap_url = ?, swap_body = ?, value_enc = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(name, kind, type, mode, inEnv ? 1 : 0, (patch.askOnFetch ?? !!r.ask_on_fetch) ? 1 : 0,
    (patch.swapUrl ?? !!r.swap_url) ? 1 : 0, (patch.swapBody ?? !!r.swap_body) ? 1 : 0,
    value === oldValue ? r.value_enc : encrypt(value), id);
  // a placeholder is shaped like the value it stands for (prefix, alphabet):
  // a value of another shape gets new ones, so tools sniffing a prefix still accept it
  if (value !== oldValue && prefixOf(value) !== prefixOf(oldValue)) dropItemPlaceholders(id);
  logEvent(null, "vault.update", `${r.name}${name !== r.name ? ` → ${name}` : ""}` +
    `${value !== oldValue ? " (value changed)" : ""}`);
  await reinject(projectsOf(id));
  return getItem(id);
}

export async function deleteItem(id: string): Promise<void> {
  const r = itemRow(id);
  if (!r) throw new Error("vault item not found");
  const affected = projectsOf(id);
  db.query("DELETE FROM secrets WHERE id = ?").run(id); // access, bindings, placeholders cascade
  logEvent(null, "vault.delete", r.name);
  await reinject(affected); // the value stops reaching new shells
}

/** Which projects may use an item: exactly these. */
export async function setItemProjects(id: string, projectIds: string[]): Promise<ItemView> {
  const r = itemRow(id);
  if (!r) throw new Error("vault item not found");
  const next = [...new Set(projectIds)];
  checkProjects(next);
  checkNamesFree(r.name, next, id);
  const before = projectsOf(id);
  db.transaction(() => {
    for (const pid of before.filter((p) => !next.includes(p))) {
      // a placeholder must stop meaning anything for a project without access
      dropPlaceholders(pid, [id]);
      db.query("DELETE FROM project_secrets WHERE project_id = ? AND secret_id = ?").run(pid, id);
    }
    const grant = db.query("INSERT OR IGNORE INTO project_secrets (project_id, secret_id, status) VALUES (?, ?, 'pending')");
    for (const pid of next) grant.run(pid, id);
  })();
  logEvent(null, "vault.access", `${r.name}: ${next.length} project(s)`);
  await reinject([...new Set([...before, ...next])]);
  return getItem(id);
}

/** Which items a project may use: exactly these (the env file is not
 *  rewritten here — callers that need it call injectVault). */
export function setProjectItems(projectId: string, itemIds: string[]) {
  const next = [...new Set(itemIds)];
  const names = new Map<string, string>();
  for (const sid of next) {
    const r = itemRow(sid);
    if (!r) throw new Error(`vault item not found: ${sid}`);
    if (names.has(r.name)) throw new Error(`two vault items are named ${r.name} — a project can use one of them`);
    names.set(r.name, sid);
  }
  const before = db.query<{ secret_id: string }, [string]>(
    "SELECT secret_id FROM project_secrets WHERE project_id = ?",
  ).all(projectId).map((r) => r.secret_id);
  db.transaction(() => {
    dropPlaceholders(projectId, before.filter((sid) => !next.includes(sid)));
    db.query("DELETE FROM project_secrets WHERE project_id = ?").run(projectId);
    const grant = db.query("INSERT INTO project_secrets (project_id, secret_id, status) VALUES (?, ?, 'pending')");
    for (const sid of next) grant.run(projectId, sid);
  })();
}

/** Destroy-time cleanup: the project loses its access and its placeholders.
 *  The items stay in the vault. */
export function purgeProjectVault(projectId: string) {
  dropPlaceholders(projectId);
  const n = db.query("DELETE FROM project_secrets WHERE project_id = ? RETURNING secret_id").all(projectId).length;
  if (n) logEvent(projectId, "vault.purge", `access to ${n} item(s) removed`);
}

/** The items a project may use, with what its VM holds for each. */
export function projectVaultView(projectId: string) {
  const rows = db.query<ItemRow & { status: string }, [string]>(
    `SELECT s.*, ps.status FROM project_secrets ps JOIN secrets s ON s.id = ps.secret_id
     WHERE ps.project_id = ? ORDER BY s.name`,
  ).all(projectId);
  // a proxy item shows the placeholder this VM holds (not sensitive)
  return rows.map((r) => ({
    ...view(r),
    status: r.status,
    ...(r.delivery === "proxy" ? { placeholder: existingPlaceholder(projectId, r.id) } : {}),
  }));
}

async function reinject(projectIds: string[]) {
  for (const pid of projectIds) {
    const p = getProject(pid);
    if (p && p.state === "running") await injectVault(pid).catch((e) => logEvent(pid, "vault.inject.error", String(e)));
  }
}

/** Write (or rewrite) the project's env file. A proxy item is its placeholder
 *  (the real value never leaves the supervisor), a fetch item marked inEnv is
 *  its real value, any other fetch item is not in the file at all. */
export async function injectVault(projectId: string) {
  const p = getProject(projectId);
  if (!p) throw new Error("project not found");
  const rows = db.query<ItemRow, [string]>(
    `SELECT s.* FROM project_secrets ps JOIN secrets s ON s.id = ps.secret_id
     WHERE ps.project_id = ? ORDER BY s.name`,
  ).all(projectId);
  const lines = rows.flatMap((r) => {
    if (r.delivery === "proxy") return [`${r.name}=${shellQuote(placeholderFor(projectId, r.id, decrypt(r.value_enc)))}`];
    if (r.in_env) return [`${r.name}=${shellQuote(decrypt(r.value_enc))}`];
    return [];
  });
  const r = await driver.execWithStdin(
    refFor(p.name),
    `mkdir -p $(dirname ${config.guestSecretsFile}) && umask 077 && cat > ${config.guestSecretsFile}`,
    new TextEncoder().encode(lines.join("\n") + "\n"),
  );
  if (r.exitCode !== 0) throw new Error(`vault injection failed: ${r.stderr}`);
  db.query("UPDATE project_secrets SET status = 'injected' WHERE project_id = ?").run(projectId);
  logEvent(projectId, "vault.inject", `${lines.length} of ${rows.length} item(s) in the env file`);
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

// ---- bindings: where a proxy item's real value may go ----
// Any item can have them, so an item can be given its hosts before it is
// switched to proxy mode; only proxy mode uses them.

export function listBindings(secretId: string): Binding[] {
  return db.query<Binding, [string]>(
    "SELECT * FROM secret_bindings WHERE secret_id = ? ORDER BY rowid", // insertion order
  ).all(secretId);
}

export function addBinding(secretId: string, input: BindingInput): Binding {
  const s = db.query<{ name: string }, [string]>("SELECT name FROM secrets WHERE id = ?").get(secretId);
  if (!s) throw new Error("vault item not found");
  const id = insertBinding(secretId, validBinding(input));
  logEvent(null, "vault.bind", `${s.name} → ${input.host}`);
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
  if (host === "*") throw new Error("a value can't be bound to every host — name the hosts it belongs to");
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
