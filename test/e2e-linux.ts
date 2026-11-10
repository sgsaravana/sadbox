// sadbox end to end on Linux: the built binary, serving, driving real Cloud
// Hypervisor VMs the way the browser does — the HTTP API and the terminal's
// WebSocket. Run by kvm.yml after `sadbox setup` (which built the disk):
//
//   SADBOX_BIN=dist/sadbox-linux-x64 SADBOX_DATA=<setup's data dir> bun test/e2e-linux.ts
//
// Creates a project from a local git folder, then checks: its files and a
// shell in tmux; egress only through the proxy (allowed, blocked, no direct
// route, logged); sync back to the folder; port forwards (open, and behind
// sign-in); stop / start; a supervisor restart with the VM left running;
// destroy. Prints PASS/FAIL per check and exits non-zero on any failure.
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BIN = process.env.SADBOX_BIN ?? "dist/sadbox-linux-x64";
const DATA = process.env.SADBOX_DATA;
if (!DATA) { console.error("SADBOX_DATA: the data dir `sadbox setup` used"); process.exit(2); }
const PORT = 17070, PROXY_PORT = 17071, OPEN_PORT = 18080, SIGNIN_PORT = 18081, APP_PORT = 8080;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "e2e-password-0123456789";
const work = mkdtempSync(join(tmpdir(), "sadbox-e2e-"));
const timings: Record<string, number> = {};
const results: { name: string; ok: boolean; detail: string }[] = [];

