// The egress proxy every project VM routes through. A raw net server catches
// CONNECT itself (Bun's http server never fires 'connect'), MITM-terminates TLS
// with a per-host cert (Bun's SNICallback is broken, so one static-cert https
// server per host), and pipes the decrypted stream through a loopback into that
// server for HTTP parsing. Requests are then filtered, header-rewritten, logged
// live, and held for approval when no rule matches (block-by-default).
//
// Two hard-won gotchas, both proven in spikes:
//   * never call socket.resume() by hand after CONNECT — pipe() resumes the
//     source; a manual resume races ahead and drops the client's ClientHello.
//   * openssl must run async (Bun.spawn); a sync spawn blocks the event loop
//     and deadlocks the handshake it is minting a cert for.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config, runDir } from "../config";
import { startGuestRelay } from "./guest";
import { db } from "../db";
import { logEvent } from "../db";
import { getDriver } from "../driver";
import { ensureCA, certForHost, leafKey, caCertPem, caReady } from "./ca";
import { evaluate, applyHeaders } from "./rules";
import { requestApproval } from "./approvals";
import { inSetup } from "./setup";
import { recordRequest, type RequestEntry } from "./events";

const driver = getDriver();
// local copy of core/projects' refFor to avoid a proxy<->projects import cycle
const refFor = (name: string) => `sadbox-${name}`;

// ---- guest IP -> project, refreshed from the driver ----
let ipMap = new Map<string, { id: string; name: string }>();
let ipMapAt = 0;

const ipMapRows = () => db.query<{ id: string; name: string }, []>(
  "SELECT id, name FROM projects WHERE state != 'destroyed'").all();

async function refreshIpMap(): Promise<void> {
  const live = await driver.list().catch(() => []);
  const rows = db.query<{ id: string; name: string }, []>(
    "SELECT id, name FROM projects WHERE state != 'destroyed'",
  ).all();
  const byRef = new Map(rows.map((p) => [refFor(p.name), p]));
  const m = new Map<string, { id: string; name: string }>();
  for (const info of live) {
    if (!info.address) continue;
    const p = byRef.get(info.ref);
    if (p) m.set(info.address, p);
  }
  ipMap = m;
  ipMapAt = Date.now();
}

async function projectForIp(ip: string): Promise<{ id: string; name: string } | null> {
  const norm = ip.replace(/^::ffff:/, "");
  if (Date.now() - ipMapAt > 3000) await refreshIpMap().catch(() => {});
  let p = ipMap.get(norm);
  if (!p) { await refreshIpMap().catch(() => {}); p = ipMap.get(norm); }
  return p ?? null;
}

// ---- loopback context (which decrypted connection belongs to which client) ----
// projectId is set when the client came in over that project's own socket (a
// network-less VM); legacy VMs on a real network are identified by source IP.
type Ctx = { scheme: "http" | "https"; clientIp: string; projectId?: string; connectHost?: string; connectPort?: number };
const ctxByPort = new Map<number, Ctx>();

/** Split "host", "host:port" or "[v6]:port" — `def` when no port is given. */
function splitHostPort(s: string, def: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]*)(?::(\d+))?$/.exec(s);
  if (!m) return { host: s, port: def };
  return { host: m[1], port: m[2] ? Number(m[2]) : def };
}

// ---- where a request may go ----
// The proxy runs on the host, so "any address" would include the host itself
// and the network it sits on. Targets are therefore classified by the address
// they actually resolve to (not the name the VM asked for), and the connection
// is then made to that same address, so a name cannot resolve one way for the
// check and another way for the connect.
//   self    — this machine (loopback, any of its interfaces): never allowed.
//   private — LAN / link-local ranges: only with a rule naming that host;
//             a catch-all "*" rule or the setup window does not cover them.
//   public  — everything else: ordinary rules.
type Reach = "self" | "private" | "public";

function ownAddresses(): Set<string> {
  const s = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) s.add(i.address.toLowerCase());
  return s;
}

