// Spike D — placeholder ⇄ real token swap, hooked into src/net/proxy.ts by
// proxy.patch. Self-contained (no sadbox imports) so it can be thrown away.
//
// Map file (path in SADBOX_SPIKE_SUBST), plain JSON, real values in clear —
// spike only, short-lived tokens, delete afterwards:
//   { "secrets": [
//       { "name": "GITHUB_TOKEN", "placeholder": "ghp_sbx…", "value": "ghp_…",
//         "hosts": ["api.github.com", "github.com", "*.githubusercontent.com"] } ] }
//
// Logs go to stdout prefixed "[spike-d]" and never contain a real value.
import { readFileSync } from "node:fs";

export interface SpikeSecret {
  name: string;
  placeholder: string;
  value: string;
  hosts: string[];
}

type Headers = Record<string, unknown>;

let secrets: SpikeSecret[] | null = null;

/** Load (once) from SADBOX_SPIKE_SUBST. Empty when the variable is unset. */
export function loadSecrets(): SpikeSecret[] {
  if (secrets) return secrets;
  const file = process.env.SADBOX_SPIKE_SUBST;
  secrets = file ? (JSON.parse(readFileSync(file, "utf8")).secrets as SpikeSecret[]) : [];
  for (const s of secrets) {
    if (!s.name || !s.placeholder || !s.value || !Array.isArray(s.hosts)) {
      throw new Error(`spike-d: bad entry in ${file}: needs name, placeholder, value, hosts[]`);
    }
  }
  if (secrets.length) log(`loaded ${secrets.length} secret(s): ${secrets.map((s) => s.name).join(", ")}`);
  return secrets;
}

/** For tests. */
export function setSecrets(list: SpikeSecret[]): void {
  secrets = list;
}

export const enabled = () => loadSecrets().length > 0;

export interface SwapReport {
  injected: string[];  // "NAME@header(encoding)"
  unbound: string[];   // placeholder seen, host not bound — forwarded unchanged
  refused: string[];   // placeholder seen over plain http — forwarded unchanged
  inPath: string[];    // placeholder seen in the URL (not substituted; experiment 2)
  micros: number;
}

/** Request side: placeholder → real, in place, for https + bound hosts only. */
export function substituteRequest(scheme: string, host: string, path: string, headers: Headers): SwapReport {
  const t0 = performance.now();
  const rep: SwapReport = { injected: [], unbound: [], refused: [], inPath: [], micros: 0 };
  for (const s of loadSecrets()) {
    if (path.includes(s.placeholder) || path.includes(encodeURIComponent(s.placeholder))) rep.inPath.push(s.name);
    for (const key of Object.keys(headers)) {
      const v = headers[key];
      const hit = mapValue(v, (x) => swap(x, s.placeholder, s.value));
      if (!hit.encodings.length) continue;
      const tag = `${s.name}@${key}(${hit.encodings.join("+")})`;
      if (scheme !== "https") { rep.refused.push(tag); continue; }
      if (!s.hosts.some((p) => hostMatch(p, host))) { rep.unbound.push(tag); continue; }
      headers[key] = hit.value;
      rep.injected.push(tag);
    }
  }
  rep.micros = Math.round((performance.now() - t0) * 1000);
  return rep;
}

/** Response side: real → placeholder, in place, in every header, any host. */
export function redactResponse(headers: Headers): { redacted: string[]; micros: number } {
  const t0 = performance.now();
  const redacted: string[] = [];
  for (const s of loadSecrets()) {
    for (const key of Object.keys(headers)) {
      const hit = mapValue(headers[key], (x) => swap(x, s.value, s.placeholder));
      if (!hit.encodings.length) continue;
      headers[key] = hit.value;
      redacted.push(`${s.name}@${key}(${hit.encodings.join("+")})`);
    }
  }
  return { redacted, micros: Math.round((performance.now() - t0) * 1000) };
}

export function report(dir: "req" | "res", host: string, method: string, path: string, r: Partial<SwapReport> & { redacted?: string[]; micros: number }): void {
  const parts = [
    r.injected?.length && `injected=${r.injected.join(",")}`,
    r.unbound?.length && `UNBOUND=${r.unbound.join(",")}`,
    r.refused?.length && `REFUSED-plain-http=${r.refused.join(",")}`,
    r.inPath?.length && `IN-URL=${r.inPath.join(",")}`,
    r.redacted?.length && `redacted=${r.redacted.join(",")}`,
  ].filter(Boolean);
  if (parts.length) log(`${dir} ${method} ${host}${path.split("?")[0]} ${parts.join(" ")} (${r.micros}µs)`);
}

// ---- swapping ----

/** Replace `from` with `to` in one header value: literally, and inside a
 *  `Basic base64(user:pass)` credential (git's https auth). */
export function swap(value: string, from: string, to: string): { value: string; encodings: string[] } {
  const encodings: string[] = [];
  let out = value;
  if (out.includes(from)) {
    out = out.split(from).join(to);
    encodings.push(scheme(value));
  }
  const m = /^(\s*basic\s+)([A-Za-z0-9+/=]+)\s*$/i.exec(out);
  if (m) {
    const decoded = Buffer.from(m[2], "base64").toString("utf8");
    if (decoded.includes(from)) {
      out = m[1] + Buffer.from(decoded.split(from).join(to), "utf8").toString("base64");
      encodings.push("basic");
    }
  }
  return { value: out, encodings };
}

function scheme(value: string): string {
  const m = /^\s*(bearer|token|basic)\s/i.exec(value);
  return m ? m[1].toLowerCase() : "raw";
}

/** Header values are a string or (set-cookie & co.) an array of strings. */
function mapValue(v: unknown, fn: (x: string) => { value: string; encodings: string[] }): { value: unknown; encodings: string[] } {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) {
    const encodings: string[] = [];
    const value = v.map((x) => {
      if (typeof x !== "string") return x;
      const r = fn(x);
      encodings.push(...r.encodings);
      return r.value;
    });
    return { value, encodings };
  }
  return { value: v, encodings: [] };
}

// same semantics as src/net/rules.ts hostMatch: exact, *.suffix, *
function hostMatch(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const bare = pattern.slice(2);
    return host === bare || host.endsWith("." + bare);
  }
  return host === pattern;
}

function log(msg: string): void {
  console.log(`[spike-d] ${msg}`);
}