// ---- the supervisor ----
let server: ReturnType<typeof Bun.spawn> | null = null;
async function serve() {
  server = Bun.spawn([BIN, "serve"], {
    env: {
      ...process.env, SADBOX_DATA: DATA, SADBOX_PORT: String(PORT), SADBOX_HOST: "127.0.0.1",
      SADBOX_PROXY_PORT: String(PROXY_PORT), SADBOX_FORWARD_HOST: "127.0.0.1", SADBOX_PASSWORD: PASSWORD,
      SADBOX_APPROVAL_TIMEOUT_MS: "3000",
    },
    stdout: Bun.file(join(work, "serve.log")), stderr: Bun.file(join(work, "serve.err.log")),
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/auth/status`)).ok) return; } catch {}
    await Bun.sleep(200);
  }
  throw new Error("the supervisor did not come up");
}
async function stopServing() {
  server?.kill("SIGTERM");
  await server?.exited;
  server = null;
}

let cookie = "";
async function api(method: string, path: string, body?: unknown, timeoutMs = 600_000): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j: any = text;
  try { j = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${typeof j === "string" ? j : j.error ?? text}`);
  return j;
}

// ---- the terminal, as the browser has it ----
const ESC = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]/g;
class Term {
  private ws: WebSocket;
  private out = "";
  readonly closed: Promise<number>;
  constructor(projectId: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/projects/${projectId}/term?cols=200&rows=50`, { headers: { cookie } } as any);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => { this.out += typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString(); };
    this.closed = new Promise((r) => { this.ws.onclose = (e) => r(e.code); });
  }
  async open() {
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("terminal did not open")); });
  }
  /** Type a line; wait for `want` in what the screen showed since. The screen
 *  echoes what is typed, so `want` must be something only the output can hold
 *  (`echo X-$((1+1))` → X-2). */
  async run(line: string, want: RegExp, ms = 30_000): Promise<string> {
    const from = this.out.length;
    this.ws.send(new TextEncoder().encode(line + "\r"));
    for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(100)) {
      const seen = this.out.slice(from).replace(ESC, "");
      const m = seen.match(want);
      if (m) return m[0];
    }
    throw new Error(`not seen: ${want} — screen: ${JSON.stringify(this.out.slice(from).replace(ESC, "").slice(-300))}`);
  }
  close() { this.ws.close(); }
}

async function check(name: string, f: () => Promise<string | void>) {
  const t = performance.now();
  try {
    const detail = (await f()) ?? "";
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name} (${Math.round(performance.now() - t)} ms)${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
    console.log(`FAIL  ${name} — ${(e as Error).message}`);
  }
}
const timed = async <T>(k: string, f: () => Promise<T>) => { const t = performance.now(); try { return await f(); } finally { timings[k] = Math.round(performance.now() - t); } };
function expect(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

async function curlStatus(url: string, extra: string[] = []): Promise<{ status: number; body: string; headers: string }> {
  const p = Bun.spawn(["curl", "-sS", "-D", "-", "--max-time", "15", ...extra, url], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const i = out.indexOf("\r\n\r\n");
  return { status: Number(out.split(" ")[1]) || 0, headers: out.slice(0, i), body: out.slice(i + 4) };
}

// ---- the run ----
const src = join(work, "src");
async function git(...args: string[]) {
  const p = Bun.spawn(["git", "-C", src, ...args], { stdout: "ignore", stderr: "pipe" });
  if (await p.exited !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}
Bun.spawnSync(["mkdir", "-p", src]);
writeFileSync(join(src, "README.md"), "e2e project from the host\n");
await git("init", "-q", "-b", "main");
await git("-c", "user.email=e2e@sadbox", "-c", "user.name=e2e", "add", ".");
await git("-c", "user.email=e2e@sadbox", "-c", "user.name=e2e", "commit", "-q", "-m", "first");

let id = "";
let term: Term | null = null;
try {
  await check("the supervisor serves, and signs in", async () => {
    await serve();
    const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    expect(res.ok, `login: HTTP ${res.status}`);
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie.startsWith("sadbox_session="), "no session cookie");
  });

  await check("the VM backend is ready", async () => {
    const s = await api("GET", "/api/system/status");
    expect(s.running === true, JSON.stringify(s));
    return s.version;
  });

  await api("POST", "/api/net/rules", { action: "allow", host: "example.com" });
  await api("POST", "/api/net/rules", { action: "block", host: "example.org" });

  await check("create a project from a local git folder", async () => {
    const p = await timed("createMs", () => api("POST", "/api/projects", { name: "e2e", sourcePath: src }));
    id = p.id;
    expect(p.state === "running", `state ${p.state}: ${p.error ?? ""}`);
    return `${timings.createMs} ms`;
  });
  if (!id) throw new Error("no project, nothing more to check");

  await check("the terminal: tmux in the workdir, with the folder's files", async () => {
    term = new Term(id);
    await term.open();
    await term.run("cat README.md; echo E2E-$((6*7)) $(whoami) $(pwd)", /E2E-42 agent \/home\/agent\/workdir/);
    await term.run("echo TMUX=$TMUX", /TMUX=\/tmp\/tmux-\d+\/default/);
  });

  await check("egress: an allowed host, through the proxy", async () => {
    return term!.run("curl -s -o /dev/null -w 'ALLOWED=%{http_code}\\n' https://example.com", /ALLOWED=\d+/, 45_000)
      .then((s) => { expect(s === "ALLOWED=200", s); return s; });
  });

  await check("egress: a blocked host is refused", async () => {
    const s = await term!.run("curl -s -o /dev/null -w 'BLOCKED=%{http_code}\\n' https://example.org; true", /BLOCKED=\d+/, 45_000);
    expect(s !== "BLOCKED=200", s);
    return s;
  });

  await check("egress: no way out but the proxy", async () => {
    await term!.run("r=none; curl -s -m 5 --noproxy '*' https://example.com >/dev/null && r=open; echo \"DIRECT:$r:\"", /DIRECT:(open|none):/)
      .then((s) => expect(s === "DIRECT:none:", s));
    await term!.run("echo \"IF:$(ls /sys/class/net | tr '\\n' ,):IF\"", /IF:[^:$]*:IF/).then((s) => expect(s === "IF:lo,:IF", s));
  });

  await check("the proxy logged the VM's requests", async () => {
    const r = await api("GET", `/api/projects/${id}/net/requests`);
    const hosts = new Set((r.requests as any[]).map((x) => x.host));
    expect(hosts.has("example.com") && hosts.has("example.org"), [...hosts].join(", "));
    return [...hosts].join(", ");
  });

  await check("sync back: a file made in the VM reaches the folder", async () => {
    await term!.run("echo from-the-vm > made-in-vm.txt && echo WROTE-$((1+1))", /WROTE-2/);
    await api("POST", `/api/projects/${id}/sync`, {});
    expect(existsSync(join(src, "made-in-vm.txt")) && readFileSync(join(src, "made-in-vm.txt"), "utf8") === "from-the-vm\n", "not in the folder");
  });

  await check("port forward, open to anyone", async () => {
    await term!.run(`(nohup bun -e 'Bun.serve({port:${APP_PORT},fetch:()=>new Response("hello from the vm")})' >/dev/null 2>&1 &) ; sleep 1; echo APP-$((2+3))`, /APP-5/);
    await api("POST", `/api/projects/${id}/forwards`, { hostPort: OPEN_PORT, guestPort: APP_PORT, access: "open" });
    let r = { status: 0, body: "", headers: "" };
    for (let i = 0; i < 20 && r.body !== "hello from the vm"; i++, await Bun.sleep(300)) r = await curlStatus(`http://127.0.0.1:${OPEN_PORT}/`);
    expect(r.body === "hello from the vm", `HTTP ${r.status} ${r.body.slice(0, 100)}`);
  });

  await check("port forward behind sign-in: refused, then let in by the UI's ticket", async () => {
    const f = await api("POST", `/api/projects/${id}/forwards`, { hostPort: SIGNIN_PORT, guestPort: APP_PORT });
    const anon = await curlStatus(`http://127.0.0.1:${SIGNIN_PORT}/`);
    expect(!anon.body.includes("hello from the vm"), "served without signing in");
    const jar = join(work, "jar");
    const r = await curlStatus(`${BASE}/forwards/${f.id}/open`, ["-L", "-b", cookie, "-c", jar]);
    expect(r.body.includes("hello from the vm"), `HTTP ${r.status} ${r.body.slice(0, 100)}`);
    const again = await curlStatus(`http://127.0.0.1:${SIGNIN_PORT}/`, ["-b", jar]);
    expect(again.body === "hello from the vm", "the forward's cookie did not let it in");
  });

  await check("stop and start: the disk is kept, and egress works again", async () => {
    term?.close();
    await timed("stopMs", () => api("POST", `/api/projects/${id}/stop`));
    const stopped = (await api("GET", "/api/projects") as any[]).find((p) => p.id === id);
    expect(stopped?.state === "stopped", `state ${stopped?.state}`);
    await timed("startMs", () => api("POST", `/api/projects/${id}/start`));
    term = new Term(id);
    await term.open();
    await term.run("cat made-in-vm.txt", /from-the-vm/);
    await term.run("curl -s -o /dev/null -w 'AGAIN=%{http_code}\\n' https://example.com", /AGAIN=\d+/, 45_000).then((s) => expect(s === "AGAIN=200", s));
    return `stop ${timings.stopMs} ms, start ${timings.startMs} ms`;
  });

  await check("a supervisor restart leaves the VM running and reachable", async () => {
    term?.close();
    await stopServing();
    await serve();
    const p = (await api("GET", "/api/projects") as any[]).find((x) => x.id === id);
    expect(p?.state === "running", `state ${p?.state}`);
    term = new Term(id);
    await term.open();
    await term.run("cat README.md", /e2e project from the host/);
    await term.run("curl -s -o /dev/null -w 'AFTER=%{http_code}\\n' https://example.com", /AFTER=\d+/, 45_000).then((s) => expect(s === "AFTER=200", s));
  });

  await check("destroy", async () => {
    term?.close();
    await timed("destroyMs", () => api("DELETE", `/api/projects/${id}`));
    const left = (await api("GET", "/api/projects") as any[]).find((x) => x.id === id);
    expect(!left || left.state === "destroyed", `still ${left?.state}`);
    expect(!existsSync(join(DATA, "kvm", "vms", "sadbox-e2e")), "the VM's folder is still there");
    id = "";
  });
} finally {
  term?.close();
  if (id) await api("DELETE", `/api/projects/${id}`).catch(() => {});
  await stopServing().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed; timings ${JSON.stringify(timings)}`);
  if (failed.length) for (const f of ["serve.log", "serve.err.log"]) {
    try { console.log(`--- ${f}\n${readFileSync(join(work, f), "utf8").split("\n").slice(-40).join("\n")}`); } catch {}
  }
  if (process.env.SADBOX_E2E_JSON) writeFileSync(process.env.SADBOX_E2E_JSON, JSON.stringify({ results, timings }, null, 2));
  rmSync(work, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