export function classifyAddress(addr: string, own: Set<string> = ownAddresses()): Reach {
  let a = addr.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (own.has(a)) return "self";
  if (net.isIPv4(a)) {
    const [x, y] = a.split(".").map(Number);
    if (x === 127 || x === 0) return "self";
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return "private";
    if ((x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127)) return "private"; // link-local, CGNAT
    return "public";
  }
  if (a === "::1" || a === "::") return "self";
  if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return "private"; // unique-local, link-local
  return "public";
}

const REACH_RANK: Record<Reach, number> = { public: 0, private: 1, self: 2 };

/** Resolve a target and classify it by the most sensitive address it maps to. */
async function resolveTarget(host: string): Promise<{ address: string; reach: Reach } | null> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return { address: "127.0.0.1", reach: "self" };
  let addrs: string[];
  if (net.isIP(bare)) addrs = [bare];
  else {
    try { addrs = (await dns.lookup(bare, { all: true })).map((r) => r.address); } catch { return null; }
  }
  if (!addrs.length) return null;
  const own = ownAddresses();
  let reach: Reach = "public";
  for (const a of addrs) { const r = classifyAddress(a, own); if (REACH_RANK[r] > REACH_RANK[reach]) reach = r; }
  return { address: addrs.find((a) => net.isIPv4(a)) ?? addrs[0], reach };
}

let seq = 0;
const rid = () => `${(++seq).toString(36)}-${Date.now().toString(36)}`;

// ---- the request handler (shared by the http + per-host https servers) ----
function makeHandler(scheme: "http" | "https") {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const ctx = ctxByPort.get(req.socket.remotePort!) ?? { scheme, clientIp: "" };
    let host: string, path: string, port: number;
    if (scheme === "https") {
      host = splitHostPort(req.headers.host || ctx.connectHost || "", 443).host;
      port = ctx.connectPort ?? 443; // the CONNECT target is authoritative for the port
      path = req.url || "/";
    } else {
      try {
        const u = new URL(req.url!);
        host = u.hostname; port = u.port ? Number(u.port) : 80; path = u.pathname + u.search;
      } catch {
        ({ host, port } = splitHostPort(req.headers.host || "", 80));
        path = req.url || "/";
      }
    }
    const method = req.method || "GET";
    const started = Date.now();

    const projectId = ctx.projectId ?? (await projectForIp(ctx.clientIp))?.id ?? null;

    const target = await resolveTarget(host);
    let verdict = evaluate(projectId, { host, path, method });
    if (target?.reach === "self") verdict = { decision: "block" };
    else {
      // a LAN address needs a rule that names it — "*" was not written with it in mind
      const lan = target?.reach === "private";
      if (lan && verdict.decision === "allow" && verdict.rule?.host === "*") verdict = { decision: "ask" };
      if (verdict.decision === "ask") {
        if (!projectId) verdict = { decision: "block" }; // unknown source: deny
        // the supervisor's own provisioning (clone, apt) — nobody is there to approve
        else if (inSetup(projectId) && !lan) verdict = { decision: "allow" };
        else verdict = { decision: await requestApproval({ projectId, host, method, scheme, path }) };
      }
    }
    if (verdict.decision === "allow" && !target) {
      req.resume();
      try { res.writeHead(502, { "content-type": "text/plain" }); res.end(`sadbox: cannot resolve ${host}\n`); } catch {}
      log(projectId, { id: rid(), ts: started, method, scheme, host, path, status: 502, decision: "allowed", reqBytes: 0, respBytes: 0, durationMs: Date.now() - started, error: "cannot resolve host" });
      return;
    }

    if (verdict.decision === "block") {
      req.resume(); // drain body
      try { res.writeHead(403, { "content-type": "text/plain" }); res.end(`sadbox: blocked ${host}\n`); } catch {}
      log(projectId, { id: rid(), ts: started, method, scheme, host, path, status: 403, decision: "blocked", reqBytes: 0, respBytes: 0, durationMs: Date.now() - started });
      return;
    }

    // allowed -> forward upstream
    const headers: Record<string, unknown> = { ...req.headers };
    delete headers["proxy-connection"];
    if (projectId) applyHeaders(projectId, host, "request", headers);

    let reqBytes = 0, respBytes = 0;
    req.on("data", (c: Buffer) => { reqBytes += c.length; });

    const mod = scheme === "https" ? https : http;
    const up = mod.request(
      // connect to the address that was classified; Host header + SNI keep the name
      { host: target!.address, port, method, path, headers: headers as any, ...(net.isIP(host) ? {} : { servername: host }) },
      (upRes) => {
        const out: Record<string, unknown> = { ...upRes.headers };
        if (projectId) applyHeaders(projectId, host, "response", out);
        try { res.writeHead(upRes.statusCode || 502, out as any); } catch {}
        upRes.on("data", (c: Buffer) => { respBytes += c.length; });
        upRes.pipe(res);
        upRes.on("end", () => log(projectId, {
          id: rid(), ts: started, method, scheme, host, path, status: upRes.statusCode ?? null,
          decision: "allowed", ruleId: verdict.rule?.id ?? null, reqBytes, respBytes, durationMs: Date.now() - started,
        }));
      },
    );
    up.on("error", (e: Error) => {
      try { res.writeHead(502, { "content-type": "text/plain" }); res.end(`sadbox: upstream error: ${e.message}\n`); } catch {}
      log(projectId, {
        id: rid(), ts: started, method, scheme, host, path, status: 502, decision: "allowed",
        ruleId: verdict.rule?.id ?? null, reqBytes, respBytes, durationMs: Date.now() - started, error: e.message,
      });
    });
    req.pipe(up);
  };
}

