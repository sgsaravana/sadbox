// Spike D — print placeholder variants for a real token (experiment 1).
//   bun spikes/d-credential-proxy/placeholder.ts <real-token>
// Reads the token from argv or, if absent, stdin (keeps it out of shell history:
//   pbpaste | bun spikes/d-credential-proxy/placeholder.ts).
// Prints only placeholders, never the input.

const KNOWN_PREFIXES = [
  "github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
  "sk-ant-oat01-", "sk-ant-api03-", "sk-ant-", "sk-proj-", "sk-",
  "xoxb-", "xoxp-", "glpat-",
];

export function prefixOf(token: string): string {
  const known = KNOWN_PREFIXES.find((p) => token.startsWith(p));
  if (known) return known;
  const m = /^.{0,15}[-_]/.exec(token);
  return m ? m[0] : "";
}

export function alphabetOf(body: string): string {
  const lower = "abcdefghijklmnopqrstuvwxyz", upper = lower.toUpperCase(), digits = "0123456789";
  if (/^[0-9a-f]+$/.test(body)) return digits + "abcdef";
  let a = "";
  if (/[a-z]/.test(body)) a += lower;
  if (/[A-Z]/.test(body)) a += upper;
  if (/[0-9]/.test(body)) a += digits;
  if (body.includes("-")) a += "-";
  if (body.includes("_")) a += "_";
  return a || lower + upper + digits;
}

function random(alphabet: string, n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

/** (a) prefix + "sbx" marker + random, same length and alphabet as the real token. */
export function variantA(token: string): string {
  const p = prefixOf(token);
  const body = token.slice(p.length);
  return p + "sbx" + random(alphabetOf(body), Math.max(body.length - 3, 8));
}

/** (b) prefix + random, same length and alphabet, no marker. */
export function variantB(token: string): string {
  const p = prefixOf(token);
  const body = token.slice(p.length);
  return p + random(alphabetOf(body), Math.max(body.length, 8));
}

/** (c) generic, format-agnostic. */
export function variantC(): string {
  return "sadbox-ph-" + random("abcdefghijklmnopqrstuvwxyz0123456789", 32);
}

if (import.meta.main) {
  const token = (Bun.argv[2] ?? (await Bun.stdin.text())).trim();
  if (!token) {
    console.error("usage: bun placeholder.ts <real-token>   (or pipe it on stdin)");
    process.exit(1);
  }
  console.log(`prefix: ${JSON.stringify(prefixOf(token))}  length: ${token.length}`);
  console.log(`(a) ${variantA(token)}`);
  console.log(`(b) ${variantB(token)}`);
  console.log(`(c) ${variantC()}`);
}
