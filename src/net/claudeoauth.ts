// Claude's OAuth login, owned by the supervisor (docs/research/13, A7; Spike F.5).
//
// A refresh of a Claude login revokes every other copy of it at once (F.3), so
// the login can't be copied into VMs. Instead sadbox keeps the one real login
// and is the only one that refreshes it. Each VM holds placeholders shaped like
// the tokens, with an expiry years away, and:
//   - the proxy swaps the access placeholder for the current real token on
//     requests to api.anthropic.com (Authorization header only);
//   - Claude's token endpoint is answered here. A refresh with the VM's
//     placeholder gets the placeholders back (sadbox refreshes for real, at
//     most once a minute). Anything else — the code exchange of a `/login` in
//     the VM, or a refresh with a real token from a VM that had its own login
//     — is sent on by sadbox itself; the real tokens it gets back become the
//     login kept, and the VM is answered with its placeholders. Real tokens
//     never reach a VM.
// Real tokens appearing in any response to a VM are turned back into its
// placeholders too (credentials.ts).
import type { ServerResponse } from "node:http";
import { db, logEvent } from "../db";
import { decrypt, encrypt } from "../crypto";
import { makePlaceholder } from "../core/placeholders";

export const CLAUDE_TOOL = "claude";
export const CLAUDE_PROVIDER = "claude.ai";
export const CLAUDE_LOGIN_NAME = "Claude login";
// from the claude binary (Claude Code 2.1.x; research/13, F.5)
const DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_HOSTS = new Set(["platform.claude.com", "console.anthropic.com"]);
/** The hosts Claude sends its access token to (seen in F.5). */
export const CLAUDE_API_HOSTS = ["api.anthropic.com"];
/** How far off the expiry in a VM's copy is: it never refreshes on its own. */
const FAR_MS = 10 * 365 * 864e5;
/** sadbox refreshes this long before the access token runs out. */
const REFRESH_AHEAD_MS = 15 * 60_000;
/** A VM asking for a refresh gets one at most this often. */
const MIN_REFRESH_GAP_MS = 60_000;

export interface ClaudeLogin {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  clientId?: string;
  tokenUrl?: string;
  account?: unknown;
  organization?: unknown;
}

interface Row { data_enc: string; expires_at: number | null; refreshed_at: number | null; status: string | null; from_project: string | null }

export function claudeLogin(): ClaudeLogin | null {
  const r = db.query<Row, [string, string]>("SELECT * FROM agent_logins WHERE tool = ? AND provider = ?").get(CLAUDE_TOOL, CLAUDE_PROVIDER);
  return r ? JSON.parse(decrypt(r.data_enc)) : null;
}

function loginRow(): Row | null {
  return db.query<Row, [string, string]>("SELECT * FROM agent_logins WHERE tool = ? AND provider = ?").get(CLAUDE_TOOL, CLAUDE_PROVIDER);
}

/** Keep `login` as the Claude login. `from`: the project it came from (a new
 *  login), or undefined for a refresh of the one kept. */
export function saveClaudeLogin(login: ClaudeLogin, from?: string): void {
  const enc = encrypt(JSON.stringify(login));
  if (from !== undefined) {
    db.query(`INSERT INTO agent_logins (tool, provider, kind, data_enc, from_project, captured_at, expires_at, refreshed_at, status)
              VALUES (?, ?, 'oauth', ?, ?, datetime('now'), ?, NULL, NULL)
              ON CONFLICT(tool, provider) DO UPDATE SET kind = 'oauth', data_enc = excluded.data_enc, from_project = excluded.from_project,
                captured_at = excluded.captured_at, expires_at = excluded.expires_at, refreshed_at = NULL, status = NULL`)
      .run(CLAUDE_TOOL, CLAUDE_PROVIDER, enc, from, login.expiresAt);
  } else {
    db.query("UPDATE agent_logins SET data_enc = ?, expires_at = ?, refreshed_at = ?, status = NULL WHERE tool = ? AND provider = ?")
      .run(enc, login.expiresAt, Date.now(), CLAUDE_TOOL, CLAUDE_PROVIDER);
  }
}

