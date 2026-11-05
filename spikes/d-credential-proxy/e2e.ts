// End-to-end check of the built credential proxy (C2), no patch and no VM:
//   bun spikes/d-credential-proxy/e2e.ts
// Starts the real proxy on a throwaway data dir with a stub `container` CLI
// that reports one fake VM at 127.0.0.1, creates proxy-delivered secrets the
// normal way, and drives the proxy with curl. httpbin.org is the upstream and
// echoes what it receives. Dummy token strings only.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "c2-")); // short: unix socket paths are limited
const port = 18000 + Math.floor(Math.random() * 1000);
const vm = '{"configuration":{"id":"sadbox-e2e"},"status":{"state":"running","networks":[{"ipv4Address":"127.0.0.1/24"}]}}';
const stub = join(dir, "container");
writeFileSync(stub, `#!/bin/sh\ncase "$1" in list) echo '[${vm}]';; inspect) echo '[${vm}]';; *) exit 1;; esac\n`);
chmodSync(stub, 0o755);

Object.assign(process.env, {
  SADBOX_DATA: dir, SADBOX_PROXY_PORT: String(port), SADBOX_PROXY_HOST: "127.0.0.1", SADBOX_CONTAINER_BIN: stub,
  SADBOX_APPROVAL_TIMEOUT_MS: "5000",
});
const { startProxy } = await import("../../src/net/proxy");
const { createRule } = await import("../../src/net/rules");
const { caCertPath } = await import("../../src/config");
const { db } = await import("../../src/db");
const { createItem } = await import("../../src/core/vault");
const { placeholderFor } = await import("../../src/core/placeholders");
const { listPending, resolveApproval } = await import("../../src/net/approvals");
const { recentRequests } = await import("../../src/net/events");

const P = "e2e";
db.query("INSERT INTO projects (id, name, image, state, source_path) VALUES (?, 'e2e', 'x', 'running', '/tmp')").run(P);
createRule({ scope: "global", action: "allow", host: "httpbin.org" });

const REAL = "ghp_DUMMYREAL0000000000000000000000000000";
const s = createItem({ name: "DEMO_TOKEN", value: REAL, mode: "proxy", bindings: [{ host: "httpbin.org", path: "/headers" }], projectIds: [P] });
const PH = placeholderFor(P, s.id, REAL); // what injectVault would write into the VM

await startProxy();
await Bun.sleep(300);