function log(projectId: string | null, entry: RequestEntry): void {
  if (projectId) recordRequest(projectId, entry);
}

// ---- servers ----
let httpServer: http.Server | null = null;
let httpPort = 0;
const hostServers = new Map<string, Promise<number>>();

function serverForHost(host: string): Promise<number> {
  let pr = hostServers.get(host);
  if (pr) return pr;
  pr = (async () => {
    const cert = await certForHost(host);
    return await new Promise<number>((resolve, reject) => {
      const s = https.createServer({ key: leafKey(), cert }, makeHandler("https"));
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port));
    });
  })().catch((e) => { hostServers.delete(host); throw e; });
  hostServers.set(host, pr);
  return pr;
}

function toLoopback(stream: net.Socket, port: number, ctx: Ctx, prefix?: Buffer): void {
  const lb = net.connect(port, "127.0.0.1", () => {
    ctxByPort.set(lb.localPort!, ctx);
    if (prefix && prefix.length) lb.write(prefix);
    stream.pipe(lb);
    lb.pipe(stream);
  });
  lb.on("close", () => { if (lb.localPort) ctxByPort.delete(lb.localPort); });
  lb.on("error", () => { try { stream.destroy(); } catch {} });
  stream.on("error", () => { try { lb.destroy(); } catch {} });
}

// ---- per-project sockets: the proxy channel into a network-less VM ----
// Each VM publishes one unix socket to the host (see net/guest.ts). The proxy
// keeps a few idle connections dialed into it; the VM's relay hands each of its
// programs one of them, and the first bytes to arrive are that program's proxy
// request. Whatever arrives on a project's socket is that project — no guessing
// from addresses — and since the host does the dialing, a supervisor restart
// just means the pool is re-dialed.
const CARRIERS = 8;
type Pool = { path: string; idle: Set<net.Socket>; dialing: number; failures: number; timer: ReturnType<typeof setTimeout> | null; stopped: boolean };
const pools = new Map<string, Pool>();

export function projectSocketPath(projectId: string): string {
  const p = join(runDir(), `${projectId}.sock`);
  // sun_path is 104 bytes on macOS; a longer path cannot be created or dialed
  if (Buffer.byteLength(p) > 100) throw new Error(`data dir path is too long for a unix socket (${p}) — set SADBOX_DATA to a shorter path`);
  return p;
}

function fill(projectId: string): void {
  const pool = pools.get(projectId);
  if (!pool || pool.stopped) return;
  // while the VM is not answering, probe with a single dial instead of a full set
  const want = pool.failures > 0 ? 1 : CARRIERS;
  while (pool.idle.size + pool.dialing < want) dial(projectId, pool);
}

