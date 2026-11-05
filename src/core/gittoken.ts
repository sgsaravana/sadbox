// A git remote's access token, kept as a proxy vault item (docs/research/11).
//
// The token given for a project's remote (the create form, the Git remote
// dialog) becomes a vault item the project has access to: GITHUB_TOKEN bound to
// GitHub's hosts, GITLAB_TOKEN to gitlab.com, or GIT_TOKEN to the remote's own
// host. The VM holds only its placeholder: git's credential helper (net/guest.ts)
// hands that to git, the proxy swaps in the real token, and the binding lets
// the clone through (net/rules.ts). An item with the same name and value is
// reused rather than copied.
//
// Before this, the token was written into the VM's ~/.git-credentials, real.
// A project that still has one stored (projects.git_token_enc) is moved over by
// migrateGitToken: the token goes to the vault, the VM's copy is deleted, and
// the column is cleared once that is done.
import { db, logEvent } from "../db";
import { decrypt } from "../crypto";
import { getDriver } from "../driver";
import { hostMatch } from "../net/rules";
import { addBinding, createItem, getItem, listBindings, setItemProjects, updateItem } from "./vault";
import { getProject, refFor, type ProjectRow } from "./projects";

const driver = getDriver();

export function remoteHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return url.replace(/^https?:\/\//, "").split(/[/:]/)[0].toLowerCase(); }
}

/** The item a token for this remote becomes: its name and the hosts it is bound to. */
export function tokenShape(remote: string): { name: string; hosts: string[] } {
  const host = remoteHost(remote);
  if (host === "github.com") return { name: "GITHUB_TOKEN", hosts: ["github.com", "api.github.com", "uploads.github.com"] };
  if (host === "gitlab.com") return { name: "GITLAB_TOKEN", hosts: ["gitlab.com"] };
  return { name: "GIT_TOKEN", hosts: [host] };
}

interface ItemRow { id: string; value_enc: string }

/** Proxy items of this name holding this value. */
function sameItems(name: string, token: string): string[] {
  return db.query<ItemRow, [string]>("SELECT id, value_enc FROM secrets WHERE name = ? AND delivery = 'proxy' ORDER BY created_at")
    .all(name).filter((r) => decrypt(r.value_enc) === token).map((r) => r.id);
}

/** Add whichever of `hosts` the item is not bound to yet. */
function ensureBindings(id: string, hosts: string[]) {
  const have = new Set(listBindings(id).filter((b) => !b.path && !b.method && !b.header && !b.expires_at).map((b) => b.host));
  for (const h of hosts) if (!have.has(h)) addBinding(id, { host: h });
}

/** The vault item for this token (reused when one has the same name and
 *  value, else made), bound to the remote's hosts. Gives no project access. */
export function gitTokenItem(remote: string, token: string): string {
  const { name, hosts } = tokenShape(remote);
  const [same] = sameItems(name, token);
  if (same) { ensureBindings(same, hosts); return same; }
  const item = createItem({ name, value: token, kind: "secret", mode: "proxy", bindings: hosts.map((host) => ({ host })) });
  logEvent(null, "vault.git", `${name} made from a git remote's token (${hosts.join(", ")})`);
  return item.id;
}

/** For a project about to be created with these vault items: the id of the
 *  token's item, to add to them. One of the chosen items with the token's name
 *  stands in for it when it holds the same token; a different one is refused
 *  (a project has one item per name). */
export function gitTokenForCreate(remote: string, token: string, itemIds: string[]): string {
  const { name, hosts } = tokenShape(remote);
  const chosen = itemIds.map((id) => db.query<ItemRow & { name: string }, [string]>("SELECT id, name, value_enc FROM secrets WHERE id = ?").get(id))
    .find((r) => r?.name === name);
  if (chosen) {
    if (decrypt(chosen.value_enc) !== token) throw new Error(`the project is also given vault item ${name}, holding another token — choose one of them`);
    ensureBindings(chosen.id, hosts);
    return chosen.id;
  }
  return gitTokenItem(remote, token);
}