async function curl(url: string, header: string, ...extra: string[]) {
  const p = Bun.spawn(["curl", "-sS", "--suppress-connect-headers", "-D", "-", "--max-time", "20",
    "--proxy", `http://127.0.0.1:${port}`, "--cacert", caCertPath(), "-H", header, ...extra, url], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const i = out.indexOf("\r\n\r\n");
  return { status: Number(out.split(" ")[1]), headers: out.slice(0, i), body: out.slice(i + 4) };
}
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const lastRow = () => recentRequests(P).at(-1)!;

{
  const r = await curl("https://httpbin.org/headers", `Authorization: Bearer ${PH}`);
  // httpbin echoes the request: the real value came back (so it was sent) and was redacted on the way in
  check("bound: real value sent upstream, its echo redacted", (lastRow().redacted ?? []).includes("DEMO_TOKEN") && r.body.includes(PH) && !r.body.includes(REAL));
  check("bound: log names the secret, never the value", JSON.stringify(lastRow().credentials) === '["DEMO_TOKEN"]' && !JSON.stringify(recentRequests(P)).includes(REAL));
}
{
  const basic = Buffer.from(`x-access-token:${PH}`).toString("base64");
  const r = await curl("https://httpbin.org/headers", `Authorization: Basic ${basic}`);
  check("bound: Basic swapped", r.body.includes(Buffer.from(`x-access-token:${REAL}`).toString("base64")));
}
{
  const r = await curl("http://httpbin.org/headers", `Authorization: Bearer ${PH}`);
  check("plain http: 403, nothing sent", r.status === 403 && r.body.includes("only sent over https"), r.body.trim());
}
{
  // /anything isn't bound (binding path is /headers): held for approval, denied once
  const pending = curl("https://httpbin.org/anything", `Authorization: Bearer ${PH}`);
  let ask; for (let i = 0; i < 50 && !ask; i++) { await Bun.sleep(100); ask = listPending(P).find((p) => p.credential); }
  check("unbound: approval raised with the secret's name", ask?.credential?.name === "DEMO_TOKEN");
  resolveApproval(ask!.id, "block", "once");
  const r = await pending;
  check("unbound + denied: 403", r.status === 403 && r.body.includes("DEMO_TOKEN is not allowed"), r.body.trim());
}
{
  const pending = curl("https://httpbin.org/anything", `Authorization: Bearer ${PH}`);
  let ask; for (let i = 0; i < 50 && !ask; i++) { await Bun.sleep(100); ask = listPending(P).find((p) => p.credential); }
  resolveApproval(ask!.id, "allow", "once");
  const r = await pending;
  check("unbound + allowed once: real value sent", r.status === 200 && (lastRow().redacted ?? []).includes("DEMO_TOKEN") && !r.body.includes(REAL));
}
{
  const r = await curl(`https://httpbin.org/response-headers?X-Echo=${REAL}`, "X-Noop: 1");
  const echo = r.headers.split("\r\n").find((l) => l.toLowerCase().startsWith("x-echo:")) ?? "";
  check("response header redacted to the placeholder", echo.includes(PH) && !echo.includes(REAL), echo.trim());
  check("log records the redaction", JSON.stringify(lastRow().redacted) === '["DEMO_TOKEN"]');
}
{
  const r = await curl(`https://httpbin.org/headers?k=${PH}`, "X-Noop: 1");
  check("placeholder in URL: flagged, not swapped", JSON.stringify(lastRow().credentialInUrl) === '["DEMO_TOKEN"]' && !r.body.includes(REAL));
}

// ---- vault step 3: URL and body swapping, typed values, body redaction ----
const KEY_REAL = "kq_DUMMYREALKEY000000000000000";
const key = createItem({ name: "QUERY_KEY", value: KEY_REAL, mode: "proxy", swapUrl: true, bindings: [{ host: "httpbin.org" }], projectIds: [P] });
const KEY_PH = placeholderFor(P, key.id, KEY_REAL);
const lim = createItem({ name: "LIMIT", value: "50", type: "number", kind: "variable", mode: "proxy", swapBody: true, bindings: [{ host: "httpbin.org" }], projectIds: [P] });
const LIM_PH = placeholderFor(P, lim.id, "50");
const BODY_REAL = "bt_DUMMYREALBODYTOKEN00000000000";
const bt = createItem({ name: "BODY_TOKEN", value: BODY_REAL, mode: "proxy", swapBody: true, bindings: [{ host: "httpbin.org" }], projectIds: [P] });
const BT_PH = placeholderFor(P, bt.id, BODY_REAL);
{
  const r = await curl(`https://httpbin.org/get?key=${KEY_PH}`, "X-Noop: 1");
  const args = JSON.parse(r.body).args ?? {};
  check("URL: swapped upstream, and the echo is redacted back", lastRow().credentials?.includes("QUERY_KEY") && args.key === KEY_PH && !r.body.includes(KEY_REAL),
    JSON.stringify(args));
}
{
  const body = JSON.stringify({ limit: LIM_PH, token: BT_PH, note: `Bearer ${BT_PH}` });
  const r = await curl("https://httpbin.org/anything", "Content-Type: application/json", "--data-binary", body);
  const sent = JSON.parse(r.body).json ?? {};
  check("body: a typed number arrives as a number", sent.limit === 50, JSON.stringify(sent));
  check("body: string swapped upstream (log), echoed back as the placeholder", lastRow().credentials?.includes("BODY_TOKEN")
    && sent.token === BT_PH && sent.note === `Bearer ${BT_PH}` && !r.body.includes(BODY_REAL));
  check("body: log records the body redaction", (lastRow().redacted ?? []).includes("BODY_TOKEN"));
}
{
  const r = await curl("https://httpbin.org/gzip", `Authorization: Bearer ${KEY_PH}`, "--compressed");
  check("gzip response: decoded and redacted", r.status === 200 && r.body.includes(KEY_PH) && !r.body.includes(KEY_REAL) && !/content-encoding/i.test(r.headers),
    r.body.slice(0, 80));
}
{
  const r = await curl("https://httpbin.org/stream/3", `Authorization: Bearer ${KEY_PH}`);
  const lines = r.body.trim().split("\n");
  check("streamed response: every line redacted", lines.length === 3 && lines.every((l) => l.includes(KEY_PH) && !l.includes(KEY_REAL)),
    `${lines.length} line(s)`);
}

{
  // the vault's own name, through the proxy's front door (not a link to a project "vault")
  const p = Bun.spawn(["curl", "-sS", "--max-time", "10", "--proxy", `http://127.0.0.1:${port}`,
    "http://vault.sadbox.internal/git/credential?host=httpbin.org"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  // several items are bound to httpbin.org; the helper gets one of them — always a placeholder
  const reals = [REAL, KEY_REAL, BODY_REAL];
  check("vault.sadbox.internal answered by the vault: git gets a placeholder",
    /^username=x-access-token\npassword=\S*sbx\S+\n$/.test(out) && !reals.some((r) => out.includes(r)), out.trim().split("\n").pop());
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
