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
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config";
import { db } from "../db";
import { logEvent } from "../db";
import { getDriver } from "../driver";
import { ensureCA, certForHost, leafKey, caCertPem, caReady } from "./ca";
import { evaluate, applyHeaders } from "./rules";
import { requestApproval } from "./approvals";
import { recordRequest, type RequestEntry } from "./events";

const driver = getDriver();
// local copy of core/projects' refFor to avoid a proxy<->projects import cycle
const refFor = (name: string) => `sadbox-${name}`;

// ---- guest IP -> project, refreshed from the driver ----
let ipMap = new Map<string, { id: string; name: string }>();
let ipMapAt = 0;

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
type Ctx = { scheme: "http" | "https"; clientIp: string; connectHost?: string };
const ctxByPort = new Map<number, Ctx>();

let seq = 0;
const rid = () => `${(++seq).toString(36)}-${Date.now().toString(36)}`;

// ---- the request handler (shared by the http + per-host https servers) ----
function makeHandler(scheme: "http" | "https") {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const ctx = ctxByPort.get(req.socket.remotePort!) ?? { scheme, clientIp: "" };
    let host: string, path: string;
    if (scheme === "https") {
      host = (req.headers.host || ctx.connectHost || "").split(":")[0];
      path = req.url || "/";
    } else {
      try { const u = new URL(req.url!); host = u.hostname; path = u.pathname + u.search; }
      catch { host = (req.headers.host || "").split(":")[0]; path = req.url || "/"; }
    }
    const method = req.method || "GET";
    const started = Date.now();

    const proj = await projectForIp(ctx.clientIp);
    const projectId = proj?.id ?? null;

    let verdict = evaluate(projectId, { host, path, method });
    if (verdict.decision === "ask") {
      if (!projectId) verdict = { decision: "block" }; // unknown source: deny
      else verdict = { decision: await requestApproval({ projectId, host, method, scheme, path }) };
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
      { host, port: scheme === "https" ? 443 : 80, method, path, headers: headers as any, servername: host },
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

// ---- gateway detection ----
let gatewayIp = "";
async function detectGateway(): Promise<string> {
  if (gatewayIp) return gatewayIp;
  try {
    const p = Bun.spawn([config.containerBin, "network", "inspect", "default"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const j = JSON.parse(out);
    const c = Array.isArray(j) ? j[0] : j;
    gatewayIp = c?.status?.ipv4Gateway || "";
  } catch {}
  return gatewayIp;
}

export async function guestProxyUrl(): Promise<string> {
  const gw = await detectGateway();
  return `http://${gw || "192.168.64.1"}:${config.proxyPort}`;
}

// ---- guest wiring: trust the CA + point tools at the proxy ----
export async function installGuestProxy(ref: string): Promise<void> {
  if (!caReady()) throw new Error("proxy CA not initialized");
  const ca = caCertPem();

  const install = await driver.execWithStdin(
    ref,
    `umask 022 && cat > /tmp/sadbox-ca.crt && ` +
    `sudo cp /tmp/sadbox-ca.crt ${config.guestCaPath} && ` +
    `sudo update-ca-certificates >/dev/null 2>&1 && rm -f /tmp/sadbox-ca.crt`,
    new TextEncoder().encode(ca),
  );
  if (install.exitCode !== 0) throw new Error(`CA install failed: ${install.stderr}`);

  const url = await guestProxyUrl();
  const gw = await detectGateway();
  const noProxy = `localhost,127.0.0.1,::1,${gw || "192.168.64.1"}`;
  const env = [
    `export HTTP_PROXY="${url}"`, `export HTTPS_PROXY="${url}"`, `export ALL_PROXY="${url}"`,
    `export http_proxy="${url}"`, `export https_proxy="${url}"`, `export all_proxy="${url}"`,
    `export NO_PROXY="${noProxy}"`, `export no_proxy="${noProxy}"`,
    `export NODE_EXTRA_CA_CERTS="${config.guestCaPath}"`,
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

// ---- start ----
let started = false;
export async function startProxy(): Promise<void> {
  if (started) return;
  await ensureCA(); // throws if openssl is missing -> caller logs, UI/API still run
  started = true;

  httpServer = http.createServer(makeHandler("http"));
  await new Promise<void>((r) => httpServer!.listen(0, "127.0.0.1", () => r()));
  httpPort = (httpServer.address() as net.AddressInfo).port;

  const proxy = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const onData = async (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf("\r\n");
      if (nl === -1) { if (buf.length > 16384) socket.destroy(); return; }
      socket.off("data", onData);
      socket.pause();
      const [method, target] = buf.slice(0, nl).toString().split(" ");
      const ip = (socket.remoteAddress || "").replace(/^::ffff:/, "");
      if (method === "CONNECT") {
        const host = (target || "").split(":")[0];
        try {
          const port = await serverForHost(host);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          toLoopback(socket, port, { scheme: "https", clientIp: ip, connectHost: host });
          // no manual resume — toLoopback's pipe() resumes the socket
        } catch {
          try { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); socket.end(); } catch {}
        }
      } else {
        toLoopback(socket, httpPort, { scheme: "http", clientIp: ip }, buf);
      }
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });

  await refreshIpMap().catch(() => {});
  const bindHost = config.proxyHost || (await detectGateway()) || "0.0.0.0";
  proxy.on("error", (e) => console.error("sadbox proxy error:", (e as Error).message));
  proxy.listen(config.proxyPort, bindHost, () => {
    console.log(`sadbox proxy: ${bindHost}:${config.proxyPort}  (guests via ${gatewayIp || "gateway"}:${config.proxyPort})`);
    logEvent(null, "proxy.start", `${bindHost}:${config.proxyPort}`);
  });
}