/** Give a project this token for its remote. The project's item of that name
 *  gets the new value when no other project uses it; otherwise the project is
 *  moved to an item holding the token (reused or made), and the others keep theirs. */
export async function setProjectGitToken(projectId: string, remote: string, token: string): Promise<string> {
  const { name, hosts } = tokenShape(remote);
  const current = db.query<ItemRow, [string, string]>(
    `SELECT s.id, s.value_enc FROM secrets s JOIN project_secrets ps ON ps.secret_id = s.id
     WHERE ps.project_id = ? AND s.name = ?`,
  ).get(projectId, name);
  if (current && decrypt(current.value_enc) === token) { ensureBindings(current.id, hosts); return current.id; }
  if (current && getItem(current.id).projectIds.length === 1) {
    const item = getItem(current.id);
    if (item.mode === "proxy") {
      ensureBindings(current.id, hosts);
      await updateItem(current.id, { value: token });
      logEvent(projectId, "vault.git", `${name}: new token`);
      return current.id;
    }
  }
  if (current) await setItemProjects(current.id, getItem(current.id).projectIds.filter((p) => p !== projectId));
  const id = gitTokenItem(remote, token);
  await setItemProjects(id, [...new Set([...getItem(id).projectIds, projectId])]);
  logEvent(projectId, "vault.git", `${name} for ${remoteHost(remote)}`);
  return id;
}

/** Does the project have a proxy item git would be given for its remote? */
export function hasGitToken(p: Pick<ProjectRow, "id" | "git_remote" | "git_token_enc">): boolean {
  if (!p.git_remote) return false;
  if (p.git_token_enc) return true; // not moved to the vault yet
  const host = remoteHost(p.git_remote);
  const now = Date.now();
  return db.query<{ host: string; expires_at: string | null }, [string]>(
    `SELECT b.host, b.expires_at FROM secret_bindings b JOIN secrets s ON s.id = b.secret_id
     JOIN project_secrets ps ON ps.secret_id = s.id
     WHERE ps.project_id = ? AND s.delivery = 'proxy' AND s.value_type = 'string' AND b.method IS NULL`,
  ).all(p.id).some((b) => (!b.expires_at || Date.parse(b.expires_at) > now) && hostMatch(b.host, host));
}

/** What sadbox once wrote into the VM for the token, taken out again. */
const CLEANUP = (host: string) =>
  `rm -f ~/.git-credentials; ` +
  `[ "$(git config --global credential.helper)" = store ] && git config --global --unset credential.helper; ` +
  `git config --global --unset-all credential.https://${host}.username; true`;

/** Move a project's stored token to the vault (see the top of this file).
 *  `fresh`: its VM was just made and holds no copy. A VM that is not running
 *  keeps its copy until it starts, so the column stays set until then. */
export async function migrateGitToken(p: ProjectRow, opts: { fresh?: boolean } = {}): Promise<void> {
  if (!p.git_token_enc || !p.git_remote) return;
  await setProjectGitToken(p.id, p.git_remote, decrypt(p.git_token_enc));
  if (!opts.fresh) {
    const ref = refFor(p.name);
    if ((await driver.inspect(ref)).state !== "running") return;
    const r = await driver.exec(ref, ["sh", "-c", CLEANUP(remoteHost(p.git_remote))]);
    if (r.exitCode !== 0) throw new Error(`could not remove the VM's ~/.git-credentials: ${r.stderr}`);
  }
  db.query("UPDATE projects SET git_token_enc = NULL WHERE id = ?").run(p.id);
  logEvent(p.id, "vault.git.migrate", `token moved to the vault as ${tokenShape(p.git_remote).name}; the VM holds a placeholder`);
}

/** At startup: every project with a stored token. Best effort, one by one. */
export async function migrateGitTokens(): Promise<void> {
  const ids = db.query<{ id: string }, []>("SELECT id FROM projects WHERE git_token_enc IS NOT NULL AND state != 'destroyed'").all();
  for (const { id } of ids) {
    const p = getProject(id);
    if (p) await migrateGitToken(p).catch((e) => logEvent(id, "vault.git.migrate.error", String(e)));
  }
}
