// Spike F.5 — the supervisor owns a Claude OAuth login (docs/research/13, A7).
// Runs against the real sadbox data dir and the running supervisor's proxy,
// for one project. Real tokens only ever sit in this process and in sadbox's
// encrypted secrets table; nothing here prints one (fingerprints only).
//
//   bun spikes/f-agent-sessions/oauth-owner.ts take    <project>   VM login → sadbox; VM gets placeholders
//   bun spikes/f-agent-sessions/oauth-owner.ts refresh <project>   sadbox refreshes; VM untouched
//   bun spikes/f-agent-sessions/oauth-owner.ts place   <project>   (re)write the VM's login with placeholders
//   bun spikes/f-agent-sessions/oauth-owner.ts status  <project>   fingerprints + expiry
//   bun spikes/f-agent-sessions/oauth-owner.ts drop    <project>   delete the two spike secrets
//
// Reuses proxy-delivered secrets as they are today: CLAUDE_OAUTH_ACCESS is
// swapped into the Authorization header toward api.anthropic.com. The refresh
// token is a second secret only so it has a placeholder (today's proxy swaps
// headers, not bodies — a VM's own refresh is expected to fail, F.5 step 3).
import { createHash } from "crypto";
import { db } from "../../src/db";
import { decrypt, encrypt } from "../../src/crypto";
import { getDriver } from "../../src/driver";
import { createItem, deleteItem, injectVault } from "../../src/core/vault";
import { existingPlaceholder } from "../../src/core/placeholders";
import { refFor } from "../../src/core/projects";

// from the claude binary (container 1.4.1 image, Claude Code 2.1.x)
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ACCESS = "CLAUDE_OAUTH_ACCESS", REFRESH = "CLAUDE_OAUTH_REFRESH";
const CREDS = "/home/agent/.claude/.credentials.json";
const FAR = 10 * 365 * 864e5; // the VM's copy never looks expired

const driver = getDriver();
const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const [cmd, name] = process.argv.slice(2);
const project = db.query<{ id: string; name: string }, [string]>("SELECT id, name FROM projects WHERE name = ? AND state != 'destroyed'").get(name ?? "");
if (!project) throw new Error(`usage: ${cmd ?? "<take|refresh|status|drop>"} <project name> — no such project`);
const ref = refFor(project.name);

const secret = (n: string) => db.query<{ id: string; value_enc: string }, [string, string]>(
  `SELECT s.id, s.value_enc FROM secrets s JOIN project_secrets ps ON ps.secret_id = s.id
   WHERE ps.project_id = ? AND s.name = ?`).get(project.id, n);

async function readVmCreds(): Promise<any> {
  const r = await driver.exec(ref, ["cat", CREDS]);
  if (r.exitCode !== 0) throw new Error(`no Claude login in the VM: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

async function writeVmCreds(j: any) {
  const r = await driver.execWithStdin(ref, `umask 077 && cat > ${CREDS}.tmp && mv ${CREDS}.tmp ${CREDS}`, new TextEncoder().encode(JSON.stringify(j)));
  if (r.exitCode !== 0) throw new Error(`could not write the VM's login: ${r.stderr.trim()}`);
}

if (cmd === "take") {
  if (secret(ACCESS)) throw new Error("already taken — `drop` first");
  const j = await readVmCreds();
  const o = j.claudeAiOauth;
  if (!o?.accessToken || !o?.refreshToken) throw new Error("the VM's login has no OAuth tokens");
  if (String(o.accessToken).includes("sbx")) throw new Error("the VM already holds placeholders");
  const a = createItem({ name: ACCESS, value: o.accessToken, mode: "proxy", bindings: [{ host: "api.anthropic.com", header: "authorization" }], projectIds: [project.id] });
  const r = createItem({ name: REFRESH, value: o.refreshToken, mode: "proxy", bindings: [{ host: "platform.claude.com", path: "/v1/oauth/token" }], projectIds: [project.id] });
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`spike-f5:${project.id}:expiresAt`, String(o.expiresAt));
  await injectVault(project.id); // makes the placeholders
  const pa = existingPlaceholder(project.id, a.id)!, pr = existingPlaceholder(project.id, r.id)!;
  await writeVmCreds({ ...j, claudeAiOauth: { ...o, accessToken: pa, refreshToken: pr, expiresAt: Date.now() + FAR } });
  console.log(`taken: real access ${fp(o.accessToken)} refresh ${fp(o.refreshToken)} → VM placeholders ${pa.slice(0, 16)}… / ${pr.slice(0, 16)}…`);
} else if (cmd === "place") {
  // after Claude in the VM wiped its login (a failed refresh of its own does that)
  const a = secret(ACCESS), r = secret(REFRESH);
  if (!a || !r) throw new Error("not taken");
  const j = await readVmCreds().catch(() => ({}));
  await writeVmCreds({ ...j, claudeAiOauth: { ...(j.claudeAiOauth ?? {}), accessToken: existingPlaceholder(project.id, a.id), refreshToken: existingPlaceholder(project.id, r.id),
    expiresAt: Date.now() + FAR, scopes: j.claudeAiOauth?.scopes ?? ["user:inference", "user:profile"], subscriptionType: j.claudeAiOauth?.subscriptionType ?? null } });
  console.log("placed placeholders in the VM");
} else if (cmd === "refresh") {
  const r = secret(REFRESH), a = secret(ACCESS);
  if (!r || !a) throw new Error("not taken");
  const res = await fetch(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: decrypt(r.value_enc), client_id: CLIENT_ID }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`refresh failed: HTTP ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`);
  db.query("UPDATE secrets SET value_enc = ? WHERE id = ?").run(encrypt(body.access_token), a.id);
  if (body.refresh_token) db.query("UPDATE secrets SET value_enc = ? WHERE id = ?").run(encrypt(body.refresh_token), r.id);
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`spike-f5:${project.id}:expiresAt`, String(Date.now() + (body.expires_in ?? 0) * 1000));
  console.log(`refreshed: access ${fp(decrypt(a.value_enc))} → ${fp(body.access_token)}, refresh rotated: ${!!body.refresh_token && body.refresh_token !== decrypt(r.value_enc)}, ` +
    `expires_in ${body.expires_in}s, response fields: ${Object.keys(body).join(",")}`);
} else if (cmd === "status") {
  const a = secret(ACCESS), r = secret(REFRESH);
  const at = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(`spike-f5:${project.id}:expiresAt`);
  const vm = (await readVmCreds()).claudeAiOauth;
  console.log(a && r
    ? `sadbox holds access ${fp(decrypt(a.value_enc))} refresh ${fp(decrypt(r.value_enc))}, expires in ${((Number(at?.value) - Date.now()) / 36e5).toFixed(2)} h`
    : "not taken");
  console.log(`VM holds access ${String(vm.accessToken).slice(0, 16)}… (placeholder: ${String(vm.accessToken).includes("sbx")}), expires in ${((vm.expiresAt - Date.now()) / 864e5).toFixed(0)} days`);
} else if (cmd === "drop") {
  for (const n of [ACCESS, REFRESH]) { const s = secret(n); if (s) await deleteItem(s.id); }
  db.query("DELETE FROM settings WHERE key = ?").run(`spike-f5:${project.id}:expiresAt`);
  await injectVault(project.id);
  console.log("dropped (the VM's login file still holds placeholders — log in again there to use Claude)");
} else {
  throw new Error("usage: take | refresh | status | drop <project name>");
}
