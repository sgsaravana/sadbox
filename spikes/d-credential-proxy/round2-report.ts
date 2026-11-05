// Spike D round 2, the host side. After round2-vm.sh has run in the project:
//   SADBOX_DATA=/tmp/sbxd2 bun spikes/d-credential-proxy/round2-report.ts <project name>
// (same SADBOX_DATA as the supervisor running the project). Prints:
//   1. the project's request log since the run started (status, 🔑 swapped,
//      redacted, placeholder-in-URL, blocked) by host;
//   2. a leak scan: every real value sadbox would swap for this project (its
//      proxy vault items and the Claude login) grepped for across the VM's
//      files and process environments. The values go in on stdin, never on a
//      command line or into a file in the VM; only match counts come back.
import { db } from "../../src/db";
import { decrypt } from "../../src/crypto";
import { getDriver } from "../../src/driver";
import { refFor } from "../../src/core/projects";
import { claudeLogin } from "../../src/net/claudeoauth";

const name = process.argv[2];
const sinceMin = Number(process.argv[3] ?? 60);
if (!name) { console.error("usage: bun round2-report.ts <project name> [minutes back, default 60]"); process.exit(2); }
const p = db.query<{ id: string }, [string]>("SELECT id FROM projects WHERE name = ? AND state != 'destroyed'").get(name);
if (!p) { console.error(`no project named ${name}`); process.exit(1); }

// ---- 1. request log ----
interface Row { host: string; status: number | null; decision: string; n: number; creds: string | null; red: string | null; inurl: string | null; err: string | null }
const rows = db.query<Row, [string, number]>(`
  SELECT host, status, decision, COUNT(*) AS n,
         GROUP_CONCAT(DISTINCT credentials) AS creds, GROUP_CONCAT(DISTINCT redacted) AS red,
         GROUP_CONCAT(DISTINCT credential_in_url) AS inurl, GROUP_CONCAT(DISTINCT error) AS err
  FROM net_requests WHERE project_id = ? AND ts >= ?
  GROUP BY host, status, decision ORDER BY host, status`).all(p.id, Date.now() - sinceMin * 60_000);
const names = (s: string | null) => [...new Set((s ?? "").split(",").flatMap((j) => { try { return JSON.parse(j) as string[]; } catch { return []; } }))].join(" ");
console.log(`== request log, last ${sinceMin} min ==`);
for (const r of rows) {
  const flags = [names(r.creds) && `🔑 ${names(r.creds)}`, names(r.red) && `redacted ${names(r.red)}`,
    names(r.inurl) && `⚠ in-URL ${names(r.inurl)}`, r.err && `error ${r.err}`].filter(Boolean).join("  ");
  console.log(`${String(r.n).padStart(4)}×  ${r.decision.padEnd(7)} ${String(r.status ?? "—").padEnd(4)} ${r.host}  ${flags}`);
}
if (!rows.length) console.log("  (no requests)");
const blocked = rows.filter((r) => r.decision === "blocked");
const inUrl = rows.filter((r) => names(r.inurl));

// ---- 2. leak scan ----
const items = db.query<{ name: string; value_enc: string }, [string]>(`
  SELECT s.name, s.value_enc FROM secrets s JOIN project_secrets ps ON ps.secret_id = s.id
  WHERE ps.project_id = ? AND s.delivery = 'proxy'`).all(p.id);
const reals: { name: string; value: string }[] = items.map((i) => ({ name: i.name, value: decrypt(i.value_enc) }));
const login = claudeLogin();
if (login) reals.push({ name: "Claude login (access)", value: login.accessToken }, { name: "Claude login (refresh)", value: login.refreshToken });

console.log(`\n== leak scan: ${reals.length} real value(s) — ${reals.map((r) => r.name).join(", ") || "none"} ==`);
const ref = refFor(name);
const driver = getDriver();
// Patterns come on stdin (grep -f -); a match prints only the file name. Values
// are also searched base64'd (git sends them inside Basic auth), at each of the
// three byte offsets the value can start at in the encoded text: the groups
// touching a neighbour's bytes are cut off.
const b64 = (v: string) => [0, 1, 2].map((k) => {
  const s = Buffer.concat([Buffer.alloc(k), Buffer.from(v)]).toString("base64").replace(/=+$/, "");
  return s.slice(k ? 4 : 0, -4);
});
const patterns = reals.flatMap((r) => [r.value, ...b64(r.value)]).join("\n") + "\n";
const scan = async (label: string, cmd: string, user = "root") => {
  const r = await driver.execWithStdin(ref, cmd, new TextEncoder().encode(patterns), { user, timeoutMs: 180_000 });
  const hits = r.stdout.trim().split("\n").filter(Boolean);
  console.log(`${hits.length ? "FAIL" : "PASS"}  ${label}${hits.length ? `  — found in: ${hits.join(", ")}` : ""}`);
  return hits.length;
};
let leaks = 0;
if (reals.length) {
  leaks += await scan("files (/home /root /tmp /var/tmp /etc /usr/local /opt /run)",
    "grep -rlaF -D skip -f - /home /root /tmp /var/tmp /etc /usr/local /opt /run 2>/dev/null; true");
  // root in the VM has no CAP_SYS_PTRACE, so it can't read the agent's
  // /proc/*/environ: scan as each user
  const env = "grep -laF -f - /proc/[0-9]*/environ 2>/dev/null; true";
  leaks += await scan("process environments (root)", env);
  leaks += await scan("process environments (agent)", env, "agent");
}

console.log(`\n== summary ==`);
console.log(`${blocked.length ? "WARN" : "PASS"}  no blocked requests${blocked.length ? `  — ${blocked.map((b) => b.host).join(", ")}` : ""}`);
console.log(`${inUrl.length ? "WARN" : "PASS"}  no placeholder in a URL`);
console.log(`${leaks ? "FAIL" : "PASS"}  no real value in the VM`);
process.exit(leaks ? 1 : 0);
