// Spike D — host-side smoke test of the patched proxy, no VM needed.
//   git apply spikes/d-credential-proxy/proxy.patch
//   bun spikes/d-credential-proxy/smoke.ts
//   git apply -R spikes/d-credential-proxy/proxy.patch
//
// Starts the real proxy (throwaway data dir, a stub `container` CLI that
// reports one fake VM at 127.0.0.1, loopback port), allows httpbin.org
// globally, and drives it with curl through the proxy's CA. Uses dummy token
// strings only — httpbin echoes what it gets.
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "spike-d-"));
const port = 17000 + Math.floor(Math.random() * 1000);
const BOUND = { name: "DEMO_TOKEN", placeholder: "ghp_sbxDEMOPLACEHOLDER0000", value: "ghp_DEMOREALVALUE11111111", hosts: ["httpbin.org"] };
const OTHER = { name: "OTHER_TOKEN", placeholder: "sk-sbxOTHERPLACEHOLDER", value: "sk-OTHERREAL", hosts: ["api.example.com"] };
writeFileSync(join(dir, "map.json"), JSON.stringify({ secrets: [BOUND, OTHER] }));

// The proxy only serves TCP clients that are project VMs (by source address):
// a stub `container` lists one VM, "sadbox-spike", at 127.0.0.1.
const vm = '{"configuration":{"id":"sadbox-spike"},"status":{"state":"running","networks":[{"ipv4Address":"127.0.0.1/24"}]}}';
const stub = join(dir, "container");
writeFileSync(stub, `#!/bin/sh\ncase "$1" in list) echo '[${vm}]';; inspect) echo '[${vm}]';; *) exit 1;; esac\n`);
chmodSync(stub, 0o755);

// config is read at import time, so the environment goes first
Object.assign(process.env, {
  SADBOX_DATA: dir,
  SADBOX_PROXY_PORT: String(port),
  SADBOX_PROXY_HOST: "127.0.0.1",
  SADBOX_CONTAINER_BIN: stub,
  SADBOX_SPIKE_SUBST: join(dir, "map.json"),
});
const { startProxy } = await import("../../src/net/proxy");
const { createRule } = await import("../../src/net/rules");
const { caCertPath } = await import("../../src/config");
const { db } = await import("../../src/db");

db.query("INSERT INTO projects (id, name, image, state, source_path) VALUES ('spike', 'spike', 'x', 'running', '/tmp')").run();

createRule({ scope: "global", action: "allow", host: "httpbin.org" });
await startProxy();
await Bun.sleep(300);

async function curl(url: string, header: string): Promise<{ body: string; headers: string }> {
  const p = Bun.spawn(["curl", "-sS", "--suppress-connect-headers", "-D", "-", "--max-time", "20", "--proxy", `http://127.0.0.1:${port}`, "--cacert", caCertPath(), "-H", header, url], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`curl ${url}: ${err}`);
  const i = out.indexOf("\r\n\r\n");
  return { headers: out.slice(0, i), body: out.slice(i + 4) };
}

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}

// 1. bound host: placeholder leaves as the real value (httpbin echoes it in the body)
{
  const r = await curl("https://httpbin.org/headers", `Authorization: Bearer ${BOUND.placeholder}`);
  check("bearer swapped on bound host", r.body.includes(BOUND.value) && !r.body.includes(BOUND.placeholder));
  check("body echo leaks real value (expected v1 limitation)", r.body.includes(BOUND.value));
}
// 2. git-style Basic auth
{
  const basic = Buffer.from(`x-access-token:${BOUND.placeholder}`).toString("base64");
  const r = await curl("https://httpbin.org/headers", `Authorization: Basic ${basic}`);
  const want = Buffer.from(`x-access-token:${BOUND.value}`).toString("base64");
  check("basic swapped on bound host", r.body.includes(want));
}
// 3. a placeholder bound elsewhere is not swapped here
{
  const r = await curl("https://httpbin.org/headers", `X-Api-Key: ${OTHER.placeholder}`);
  check("unbound placeholder left alone", r.body.includes(OTHER.placeholder) && !r.body.includes(OTHER.value));
}
// 4. plain http never gets the real value
{
  const r = await curl("http://httpbin.org/headers", `Authorization: Bearer ${BOUND.placeholder}`);
  check("plain http not swapped", r.body.includes(BOUND.placeholder) && !r.body.includes(BOUND.value));
}
// 5. response header carrying the real value comes back as the placeholder
{
  const r = await curl(`https://httpbin.org/response-headers?X-Echo=${BOUND.value}`, "X-Noop: 1");
  const echo = r.headers.split("\r\n").find((l) => l.toLowerCase().startsWith("x-echo:")) ?? "";
  check("response header redacted", echo.includes(BOUND.placeholder) && !echo.includes(BOUND.value), echo.trim());
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
