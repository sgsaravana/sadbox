// Credential swap for proxy-delivered secrets (docs/research/11, Spike D).
// A VM holds only placeholders. On the way out, a placeholder in a request
// header becomes the real value — over https, to a host one of the secret's
// bindings names. On the way back, a real value in a response header becomes
// the placeholder again. Matching is on literal substrings (Bearer, `token`,
// x-api-key) plus inside a `Basic base64(user:pass)` credential (git).
//
// Real values are decrypted only for the request or response that needs them,
// and never logged: callers get secret names, not values.
import { db } from "../db";
import { decrypt } from "../crypto";
import { hostMatch, pathMatch } from "./rules";

interface Credential {
  secretId: string;
  name: string;
  placeholder: string;
  valueEnc: string;
}

interface BindingRow {
  host: string;
  path: string | null;
  method: string | null;
  header: string | null;
  expires_at: string | null;
}

export interface SwapRequest {
  scheme: string;
  host: string;
  path: string;   // as sent, query string included
  method: string;
}

export interface SwapResult {
  injected: string[];                               // names of secrets swapped in
  unbound: { secretId: string; name: string }[];    // placeholder seen, no binding matched
  plainHttp: string[];                              // placeholder seen over plain http
  inUrl: string[];                                  // placeholder in the URL: never swapped
}

type Headers = Record<string, unknown>;

/** The proxy secrets this project holds a placeholder for — assigned globals
 *  and its own. A placeholder left over from an unassigned secret doesn't count. */
function projectCredentials(projectId: string): Credential[] {
  return db.query<Credential, [string, string, string]>(
    `SELECT s.id AS secretId, s.name AS name, sp.placeholder AS placeholder, s.value_enc AS valueEnc
     FROM secret_placeholders sp JOIN secrets s ON s.id = sp.secret_id
     WHERE sp.project_id = ? AND s.delivery = 'proxy'
       AND (s.project_id = ? OR EXISTS (
         SELECT 1 FROM project_secrets ps WHERE ps.project_id = ? AND ps.secret_id = s.id))`,
  ).all(projectId, projectId, projectId);
}

function bindingAllows(b: BindingRow, req: SwapRequest, header: string, now: number): boolean {
  if (b.expires_at && Date.parse(b.expires_at) <= now) return false;
  if (!hostMatch(b.host, req.host)) return false;
  if (b.method && b.method !== req.method.toUpperCase()) return false;
  if (b.path && !pathMatch(b.path, req.path.split("?")[0])) return false;
  if (b.header && b.header !== header) return false;
  return true;
}

/** Swap this project's placeholders for real values in `headers`, in place.
 *  `alsoAllow` lets named secrets through without a binding (an approval
 *  answered "just this request"); everything else must match a binding. */
export function substituteRequest(
  projectId: string, req: SwapRequest, headers: Headers, alsoAllow: Set<string> = new Set(),
): SwapResult {
  const out: SwapResult = { injected: [], unbound: [], plainHttp: [], inUrl: [] };
  const creds = projectCredentials(projectId);
  if (!creds.length) return out;
  const now = Date.now();

  for (const c of creds) {
    if (req.path.includes(c.placeholder) || req.path.includes(encodeURIComponent(c.placeholder))) out.inUrl.push(c.name);
    const keys = Object.keys(headers).filter((k) => carries(headers[k], c.placeholder));
    if (!keys.length) continue;
    if (req.scheme !== "https") { out.plainHttp.push(c.name); continue; }

    const bindings = alsoAllow.has(c.secretId) ? null : db.query<BindingRow, [string]>(
      "SELECT host, path, method, header, expires_at FROM secret_bindings WHERE secret_id = ?",
    ).all(c.secretId);
    const allowed = keys.filter((k) => !bindings || bindings.some((b) => bindingAllows(b, req, k.toLowerCase(), now)));
    if (allowed.length < keys.length) {
      // some header it sits in isn't covered: ask about the whole secret, swap nothing yet
      out.unbound.push({ secretId: c.secretId, name: c.name });
      continue;
    }
    const real = decrypt(c.valueEnc);
    for (const k of allowed) headers[k] = mapValue(headers[k], (v) => swap(v, c.placeholder, real));
    out.injected.push(c.name);
  }
  return out;
}

/** Turn real values of this project's proxy secrets in response headers back
 *  into placeholders, in place. Returns the names of secrets it redacted. */
export function redactResponse(projectId: string, headers: Headers): string[] {
  const redacted: string[] = [];
  for (const c of projectCredentials(projectId)) {
    const real = decrypt(c.valueEnc);
    if (!real) continue;
    let hit = false;
    for (const k of Object.keys(headers)) {
      if (!carries(headers[k], real)) continue;
      headers[k] = mapValue(headers[k], (v) => swap(v, real, c.placeholder));
      hit = true;
    }
    if (hit) redacted.push(c.name);
  }
  return redacted;
}

/** Let a secret go to a host from now on (an approval answered with a window
 *  or "always"). expiresAt null = permanent. */
export function bindFromApproval(secretId: string, host: string, expiresAt: string | null): void {
  db.query(
    "INSERT INTO secret_bindings (id, secret_id, host, expires_at) VALUES (?, ?, ?, ?)",
  ).run(crypto.randomUUID().slice(0, 8), secretId, host, expiresAt);
}

// ---- matching & swapping ----

const BASIC = /^(\s*basic\s+)([A-Za-z0-9+/=]+)\s*$/i;

function basicDecoded(v: string): string | null {
  const m = BASIC.exec(v);
  return m ? Buffer.from(m[2], "base64").toString("utf8") : null;
}

/** Does this header value contain `needle`, literally or inside Basic auth? */
function carries(v: unknown, needle: string): boolean {
  if (Array.isArray(v)) return v.some((x) => carries(x, needle));
  if (typeof v !== "string") return false;
  return v.includes(needle) || (basicDecoded(v)?.includes(needle) ?? false);
}

/** Replace `from` with `to` in one header value: literally, and inside Basic. */
export function swap(v: string, from: string, to: string): string {
  let out = v.split(from).join(to);
  const m = BASIC.exec(out);
  if (m) {
    const decoded = Buffer.from(m[2], "base64").toString("utf8");
    if (decoded.includes(from)) {
      out = m[1] + Buffer.from(decoded.split(from).join(to), "utf8").toString("base64");
    }
  }
  return out;
}

/** Header values are a string or (set-cookie & co.) an array of strings. */
function mapValue(v: unknown, fn: (x: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? fn(x) : x));
  return v;
}
