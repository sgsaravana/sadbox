// Agent logins kept by the supervisor (docs/research/13, A4 / A7), so a new,
// rebuilt or started VM is logged in without logging in again.
//
//   - API-key logins (omp's `auth_credentials` api_key rows, opencode's
//     auth.json `api` entries) are captured from running VMs — about every
//     30 s, the newest login wins — and copied into a VM when it is created,
//     rebuilt or started, or on "Apply to running VMs". They are readable in
//     the VM (A5: omp and opencode need the real key there).
//   - Claude's OAuth login is owned by sadbox (A7, net/claudeoauth.ts): a VM
//     gets placeholders in ~/.claude/.credentials.json. A VM found holding a
//     real Claude login (one from before this) has it taken over: kept by
//     sadbox, unless sadbox already has a working one, and replaced in the VM
//     by placeholders at once.
//   - OAuth logins of omp and opencode are not shared: a copy would be revoked
//     by the first refresh of another (F.3), and sadbox does not own them (yet).
//
// The guest side is a bun script fed on stdin, so no secret is ever on a
// command line in the VM.
import { createHash } from "crypto";
import { config } from "../config";
import { db, logEvent } from "../db";
import { decrypt, encrypt } from "../crypto";
import { getDriver } from "../driver";
import { prefixOf } from "./placeholders";
import {
  CLAUDE_LOGIN_NAME, CLAUDE_PROVIDER, CLAUDE_TOOL, claudeLogin, claudePlaceholders, forgetClaude,
  isLoginPlaceholder, noteClaudeDetails, saveClaudeLogin, vmOauth,
} from "../net/claudeoauth";

const enc = (s: string) => new TextEncoder().encode(s);
const hash = (tool: string, provider: string, data: unknown) =>
  createHash("sha256").update(`${tool}\0${provider}\0${JSON.stringify(data)}`).digest("hex");

// ---- the guest side ----------------------------------------------------------

/** Prints the VM's logins as JSON. Read-only. */
export const READ_JS = `const fs = require("fs"), H = process.env.HOME, out = {};
const read = (p) => { try { return JSON.parse(fs.readFileSync(H + p, "utf8")); } catch { return null; } };
out.claude = read("/.claude/.credentials.json");
out.opencode = read("/.local/share/opencode/auth.json");
try {
  const p = H + "/.omp/agent/agent.db";
  if (fs.existsSync(p)) {
    const { Database } = require("bun:sqlite");
    const d = new Database(p, { readonly: true });
    out.omp = d.query("SELECT provider, credential_type AS type, data FROM auth_credentials WHERE disabled_cause IS NULL").all();
    d.close();
  }
} catch (e) { out.ompError = String(e).slice(0, 300); }
console.log(JSON.stringify(out));
`;

/** Writes the logins in P into the VM, leaving everything else as it was.
 *  omp's logins go in through omp's own credential store (it owns the schema). */
export const WRITE_JS = `const fs = require("fs"), path = require("path"), H = process.env.HOME, out = {};
const P = JSON.parse(Buffer.from("__PAYLOAD__", "base64").toString("utf8"));
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const write = (p, j) => {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const t = p + ".sadbox-tmp";
  fs.writeFileSync(t, JSON.stringify(j, null, 2), { mode: 0o600 });
  fs.renameSync(t, p);
};
if (P.claude) {
  const f = H + "/.claude/.credentials.json", j = read(f), o = j.claudeAiOauth || {};
  const same = o.accessToken === P.claude.accessToken && o.refreshToken === P.claude.refreshToken
    && o.subscriptionType === P.claude.subscriptionType && o.expiresAt > Date.now() + 365 * 864e5;
  if (!same) { j.claudeAiOauth = P.claude; write(f, j); }
  out.claude = same ? "current" : "written";
}
if (P.opencode) {
  const f = H + "/.local/share/opencode/auth.json", j = read(f), done = [];
  for (const [k, v] of Object.entries(P.opencode)) {
    if (j[k] && j[k].type !== "api") continue; // the VM's own OAuth login for it stays
    if (JSON.stringify(j[k]) !== JSON.stringify(v)) { j[k] = v; done.push(k); }
  }
  if (done.length) write(f, j);
  out.opencode = done;
}
if (P.omp && P.omp.length) {
  try {
    const m = await import(H + "/.bun/install/global/node_modules/@oh-my-pi/pi-ai/src/auth/sqlite-credential-store.ts");
    const s = await m.SqliteAuthCredentialStore.open(), done = [];
    for (const e of P.omp) {
      if (s.getOAuth(e.provider)) continue; // the VM's own OAuth login for it stays
      if (s.getApiKey(e.provider) === e.key) continue;
      await s.replaceAuthCredentials(e.provider, [{ type: "api_key", key: e.key, ...(e.source ? { source: e.source } : {}) }]);
      done.push(e.provider);
    }
    if (s.close) s.close();
    out.omp = done;
  } catch (e) { out.ompError = String(e).slice(0, 300); }
}
console.log(JSON.stringify(out));
`;

