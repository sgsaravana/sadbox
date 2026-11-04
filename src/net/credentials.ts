// Credential swap for proxy vault items (docs/research/11, 12; Spikes D, F.4).
// A VM holds only placeholders. On the way out, a placeholder becomes the real
// value — over https, to a host one of the item's bindings names — in request
// headers, and, where the item allows it, in the URL and the request body. On
// the way back, a real value in a response header or body becomes the
// placeholder again. Matching is on literal substrings (Bearer, `token`,
// x-api-key) plus inside a `Basic base64(user:pass)` credential (git).
//
// Typed items: in a JSON body, a placeholder that is a whole string takes the
// item's typed value (`"limit": "<ph>"` → `"limit": 50`); anywhere else the
// value goes in as text, escaped for where it lands.
//
// Real values are decrypted only for the request or response that needs them,
// and never logged: callers get item names, not values.
import { db } from "../db";
import { decrypt } from "../crypto";
import { hostMatch, pathMatch } from "./rules";
import { loginCredentials } from "./claudeoauth";

interface Credential {
  secretId: string;
  name: string;
  placeholder: string;
  valueEnc: string;
  valueType: "string" | "number" | "json";
  swapUrl: number;
  swapBody: number;
  /** An agent login sadbox owns (claudeoauth.ts): its real value as is, and
   *  the only hosts it goes to — in the Authorization header, and nowhere
   *  else; null: never sent. Nobody is asked about it. */
  login?: { real: string; hosts: string[] | null };
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
  injected: string[];                               // names of items swapped in
  unbound: { secretId: string; name: string }[];    // placeholder seen, no binding matched
  plainHttp: string[];                              // placeholder seen over plain http
  inUrl: string[];                                  // placeholder in the URL of an item that is not swapped there
  path: string;                                     // the request path, swapped where allowed
  body: string | null;                              // the request body, swapped where allowed (null: not given)
}

/** A request body the proxy holds in full, so it can be swapped. */
export interface SwapBody {
  text: string;
  contentType: string;
}

type Headers = Record<string, unknown>;

/** The proxy items this project holds a placeholder for and may use, and the
 *  agent logins it was given. A placeholder left over from an item it lost
 *  access to doesn't count. */
function projectCredentials(projectId: string): Credential[] {
  const logins: Credential[] = loginCredentials(projectId).map((l, i) => ({
    secretId: `login:${i}`, name: l.name, placeholder: l.placeholder, valueEnc: "", valueType: "string",
    swapUrl: 0, swapBody: 0, login: { real: l.real, hosts: l.hosts },
  }));
  return [...vaultCredentials(projectId), ...logins];
}

function vaultCredentials(projectId: string): Credential[] {
  return db.query<Credential, [string, string]>(
    `SELECT s.id AS secretId, s.name AS name, sp.placeholder AS placeholder, s.value_enc AS valueEnc,
            s.value_type AS valueType, s.swap_url AS swapUrl, s.swap_body AS swapBody
     FROM secret_placeholders sp JOIN secrets s ON s.id = sp.secret_id
     WHERE sp.project_id = ? AND s.delivery = 'proxy'
       AND EXISTS (SELECT 1 FROM project_secrets ps WHERE ps.project_id = ? AND ps.secret_id = s.id)`,
  ).all(projectId, projectId);
}

function bindingAllows(b: BindingRow, req: SwapRequest, header: string, now: number): boolean {
  if (b.expires_at && Date.parse(b.expires_at) <= now) return false;
  if (!hostMatch(b.host, req.host)) return false;
  if (b.method && b.method !== req.method.toUpperCase()) return false;
  if (b.path && !pathMatch(b.path, req.path.split("?")[0])) return false;
  if (b.header && b.header !== header) return false;
  return true;
}

/** The proxy item a git client in this project presents to `host` (git's
 *  credential helper asks — net/guest.ts): its name and this VM's placeholder,
 *  which git sends as the password in `Basic` auth, where the proxy swaps in
 *  the real value. Only an item whose binding would let it go there as git
 *  sends it (any method, the Authorization header); the closest binding wins —
 *  the exact host, then `*.host`; one without a path before one with.
 *  Null: nothing in the vault for that host, and git carries on without. */