function dial(projectId: string, pool: Pool): void {
  pool.dialing++;
  let connected = false, used = false;
  const s = net.connect(pool.path);
  s.on("error", () => {});
  s.once("connect", () => {
    connected = true; pool.dialing--; pool.idle.add(s);
    // still open a moment later: the relay is really there — dial the rest
    setTimeout(() => { if (!s.destroyed && pool.failures > 0) { pool.failures = 0; fill(projectId); } }, 1000);
    acceptClient(s, projectId, () => {   // a program in the VM took this carrier
      used = true; pool.failures = 0; pool.idle.delete(s);
      fill(projectId);
    });
  });
  s.on("close", () => {
    if (!connected) pool.dialing--;
    pool.idle.delete(s);
    if (used || pool.stopped) return;
    // An idle carrier should stay open. One that closes (or never connects)
    // means nothing is listening in the VM: stopped, still booting, or the
    // relay is gone. Retry on a backoff rather than spinning.
    pool.failures++;
    if (pool.timer) return;
    pool.timer = setTimeout(() => {
      pool.timer = null;
      if (pool.failures % 4 === 0) void reviveRelay(projectId);
      fill(projectId);
    }, Math.min(5000, 250 * 2 ** Math.min(pool.failures, 5)));
  });
}

/** The VM is up but its relay is not answering (VM was restarted, or the relay
 *  was killed): start it again. */
async function reviveRelay(projectId: string): Promise<void> {
  const p = db.query<{ name: string }, [string]>(
    "SELECT name FROM projects WHERE id=? AND state='running'").get(projectId);
  if (!p) return;
  const info = await driver.inspect(refFor(p.name)).catch(() => null);
  if (info?.state === "running" && info.isolated) await startGuestRelay(refFor(p.name)).catch(() => {});
}

/** Start keeping carriers dialed into a project's socket (idempotent). Returns
 *  the host path the VM's socket must be published at. */
export function openProjectSocket(projectId: string): string {
  const path = projectSocketPath(projectId);
  if (!pools.has(projectId)) {
    mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    chmodSync(runDir(), 0o700); // whoever can dial these sockets can read a VM's traffic
    pools.set(projectId, { path, idle: new Set(), dialing: 0, failures: 0, timer: null, stopped: false });
  }
  fill(projectId);
  return path;
}

/** Drop the current carriers and dial fresh ones — after a VM is (re)created
 *  the old ones point at a VM that no longer exists. */
export function redialProjectSocket(projectId: string): void {
  const pool = pools.get(projectId);
  if (!pool) return;
  for (const s of [...pool.idle]) s.destroy();
  pool.failures = 0;
  if (pool.timer) { clearTimeout(pool.timer); pool.timer = null; }
  fill(projectId);
}

export function closeProjectSocket(projectId: string): void {
  const pool = pools.get(projectId);
  if (pool) {
    pool.stopped = true;
    if (pool.timer) clearTimeout(pool.timer);
    for (const s of pool.idle) s.destroy();
    pools.delete(projectId);
  }
  try { rmSync(join(runDir(), `${projectId}.sock`), { force: true }); } catch {}
}

// ---- guest wiring: trust the CA + point tools at the proxy ----
export async function installGuestProxy(ref: string): Promise<void> {
  if (!caReady()) throw new Error("proxy CA not initialized (is openssl installed?)");
  const ca = caCertPem();

  const install = await driver.execWithStdin(
    ref,
    `umask 022 && cat > ${config.guestCaPath} && update-ca-certificates >/dev/null 2>&1`,
    new TextEncoder().encode(ca),
    { user: "root" },
  );
  if (install.exitCode !== 0) throw new Error(`CA install failed: ${install.stderr}`);

  // A network-less VM reaches the proxy through the relay on its own loopback;
  // a legacy VM on a real network dials the host's address on that network.
  const info = await driver.inspect(ref);
  let url: string, noProxy = "localhost,127.0.0.1,::1";
  if (info.isolated) {
    await startGuestRelay(ref);
    url = `http://127.0.0.1:${config.guestProxyPort}`;
    const owner = [...ipMapRows()].find((p) => refFor(p.name) === ref);
    if (owner) redialProjectSocket(owner.id); // carriers dialed before the relay was up are dead
  } else {
    if (!info.gateway) throw new Error("VM has no network gateway (is it running?)");
    url = `http://${info.gateway}:${config.proxyPort}`;
    noProxy += `,${info.gateway}`;
  }
  const env = [
    `export HTTP_PROXY="${url}"`, `export HTTPS_PROXY="${url}"`, `export ALL_PROXY="${url}"`,
    `export http_proxy="${url}"`, `export https_proxy="${url}"`, `export all_proxy="${url}"`,
    `export NO_PROXY="${noProxy}"`, `export no_proxy="${noProxy}"`,
    `export NODE_EXTRA_CA_CERTS="${config.guestCaPath}"`,
    `export NODE_USE_ENV_PROXY=1`, // Node's built-in fetch ignores the proxy vars without it
    `export REQUESTS_CA_BUNDLE="${config.guestCaBundle}"`,
    `export SSL_CERT_FILE="${config.guestCaBundle}"`,
    `export GIT_SSL_CAINFO="${config.guestCaBundle}"`,
    "",
  ].join("\n");
  const write = await driver.execWithStdin(
    ref,
    `mkdir -p $(dirname ${config.guestNetEnvFile}) && umask 077 && cat > ${config.guestNetEnvFile}`,
    new TextEncoder().encode(env),
  );
  if (write.exitCode !== 0) throw new Error(`net.env write failed: ${write.stderr}`);
}