/** The project's placeholders for the Claude login, made on first use. */
export function claudePlaceholders(projectId: string): { access: string; refresh: string } | null {
  const login = claudeLogin();
  if (!login) return null;
  const get = (field: "access" | "refresh", real: string) => {
    const q = db.query<{ placeholder: string }, [string, string, string, string]>(
      "SELECT placeholder FROM login_placeholders WHERE project_id = ? AND tool = ? AND provider = ? AND field = ?");
    const had = q.get(projectId, CLAUDE_TOOL, CLAUDE_PROVIDER, field);
    if (had) return had.placeholder;
    db.query("INSERT OR IGNORE INTO login_placeholders (project_id, tool, provider, field, placeholder) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, CLAUDE_TOOL, CLAUDE_PROVIDER, field, makePlaceholder(real));
    return q.get(projectId, CLAUDE_TOOL, CLAUDE_PROVIDER, field)!.placeholder;
  };
  return { access: get("access", login.accessToken), refresh: get("refresh", login.refreshToken) };
}

function existingPlaceholders(projectId: string): { access?: string; refresh?: string } {
  const rows = db.query<{ field: string; placeholder: string }, [string, string, string]>(
    "SELECT field, placeholder FROM login_placeholders WHERE project_id = ? AND tool = ? AND provider = ?").all(projectId, CLAUDE_TOOL, CLAUDE_PROVIDER);
  return Object.fromEntries(rows.map((r) => [r.field, r.placeholder]));
}

/** Is this one of sadbox's login placeholders (any project's)? */
export function isLoginPlaceholder(token: string): boolean {
  return !!db.query("SELECT 1 FROM login_placeholders WHERE placeholder = ?").get(token);
}

/** What the proxy swaps for this project: the access token toward Claude's
 *  API (header only); both tokens are redacted from what comes back. Only for
 *  a project that was given placeholders. */
export function loginCredentials(projectId: string): { name: string; placeholder: string; real: string; hosts: string[] | null }[] {
  const ph = existingPlaceholders(projectId);
  if (!ph.access) return [];
  const login = claudeLogin();
  if (!login) return [];
  return [
    { name: CLAUDE_LOGIN_NAME, placeholder: ph.access, real: login.accessToken, hosts: CLAUDE_API_HOSTS },
    // never sent anywhere: the token endpoint is answered here
    ...(ph.refresh ? [{ name: CLAUDE_LOGIN_NAME, placeholder: ph.refresh, real: login.refreshToken, hosts: null }] : []),
  ];
}

/** The `claudeAiOauth` a VM's .credentials.json gets. */
export function vmOauth(projectId: string): Record<string, unknown> | null {
  const login = claudeLogin();
  const ph = claudePlaceholders(projectId);
  if (!login || !ph) return null;
  return {
    accessToken: ph.access, refreshToken: ph.refresh, expiresAt: Date.now() + FAR_MS,
    scopes: login.scopes ?? ["user:inference", "user:profile"],
    subscriptionType: login.subscriptionType ?? null,
    ...(login.rateLimitTier !== undefined ? { rateLimitTier: login.rateLimitTier } : {}),
  };
}

/** Details a VM's Claude learnt about the account (from its profile call,
 *  through the proxy) — kept so new VMs start with them too. */
export function noteClaudeDetails(d: { subscriptionType?: unknown; rateLimitTier?: unknown; scopes?: unknown }): void {
  const login = claudeLogin();
  if (!login) return;
  const next = { ...login };
  if (typeof d.subscriptionType === "string" && d.subscriptionType !== login.subscriptionType) next.subscriptionType = d.subscriptionType;
  if (typeof d.rateLimitTier === "string" && d.rateLimitTier !== login.rateLimitTier) next.rateLimitTier = d.rateLimitTier;
  if (Array.isArray(d.scopes) && !login.scopes?.length) next.scopes = d.scopes.filter((s): s is string => typeof s === "string");
  if (JSON.stringify(next) === JSON.stringify(login)) return;
  db.query("UPDATE agent_logins SET data_enc = ? WHERE tool = ? AND provider = ?").run(encrypt(JSON.stringify(next)), CLAUDE_TOOL, CLAUDE_PROVIDER);
}

/** The token endpoint's answer, as tokens to keep. */
function fromTokenResponse(body: any, request: { clientId?: string; tokenUrl: string }, keep?: ClaudeLogin): ClaudeLogin {
  return {
    ...(keep ?? {}),
    accessToken: body.access_token,
    refreshToken: body.refresh_token || keep?.refreshToken,
    expiresAt: Date.now() + Number(body.expires_in || 28_800) * 1000,
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : keep?.scopes,
    clientId: request.clientId ?? keep?.clientId,
    tokenUrl: request.tokenUrl,
    ...(body.account !== undefined ? { account: body.account } : {}),
    ...(body.organization !== undefined ? { organization: body.organization } : {}),
  };
}

// ---- refreshing (sadbox only) ------------------------------------------------

let inflight: Promise<boolean> | null = null;
/** Swappable in tests. */
export const oauthHttp = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

/** Refresh the Claude login now — one refresh at a time; a call while one is
 *  under way waits for it. Resolves true if the login is fresh afterwards. */
export function refreshClaude(why: string): Promise<boolean> {
  if (inflight) return inflight;
  inflight = (async () => {
    const login = claudeLogin();
    if (!login) return false;
    const url = login.tokenUrl || DEFAULT_TOKEN_URL;
    let res: Response, body: any;
    try {
      res = await oauthHttp.fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: login.refreshToken, client_id: login.clientId || DEFAULT_CLIENT_ID }),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      setStatus(`could not reach ${new URL(url).host} to refresh: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    if (!res.ok || !body.access_token) {
      const said = [body.error, body.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`;
      setStatus(`refresh refused (${said}) — log in to Claude again in any VM`);
      logEvent(null, "login.refresh.error", `${CLAUDE_LOGIN_NAME}: ${said}`);
      return false;
    }
    saveClaudeLogin(fromTokenResponse(body, { clientId: login.clientId, tokenUrl: url }, login));
    logEvent(null, "login.refresh", `${CLAUDE_LOGIN_NAME} refreshed (${why})`);
    return true;
  })().finally(() => { inflight = null; });
  return inflight;
}