export function gitCredentialFor(projectId: string, host: string): { name: string; placeholder: string } | null {
  const now = Date.now();
  let best: { name: string; placeholder: string; rank: number } | null = null;
  for (const c of vaultCredentials(projectId)) {
    if (c.valueType !== "string") continue;
    const bindings = db.query<BindingRow, [string]>(
      "SELECT host, path, method, header, expires_at FROM secret_bindings WHERE secret_id = ?",
    ).all(c.secretId);
    for (const b of bindings) {
      if (b.expires_at && Date.parse(b.expires_at) <= now) continue;
      if (b.method || (b.header && b.header !== "authorization") || !hostMatch(b.host, host)) continue;
      const rank = (b.host === host ? 0 : 2) + (b.path ? 1 : 0);
      if (!best || rank < best.rank) best = { name: c.name, placeholder: c.placeholder, rank };
    }
  }
  return best && { name: best.name, placeholder: best.placeholder };
}

/** Does any of this project's items get swapped in request bodies? (Only
 *  then is a body worth holding back to look at.) */
export function swapsBodies(projectId: string): boolean {
  return projectCredentials(projectId).some((c) => c.swapBody);
}

/** Swap this project's placeholders for real values: in `headers` (in place),
 *  and — for items that allow it — in the path and in `body`. `alsoAllow`
 *  lets named items through without a binding (an approval answered "just
 *  this request"); everything else must match a binding, in every place the
 *  placeholder sits. An item is swapped everywhere or nowhere. */
export function substituteRequest(
  projectId: string, req: SwapRequest, headers: Headers, alsoAllow: Set<string> = new Set(), body: SwapBody | null = null,
): SwapResult {
  const out: SwapResult = { injected: [], unbound: [], plainHttp: [], inUrl: [], path: req.path, body: body?.text ?? null };
  const creds = projectCredentials(projectId);
  if (!creds.length) return out;
  const now = Date.now();

  for (const c of creds) {
    const ph = c.placeholder;
    const keys = Object.keys(headers).filter((k) => carries(headers[k], ph));
    const inPath = out.path.includes(ph) || out.path.includes(encodeURIComponent(ph));
    if (inPath && !c.swapUrl) out.inUrl.push(c.name); // never swapped there; flagged in the log
    const url = inPath && !!c.swapUrl;
    const inBody = !!c.swapBody && out.body != null && out.body.includes(ph);
    if (!keys.length && !url && !inBody) continue;
    if (req.scheme !== "https") { out.plainHttp.push(c.name); continue; }

    if (c.login) {
      // only as a bearer token to the login's own hosts; anywhere else the placeholder goes as it is
      const to = c.login.hosts;
      if (!to || !keys.length || !keys.every((k) => k.toLowerCase() === "authorization") || !to.some((h) => hostMatch(h, req.host))) continue;
      for (const k of keys) headers[k] = mapValue(headers[k], (v) => swap(v, ph, c.login!.real));
      out.injected.push(c.name);
      continue;
    }

    const bindings = alsoAllow.has(c.secretId) ? null : db.query<BindingRow, [string]>(
      "SELECT host, path, method, header, expires_at FROM secret_bindings WHERE secret_id = ?",
    ).all(c.secretId);
    // a header-scoped binding covers only that header; the URL and the body need an unscoped one
    const covers = (header: string) => !bindings || bindings.some((b) => bindingAllows(b, req, header, now));
    if (!keys.every((k) => covers(k.toLowerCase())) || ((url || inBody) && !covers(""))) {
      // somewhere it sits isn't covered: ask about the whole item, swap nothing yet
      out.unbound.push({ secretId: c.secretId, name: c.name });
      continue;
    }
    const real = decrypt(c.valueEnc);
    for (const k of keys) headers[k] = mapValue(headers[k], (v) => swap(v, ph, real));
    if (url) out.path = out.path.split(ph).join(encodeURIComponent(real)).split(encodeURIComponent(ph)).join(encodeURIComponent(real));
    if (inBody) out.body = swapBody(out.body!, body!.contentType, ph, real, c.valueType);
    out.injected.push(c.name);
  }
  return out;
}

