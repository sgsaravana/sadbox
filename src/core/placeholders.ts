// Placeholders for proxy-delivered secrets (docs/research/11). The VM's env
// file carries one of these instead of the real value; the egress proxy swaps
// it for the real value on requests to the secret's bindings.
//
// Format (Spike D, variant a): the real token's recognisable prefix, then the
// marker "sbx", then random characters from the token's own alphabet up to its
// length — so tools that sniff a prefix or length still accept it, and a
// placeholder is easy to grep for. No client tested validates more than that.
import { db } from "../db";

const KNOWN_PREFIXES = [
  "github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
  "sk-ant-oat01-", "sk-ant-ort01-", "sk-ant-api03-", "sk-ant-", "sk-proj-", "sk-",
  "xoxb-", "xoxp-", "glpat-",
];

const MARKER = "sbx";
const MIN_RANDOM = 24; // short or odd tokens still get an unguessable tail

export function prefixOf(token: string): string {
  const known = KNOWN_PREFIXES.find((p) => token.startsWith(p));
  if (known) return known;
  const m = /^.{0,15}[-_]/.exec(token);
  return m ? m[0] : "";
}

function alphabetOf(body: string): string {
  const lower = "abcdefghijklmnopqrstuvwxyz", upper = lower.toUpperCase(), digits = "0123456789";
  if (/^[0-9a-f]+$/.test(body)) return digits + "abcdef";
  let a = "";
  if (/[a-z]/.test(body)) a += lower;
  if (/[A-Z]/.test(body)) a += upper;
  if (/[0-9]/.test(body)) a += digits;
  if (body.includes("-")) a += "-";
  if (body.includes("_")) a += "_";
  // too few symbols to be unguessable at this length: widen to alphanumerics
  return a.length >= 16 ? a : lower + upper + digits;
}

function random(alphabet: string, n: number): string {
  // rejection sampling keeps every symbol equally likely
  const limit = 256 - (256 % alphabet.length);
  let s = "";
  while (s.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < limit) s += alphabet[b % alphabet.length];
      if (s.length === n) break;
    }
  }
  return s;
}

/** A fresh placeholder shaped like `real`. */
export function makePlaceholder(real: string): string {
  const prefix = prefixOf(real);
  const body = real.slice(prefix.length);
  return prefix + MARKER + random(alphabetOf(body), Math.max(body.length - MARKER.length, MIN_RANDOM));
}

/** The project's placeholder for a secret: created on first use, the same ever after. */
export function placeholderFor(projectId: string, secretId: string, real: string): string {
  const row = db.query<{ placeholder: string }, [string, string]>(
    "SELECT placeholder FROM secret_placeholders WHERE project_id = ? AND secret_id = ?",
  ).get(projectId, secretId);
  if (row) return row.placeholder;
  for (let attempt = 0; ; attempt++) {
    const placeholder = makePlaceholder(real);
    try {
      db.query("INSERT INTO secret_placeholders (project_id, secret_id, placeholder) VALUES (?, ?, ?)")
        .run(projectId, secretId, placeholder);
      return placeholder;
    } catch (e) {
      // someone else made this project's placeholder first — that one stands
      const made = existingPlaceholder(projectId, secretId);
      if (made) return made;
      // otherwise a collision on the UNIQUE placeholder: astronomically unlikely, retry a little
      if (attempt >= 3) throw e;
    }
  }
}

/** The project's existing placeholder for a secret, if one was ever made. */
export function existingPlaceholder(projectId: string, secretId: string): string | null {
  return db.query<{ placeholder: string }, [string, string]>(
    "SELECT placeholder FROM secret_placeholders WHERE project_id = ? AND secret_id = ?",
  ).get(projectId, secretId)?.placeholder ?? null;
}

/** Every project's placeholder for an item — they are made afresh on next use. */
export function dropItemPlaceholders(secretId: string): void {
  db.query("DELETE FROM secret_placeholders WHERE secret_id = ?").run(secretId);
}

export function dropPlaceholders(projectId: string, secretIds?: string[]): void {
  if (!secretIds) {
    db.query("DELETE FROM secret_placeholders WHERE project_id = ?").run(projectId);
    return;
  }
  const q = db.query("DELETE FROM secret_placeholders WHERE project_id = ? AND secret_id = ?");
  for (const sid of secretIds) q.run(projectId, sid);
}