function setStatus(status: string) {
  db.query("UPDATE agent_logins SET status = ? WHERE tool = ? AND provider = ?").run(status, CLAUDE_TOOL, CLAUDE_PROVIDER);
}

/** Refresh ahead of expiry; run about every minute. */
export async function refreshIfDue(): Promise<void> {
  const r = loginRow();
  if (!r || r.expires_at == null) return;
  if (r.expires_at - Date.now() > REFRESH_AHEAD_MS) return;
  // a refusal stays refused until a new login; an unreachable server is retried
  if (r.status?.startsWith("refresh refused")) return;
  await refreshClaude("ahead of expiry");
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startClaudeRefresher(): void {
  if (timer) return;
  timer = setInterval(() => { refreshIfDue().catch(() => {}); }, 60_000);
  refreshIfDue().catch(() => {});
}

// ---- the token endpoint, as a VM sees it ------------------------------------

export function isClaudeTokenRequest(scheme: string, host: string, method: string, path: string): boolean {
  return scheme === "https" && TOKEN_HOSTS.has(host.toLowerCase()) && method === "POST" && path.split("?")[0] === "/v1/oauth/token";
}

function parseForm(text: string, contentType: string): Record<string, string> {
  if (/json/i.test(contentType)) { try { const j = JSON.parse(text); return j && typeof j === "object" ? j : {}; } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}

/** Answer a VM's call to Claude's token endpoint. Returns what to log. */
export async function answerTokenRequest(
  projectId: string, projectName: string, host: string, body: string, contentType: string, res: ServerResponse,
): Promise<{ status: number; note: string }> {
  const reply = (status: number, j: unknown) => {
    const b = Buffer.from(JSON.stringify(j));
    try { res.writeHead(status, { "content-type": "application/json", "content-length": String(b.length), "cache-control": "no-store" }); res.end(b); } catch {}
  };
  const placeholdersAnswer = (extra: Record<string, unknown>) => {
    const login = claudeLogin()!;
    const ph = claudePlaceholders(projectId)!;
    return {
      ...extra,
      token_type: "Bearer", access_token: ph.access, refresh_token: ph.refresh,
      expires_in: Math.floor(FAR_MS / 1000),
      scope: (login.scopes ?? []).join(" "),
      ...(login.account !== undefined ? { account: login.account } : {}),
      ...(login.organization !== undefined ? { organization: login.organization } : {}),
    };
  };
  const form = parseForm(body, contentType);
  const mine = existingPlaceholders(projectId);

  if (form.grant_type === "refresh_token" && form.refresh_token && (form.refresh_token === mine.refresh || isLoginPlaceholder(form.refresh_token))) {
    if (form.refresh_token !== mine.refresh || !claudeLogin()) {
      reply(400, { error: "invalid_grant", error_description: "sadbox holds no Claude login for this VM — log in again" });
      return { status: 400, note: "refresh with a placeholder that is not this VM's, or no login kept" };
    }
    const r = loginRow()!;
    // the VM only asks after a 401 (its copy never expires): the real token may be bad
    if (!r.refreshed_at || Date.now() - r.refreshed_at > MIN_REFRESH_GAP_MS) await refreshClaude(`asked by ${projectName}`);
    if (loginRow()?.status?.startsWith("refresh refused")) {
      reply(400, { error: "invalid_grant", error_description: "the Claude login sadbox keeps was refused — log in again" });
      return { status: 400, note: "refresh refused upstream" };
    }
    reply(200, placeholdersAnswer({}));
    return { status: 200, note: "answered by sadbox (placeholders)" };
  }

  // a login in the VM (code exchange), or a refresh with a VM's own real token:
  // sadbox makes the call, keeps what comes back, and hands the VM placeholders
  const url = `https://${host.toLowerCase()}/v1/oauth/token`;
  let up: Response, text: string;
  try {
    up = await oauthHttp.fetch(url, { method: "POST", headers: { "content-type": contentType || "application/json" }, body });
    text = await up.text();
  } catch (e) {
    reply(502, { error: "server_error", error_description: `sadbox could not reach ${host}: ${e instanceof Error ? e.message : e}` });
    return { status: 502, note: "upstream unreachable" };
  }
  let j: any = null;
  try { j = JSON.parse(text); } catch {}
  if (!up.ok || !j?.access_token) {
    // an error carries no tokens — passed on as it is
    try { res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" }); res.end(text); } catch {}
    return { status: up.status, note: `${form.grant_type || "token"} request refused upstream` };
  }
  saveClaudeLogin(fromTokenResponse(j, { clientId: form.client_id, tokenUrl: url }), projectName);
  logEvent(projectId, "login.capture", `${CLAUDE_LOGIN_NAME}: new login kept by sadbox (${form.grant_type || "token"}); this VM holds placeholders`);
  const { access_token: _a, refresh_token: _r, expires_in: _e, ...rest } = j;
  reply(200, placeholdersAnswer(rest));
  return { status: 200, note: `${form.grant_type || "token"}: login kept by sadbox, placeholders to the VM` };
}

/** Forget the Claude login: every VM's placeholders stop working. */
export function forgetClaude(): void {
  db.query("DELETE FROM agent_logins WHERE tool = ? AND provider = ?").run(CLAUDE_TOOL, CLAUDE_PROVIDER);
  db.query("DELETE FROM login_placeholders WHERE tool = ? AND provider = ?").run(CLAUDE_TOOL, CLAUDE_PROVIDER);
}