/** Put `real` where `ph` sits in a request body, as its content type wants it. */
export function swapBody(text: string, contentType: string, ph: string, real: string, type: Credential["valueType"]): string {
  if (/json/i.test(contentType)) {
    // the whole string → the typed value; inside a longer string → escaped text
    const whole = type === "string" ? JSON.stringify(real) : real;
    return text.split(`"${ph}"`).join(whole).split(ph).join(JSON.stringify(real).slice(1, -1));
  }
  if (/x-www-form-urlencoded/i.test(contentType)) return text.split(ph).join(encodeURIComponent(real));
  return text.split(ph).join(real);
}

/** Request and response bodies of these types are text the proxy can swap in or redact. */
export const textualType = (contentType: string) =>
  /^text\/|json|x-www-form-urlencoded|javascript|xml|event-stream|graphql/i.test(contentType);

/** The values worth redacting in responses: a string of some length. A short
 *  or typed value (`50`, `true`, `{"a":1}`) is not unguessable, and replacing
 *  it everywhere would corrupt ordinary responses. */
const MIN_REDACT = 8;
function redactable(projectId: string): { name: string; real: string; placeholder: string }[] {
  return projectCredentials(projectId)
    .filter((c) => c.valueType === "string")
    .map((c) => ({ name: c.name, real: c.login?.real ?? decrypt(c.valueEnc), placeholder: c.placeholder }))
    .filter((c) => c.real.length >= MIN_REDACT);
}

/** Turn real values of this project's proxy items in response headers back
 *  into placeholders, in place. Returns the names of items it redacted. */
export function redactResponse(projectId: string, headers: Headers): string[] {
  const redacted: string[] = [];
  for (const c of redactable(projectId)) {
    const real = c.real;
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

/** A streaming redactor for a response body: real values of this project's
 *  proxy items become their placeholders, wherever chunk boundaries fall.
 *  Only the tail of a chunk that could be the start of a real value is held
 *  back, so a stream of events (SSE) is not delayed. Null if there is nothing
 *  to redact. */
export function bodyRedactor(projectId: string): { write(chunk: Buffer): Buffer; end(): Buffer; redacted: Set<string> } | null {
  const items = redactable(projectId).map((c) => ({ ...c, realB: Buffer.from(c.real), phB: Buffer.from(c.placeholder) }));
  if (!items.length) return null;
  const redacted = new Set<string>();
  let carry = Buffer.alloc(0);
  const replaceAll = (buf: Buffer) => {
    for (const c of items) {
      let at = buf.indexOf(c.realB);
      if (at < 0) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (at >= 0) { parts.push(buf.subarray(from, at), c.phB); from = at + c.realB.length; at = buf.indexOf(c.realB, from); }
      parts.push(buf.subarray(from));
      buf = Buffer.concat(parts);
      redacted.add(c.name);
    }
    return buf;
  };
  // how many trailing bytes could be the beginning of a real value
  const heldBack = (buf: Buffer) => {
    let hold = 0;
    for (const c of items) {
      for (let k = Math.min(c.realB.length - 1, buf.length); k > hold; k--) {
        if (buf.subarray(buf.length - k).equals(c.realB.subarray(0, k))) { hold = k; break; }
      }
    }
    return hold;
  };
  return {
    redacted,
    write(chunk) {
      const buf = replaceAll(Buffer.concat([carry, chunk]));
      const hold = heldBack(buf);
      carry = Buffer.from(buf.subarray(buf.length - hold));
      return buf.subarray(0, buf.length - hold);
    },
    end() { const rest = carry; carry = Buffer.alloc(0); return rest; },
  };
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