async function runGuest(ref: string, script: string): Promise<any> {
  const r = await getDriver().execWithStdin(ref, `exec ${config.guestBun} run -`, enc(script), { timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  const line = r.stdout.trim().split("\n").pop() || "{}";
  return JSON.parse(line);
}

// ---- the store ---------------------------------------------------------------

interface ApiLogin { tool: "omp" | "opencode"; provider: string; data: Record<string, unknown> }
interface LoginRow { tool: string; provider: string; kind: string; data_enc: string; from_project: string | null; captured_at: string; expires_at: number | null; refreshed_at: number | null; status: string | null }

function apiLogins(): ApiLogin[] {
  return db.query<LoginRow, []>("SELECT * FROM agent_logins WHERE kind = 'api' ORDER BY tool, provider").all()
    .map((r) => ({ tool: r.tool as ApiLogin["tool"], provider: r.provider, data: JSON.parse(decrypt(r.data_enc)) }));
}

function seen(projectId: string, tool: string, provider: string): string | null {
  return db.query<{ hash: string }, [string, string, string]>(
    "SELECT hash FROM login_seen WHERE project_id = ? AND tool = ? AND provider = ?").get(projectId, tool, provider)?.hash ?? null;
}
function setSeen(projectId: string, tool: string, provider: string, h: string) {
  db.query(`INSERT INTO login_seen (project_id, tool, provider, hash) VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, tool, provider) DO UPDATE SET hash = excluded.hash`).run(projectId, tool, provider, h);
}

/** The API-key logins a VM holds, as the store keeps them. */
function vmApiLogins(out: any): ApiLogin[] {
  const list: ApiLogin[] = [];
  for (const r of Array.isArray(out.omp) ? out.omp : []) {
    if (r?.type !== "api_key" || typeof r.provider !== "string") continue;
    try {
      const d = JSON.parse(r.data);
      if (typeof d?.key === "string" && d.key) list.push({ tool: "omp", provider: r.provider, data: { key: d.key, ...(d.source ? { source: d.source } : {}) } });
    } catch {}
  }
  if (out.opencode && typeof out.opencode === "object") {
    for (const [k, v] of Object.entries(out.opencode as Record<string, any>)) {
      if (v?.type === "api" && typeof v.key === "string" && v.key) list.push({ tool: "opencode", provider: k, data: v });
    }
  }
  return list;
}

/** Shaped like a sadbox placeholder (prefix, then "sbx"): one that is no longer
 *  in use, say — never mistaken for a real login. */
const placeholderShaped = (t: string) => t.startsWith(prefixOf(t) + "sbx");

export interface Project { id: string; name: string }
const refOf = (p: Project) => `sadbox-${p.name}`;

/** Look at a running VM's logins: a new API-key login there becomes the one
 *  kept; a real Claude login there is taken over. Returns whether the VM needs
 *  its Claude login replaced by placeholders. */
export async function captureLogins(p: Project): Promise<{ captured: string[]; replaceClaude: boolean }> {
  const out = await runGuest(refOf(p), READ_JS);
  const captured: string[] = [];

  for (const l of vmApiLogins(out)) {
    const h = hash(l.tool, l.provider, l.data);
    if (seen(p.id, l.tool, l.provider) === h) continue; // as sadbox left it
    const row = db.query<LoginRow, [string, string]>("SELECT * FROM agent_logins WHERE tool = ? AND provider = ?").get(l.tool, l.provider);
    if (!row || hash(l.tool, l.provider, JSON.parse(decrypt(row.data_enc))) !== h) {
      db.query(`INSERT INTO agent_logins (tool, provider, kind, data_enc, from_project, captured_at)
                VALUES (?, ?, 'api', ?, ?, datetime('now'))
                ON CONFLICT(tool, provider) DO UPDATE SET kind = 'api', data_enc = excluded.data_enc,
                  from_project = excluded.from_project, captured_at = excluded.captured_at, status = NULL`)
        .run(l.tool, l.provider, encrypt(JSON.stringify(l.data)), p.name);
      logEvent(p.id, "login.capture", `${l.tool} (${l.provider}): API key kept by sadbox`);
      captured.push(`${l.tool}:${l.provider}`);
    }
    setSeen(p.id, l.tool, l.provider, h);
  }

  let replaceClaude = false;
  const o = out.claude?.claudeAiOauth;
  if (o && typeof o === "object") {
    const token = typeof o.accessToken === "string" ? o.accessToken : "";
    const kept = db.query<{ status: string | null }, [string, string]>(
      "SELECT status FROM agent_logins WHERE tool = ? AND provider = ?").get(CLAUDE_TOOL, CLAUDE_PROVIDER);
    const working = !!kept && !kept.status?.startsWith("refresh refused");
    const mine = kept ? claudePlaceholders(p.id) : null;
    if (mine && token === mine.access) {
      noteClaudeDetails(o); // what the VM's Claude learnt about the account
    } else if (token && !isLoginPlaceholder(token) && !placeholderShaped(token) && typeof o.refreshToken === "string" && o.refreshToken) {
      // a real login in the VM: one from before sadbox owned Claude's login
      if (!working) {
        saveClaudeLogin({
          accessToken: token, refreshToken: o.refreshToken, expiresAt: Number(o.expiresAt) || 0,
          scopes: Array.isArray(o.scopes) ? o.scopes : undefined, subscriptionType: o.subscriptionType ?? null,
          ...(o.rateLimitTier !== undefined ? { rateLimitTier: o.rateLimitTier } : {}),
        }, p.name);
        logEvent(p.id, "login.capture", `${CLAUDE_LOGIN_NAME}: taken over from this VM — sadbox keeps and refreshes it, the VM holds placeholders`);
        captured.push(`${CLAUDE_TOOL}:${CLAUDE_PROVIDER}`);
      } else {
        logEvent(p.id, "login.replace", `${CLAUDE_LOGIN_NAME}: this VM's own login is replaced by the one sadbox keeps`);
      }
      replaceClaude = true;
    } else if (working) {
      // someone else's placeholders, or emptied (Claude does that after a
      // refused refresh): sadbox has a working login again, so back it goes
      replaceClaude = true;
    }
  }
  return { captured, replaceClaude };
}

/** Put the kept logins into a running VM. Returns what was written. */
export async function applyLogins(p: Project): Promise<string[]> {
  const claude = claudeLogin() ? vmOauth(p.id) : null;
  const api = apiLogins();
  const payload: Record<string, unknown> = {};
  if (claude) payload.claude = claude;
  const oc = api.filter((l) => l.tool === "opencode");
  if (oc.length) payload.opencode = Object.fromEntries(oc.map((l) => [l.provider, l.data]));
  const omp = api.filter((l) => l.tool === "omp");
  if (omp.length) payload.omp = omp.map((l) => ({ provider: l.provider, ...l.data }));
  if (!Object.keys(payload).length) return [];

  const out = await runGuest(refOf(p), WRITE_JS.replace("__PAYLOAD__", Buffer.from(JSON.stringify(payload)).toString("base64")));
  const wrote: string[] = [];
  if (out.claude === "written") wrote.push(CLAUDE_LOGIN_NAME);
  for (const k of out.opencode ?? []) wrote.push(`opencode (${k})`);
  for (const k of out.omp ?? []) wrote.push(`omp (${k})`);
  // the VM now holds what sadbox keeps: not a new login of its own
  for (const l of oc) setSeen(p.id, l.tool, l.provider, hash(l.tool, l.provider, l.data));
  if (!out.ompError) for (const l of omp) setSeen(p.id, l.tool, l.provider, hash(l.tool, l.provider, l.data));
  if (out.ompError) logEvent(p.id, "login.apply.error", `omp: ${out.ompError}`);
  if (wrote.length) logEvent(p.id, "login.apply", wrote.join(", "));
  return wrote;
}

/** Copy-in at create / rebuild / start: never fails the caller. */
export async function applyLoginsQuietly(p: Project): Promise<void> {
  await applyLogins(p).catch((e) => logEvent(p.id, "login.apply.error", String(e)));
}

const runningProjects = () => db.query<Project, []>("SELECT id, name FROM projects WHERE state = 'running'").all();

/** "Apply to running VMs". */
export async function applyToRunning(): Promise<{ project: string; wrote?: string[]; error?: string }[]> {
  const res = [];
  for (const p of runningProjects()) {
    try { res.push({ project: p.name, wrote: await applyLogins(p) }); }
    catch (e) { res.push({ project: p.name, error: e instanceof Error ? e.message : String(e) }); }
  }
  return res;
}

let ticking = false;
/** One pass over the running VMs. */
export async function loginTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const p of runningProjects()) {
      try {
        const r = await captureLogins(p);
        if (r.replaceClaude) await applyLogins(p);
      } catch {} // a VM that does not answer is looked at next time
    }
  } finally { ticking = false; }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startLoginLoop(): void {
  if (timer) return;
  timer = setInterval(() => { loginTick().catch(() => {}); }, 30_000);
}

