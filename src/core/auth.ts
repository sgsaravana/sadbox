// Sign-in for the web UI and API. One user, one password. The UI can open
// shells and edit files in every VM, so nothing but the login page is served
// without a session — on localhost too: any web page the user visits can make
// requests to localhost, and a cookie the browser will not send cross-site
// (SameSite=Strict) is what stops that.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../config";
import { db } from "../db";

export const COOKIE = "sadbox_session";
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 8;

const authFile = () => join(config.dataDir, "auth.json");
/** Where a generated first password is left for the owner to read (0600). */
export const initialPasswordFile = () => join(config.dataDir, "initial-password");

export const authEnabled = () => config.auth !== "off";
const sha = (s: string) => createHash("sha256").update(s).digest();

function storedHash(): string | null {
  try { return JSON.parse(readFileSync(authFile(), "utf8")).hash ?? null; } catch { return null; }
}

/** Make sure there is a password to sign in with. On a first start with none
 *  configured, generate one and leave it in a 0600 file in the data dir —
 *  reading that file is the proof of owning this machine. Returns the generated
 *  password when it just created one. */
export async function ensurePassword(): Promise<string | null> {
  if (config.password || storedHash()) return null;
  const pw = randomBytes(15).toString("base64url");
  writeFileSync(authFile(), JSON.stringify({ hash: await Bun.password.hash(pw) }), { mode: 0o600 });
  writeFileSync(initialPasswordFile(), pw + "\n", { mode: 0o600 });
  return pw;
}

/** Set the password (`sadbox passwd`). Signs every browser out. */
export async function setPassword(pw: string): Promise<void> {
  if (pw.length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  writeFileSync(authFile(), JSON.stringify({ hash: await Bun.password.hash(pw) }), { mode: 0o600 });
  rmSync(initialPasswordFile(), { force: true });
  db.run("DELETE FROM sessions");
}

async function verifyPassword(pw: string): Promise<boolean> {
  // SADBOX_PASSWORD, when set, is the password (for containers / launchd env)
  if (config.password) return timingSafeEqual(sha(pw), sha(config.password));
  const hash = storedHash();
  if (!hash) return false;
  return Bun.password.verify(pw, hash).catch(() => false);
}

// ---- throttling: one user, so one global counter (and a proxy in front makes
// every client look like the same address anyway) ----
let failures = 0;
let lockedUntil = 0;
const FREE_ATTEMPTS = 5;

export class AuthError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}

/** Check a password and open a session. Returns the session token. */
export async function login(pw: unknown): Promise<string> {
  const wait = lockedUntil - Date.now();
  if (wait > 0) throw new AuthError(`too many attempts — try again in ${Math.ceil(wait / 1000)}s`, 429);
  if (typeof pw !== "string" || !pw || !(await verifyPassword(pw))) {
    failures++;
    if (failures >= FREE_ATTEMPTS) lockedUntil = Date.now() + Math.min(60_000, 1000 * 2 ** (failures - FREE_ATTEMPTS));
    throw new AuthError("wrong password");
  }
  failures = 0;
  const token = randomBytes(32).toString("base64url");
  db.run("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]);
  // only a hash is stored: a copy of the database is not a set of live sessions
  db.query("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
    .run(sha(token).toString("hex"), Date.now() + SESSION_DAYS * 86_400_000);
  return token;
}

export function sessionValid(token: string | null | undefined): boolean {
  if (!token) return false;
  const row = db.query<{ expires_at: number }, [string]>(
    "SELECT expires_at FROM sessions WHERE token_hash = ?").get(sha(token).toString("hex"));
  return !!row && row.expires_at > Date.now();
}

export function logout(token: string | null | undefined): void {
  if (token) db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha(token).toString("hex"));
}

// ---- passes to sign-in port forwards (net/forwards.ts) ----
// A forwarded app is on another port, so another origin: the UI's session
// cookie is not the way in (it would reach the app itself, and a Secure one is
// never sent to a plain-HTTP port). Instead the UI, for a signed-in browser,
// hands out a one-time ticket in a redirect to the forward, which trades it for
// a cookie good for that forward only. The pass ends with the UI session it came
// from (sign-out, a new password).
const TICKET_MS = 60_000;
const tickets = new Map<string, { forwardId: string; sessionHash: string | null; expires: number }>();

/** A one-time ticket for this forward, for the browser making `req`. */
export function forwardTicket(req: Request, forwardId: string): string {
  const now = Date.now();
  for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t);
  const token = tokenFrom(req);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { forwardId, sessionHash: token && authEnabled() ? sha(token).toString("hex") : null, expires: now + TICKET_MS });
  return ticket;
}

/** Trade a ticket for a pass to the forward (its cookie value), or null. */
export function redeemForwardTicket(forwardId: string, ticket: string | null): string | null {
  const t = ticket ? tickets.get(ticket) : undefined;
  if (!t) return null;
  tickets.delete(ticket!);
  if (t.forwardId !== forwardId || t.expires < Date.now()) return null;
  const pass = randomBytes(32).toString("base64url");
  db.run("DELETE FROM forward_sessions WHERE expires_at < ? OR (session_hash IS NOT NULL AND session_hash NOT IN (SELECT token_hash FROM sessions))", [Date.now()]);
  db.query("INSERT INTO forward_sessions (token_hash, forward_id, session_hash, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha(pass).toString("hex"), forwardId, t.sessionHash, Date.now() + SESSION_DAYS * 86_400_000);
  return pass;
}

/** Does this pass open this forward? With sign-in off, anything does. */
export function forwardPassValid(forwardId: string, pass: string | null): boolean {
  if (!authEnabled()) return true;
  if (!pass) return false;
  const now = Date.now();
  return !!db.query<{ ok: number }, [string, string, number, number]>(
    `SELECT 1 AS ok FROM forward_sessions f JOIN sessions s ON s.token_hash = f.session_hash
     WHERE f.token_hash = ? AND f.forward_id = ? AND f.expires_at > ? AND s.expires_at > ?`,
  ).get(sha(pass).toString("hex"), forwardId, now, now);
}

export function dropForwardPasses(forwardId: string): void {
  db.query("DELETE FROM forward_sessions WHERE forward_id = ?").run(forwardId);
}

// ---- request helpers ----
/** A cookie's value from a Cookie header. */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const tokenFrom = (req: Request): string | null => cookieValue(req.headers.get("cookie"), COOKIE);

export const signedIn = (req: Request) => !authEnabled() || sessionValid(tokenFrom(req));

const isHttps = (req: Request) =>
  new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

export function sessionCookie(req: Request, token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}${isHttps(req) ? "; Secure" : ""}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/** A browser request carrying an Origin from some other site. Refused for
 *  anything that changes state and for WebSockets, with or without auth. */
export function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false; // not a browser cross-site request (curl, same-origin GET)
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try { return new URL(origin).host !== host; } catch { return true; }
}

/** Where to go after signing in — a local path only, never another site. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}

/** For tests. */
export function resetThrottle(): void { failures = 0; lockedUntil = 0; }