/** Read the first request line of a new client and hand the connection to the
 *  matching loopback server. `knownProject` is set for a project's carriers;
 *  `onActive` fires when the first bytes arrive (the carrier is now in use). */
function acceptClient(socket: net.Socket, knownProject?: string, onActive?: () => void): void {
  let buf = Buffer.alloc(0);
  const onData = async (chunk: Buffer) => {
    if (onActive) { const f = onActive; onActive = undefined; f(); }
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf("\r\n");
    if (nl === -1) { if (buf.length > 16384) socket.destroy(); return; }
    socket.off("data", onData);
    socket.pause();
    const [method, target] = buf.slice(0, nl).toString().split(" ");
    const ip = (socket.remoteAddress || "").replace(/^::ffff:/, "");
    // Over TCP only project VMs may use the proxy. It listens on every
    // interface, so this is what keeps the rest of the network from borrowing it.
    if (!knownProject && !(await projectForIp(ip))) { socket.destroy(); return; }
    const who = { clientIp: ip, projectId: knownProject };
    if (method === "CONNECT") {
      const { host, port: connectPort } = splitHostPort(target || "", 443);
      try {
        const port = await serverForHost(host);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        toLoopback(socket, port, { scheme: "https", ...who, connectHost: host, connectPort });
        // no manual resume — toLoopback's pipe() resumes the socket
      } catch {
        try { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); socket.end(); } catch {}
      }
    } else {
      toLoopback(socket, httpPort, { scheme: "http", ...who }, buf);
    }
  };
  socket.on("data", onData);
  socket.on("error", () => {});
}

// ---- start ----
let started = false;
export async function startProxy(): Promise<void> {
  if (started) return;
  await ensureCA(); // throws if openssl is missing -> caller logs, UI/API still run
  started = true;

  httpServer = http.createServer(makeHandler("http"));
  await new Promise<void>((r) => httpServer!.listen(0, "127.0.0.1", () => r()));
  httpPort = (httpServer.address() as net.AddressInfo).port;

  // one socket per project (network-less VMs), plus TCP for legacy VMs that
  // still sit on a real network and are told apart by source address
  const ids = db.query<{ id: string }, []>("SELECT id FROM projects WHERE state != 'destroyed'").all();
  for (const { id } of ids) {
    try { openProjectSocket(id); } catch (e) { console.error(`⚠ proxy socket for ${id}: ${(e as Error).message}`); }
  }
  const proxy = net.createServer((socket) => acceptClient(socket));

  await refreshIpMap().catch(() => {});
  const bindHost = config.proxyHost || "0.0.0.0";
  proxy.on("error", (e) => console.error("sadbox proxy error:", (e as Error).message));
  proxy.listen(config.proxyPort, bindHost, () => {
    console.log(`sadbox proxy: ${ids.length} project socket(s) in ${runDir()}; ${bindHost}:${config.proxyPort} for VMs still on a network`);
    logEvent(null, "proxy.start", `${bindHost}:${config.proxyPort}`);
  });
}