// ---- for the Agents page -----------------------------------------------------

export interface LoginView {
  tool: string;
  provider: string;
  kind: "api" | "oauth";
  /** How VMs get it. */
  shared: "copied" | "placeholders";
  fromProject: string | null;
  capturedAt: string;
  expiresAt: number | null;
  refreshedAt: number | null;
  status: string | null;
}

export function listLogins(): LoginView[] {
  return db.query<LoginRow, []>("SELECT * FROM agent_logins ORDER BY tool, provider").all().map((r) => ({
    tool: r.tool, provider: r.provider, kind: r.kind as LoginView["kind"], shared: r.kind === "oauth" ? "placeholders" : "copied",
    fromProject: r.from_project, capturedAt: r.captured_at, expiresAt: r.expires_at, refreshedAt: r.refreshed_at, status: r.status,
  }));
}

/** Forget a login. A copied API key stays in the VMs that have it; Claude's
 *  placeholders stop working everywhere. */
export function forgetLogin(tool: string, provider: string): boolean {
  const had = !!db.query("SELECT 1 FROM agent_logins WHERE tool = ? AND provider = ?").get(tool, provider);
  if (tool === CLAUDE_TOOL && provider === CLAUDE_PROVIDER) forgetClaude();
  else db.query("DELETE FROM agent_logins WHERE tool = ? AND provider = ?").run(tool, provider);
  db.query("DELETE FROM login_seen WHERE tool = ? AND provider = ?").run(tool, provider);
  if (had) logEvent(null, "login.forget", `${tool} (${provider})`);
  return had;
}

/** A destroyed project's placeholders and bookkeeping go with it. */
export function purgeProjectLogins(projectId: string): void {
  db.query("DELETE FROM login_placeholders WHERE project_id = ?").run(projectId);
  db.query("DELETE FROM login_seen WHERE project_id = ?").run(projectId);
}
