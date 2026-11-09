// Inbound port forwards: a listener on the supervisor host (host_port) that
// carries every connection to a port inside one project's VM (guest_port), so
// an app the agent is running in the VM can be opened at <supervisor-host>:<port>.
// VMs have no network interface, so there is no address to dial: each
// connection rides an `exec` into the VM, where a small bridge connects it to
// the guest's own loopback. That reaches apps bound to 127.0.0.1 as well as
// 0.0.0.0, and survives a rebuild (the VM is looked up by name each time).
//
// A forward is one of two kinds (`access`):
//   signin — HTTP, for a browser signed in to sadbox only. The host port is an
//            HTTP server that checks the browser's pass to this forward (a
//            cookie, see core/auth.ts) on every request and WebSocket, and
//            sends anyone else to the web UI to get one. sadbox's own cookies
//            are taken off each request, so the app in the VM never sees them.
//            Behind it, the bridge into the VM listens on a unix socket in the
//            data dir that only this user can open.
//   open   — raw TCP for anyone who reaches the port (a database, a non-HTTP
//            server, an API another forward's browser code calls).
import http from "node:http";
import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config, runDir } from "../config";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import type { ByteStream } from "../driver/types";
import { COOKIE, cookieValue, dropForwardPasses, forwardPassValid, redeemForwardTicket, safeNext } from "../core/auth";
import { ensureGuestTools, guestConnectCmd } from "./guest";

const driver = getDriver();
// local copy of core/projects' refFor to avoid a forwards<->projects import cycle
const refFor = (name: string) => `sadbox-${name}`;

export type ForwardAccess = "signin" | "open";

export interface PortForward {
  id: string;
  project_id: string;
  host_port: number;
  guest_port: number;
  access: ForwardAccess;
  created_at: string;
  active?: boolean; // listener currently bound (false ⇒ port was taken at startup)
}

type Live = { servers: net.Server[]; sockets: Set<net.Socket>; socketPath?: string };
const live = new Map<string, Live>();

function refOf(projectId: string): string | null {
  const p = db.query<{ name: string }, [string]>(
    "SELECT name FROM projects WHERE id=? AND state != 'destroyed'",
  ).get(projectId);
  return p ? refFor(p.name) : null;
}

// ---- the bridge: one connection, carried into the VM ----
function bridge(f: PortForward, client: net.Socket, sockets: Set<net.Socket>): void {
  sockets.add(client);
  client.on("error", () => {});
  // Queue the client's bytes until the bridge into the VM is up. Not
  // pause()+pipe(): under Bun a socket paused before it ever flowed is not
  // resumed by pipe(), and the connection hangs with nothing forwarded.
  let tunnel: ByteStream | null = null;
  let queue: Uint8Array[] | null = [];
  let ended = false;
  client.on("data", (d: Buffer) => { if (queue) queue.push(d); else tunnel!.write(d); });
  client.on("end", () => { ended = true; if (!queue) tunnel!.end(); });
  client.on("close", () => { sockets.delete(client); tunnel?.kill(); });

  (async () => {
    const ref = refOf(f.project_id);
    try {
      if (!ref) throw new Error("project is gone");
      await ensureGuestTools(ref);
    } catch { client.destroy(); return; }
    if (client.destroyed) return;

    tunnel = driver.stream(ref, guestConnectCmd(f.guest_port));
    tunnel.onData((chunk) => { try { client.write(chunk); } catch {} });
    // the bridge exits when the app closes the connection, or at once when
    // nothing is listening on that port in the VM
    tunnel.onClose(() => { try { client.end(); } catch {} });
    for (const d of queue!) tunnel.write(d);
    queue = null;
    if (ended) tunnel.end();
  })();
}

// ---- the sign-in gate (access 'signin') ----
/** Where a forward's ticket is traded for its pass. Taken from the app's paths. */
export const AUTH_PATH = "/__sadbox/auth";
const passCookie = (f: PortForward) => `sadbox_fwd_${f.host_port}`;
const PASS_DAYS = 30;
const isSadboxCookie = (name: string) => name === COOKIE || name.startsWith("sadbox_fwd_");

/** A Cookie header without sadbox's own cookies (null when nothing is left). */
function appCookies(header: string | undefined): string | null {
  if (!header) return null;
  const kept = header.split(";").map((p) => p.trim()).filter((p) => p && !isSadboxCookie(p.split("=")[0].trim()));
  return kept.length ? kept.join("; ") : null;
}

/** The request's headers for the app: as sent, less sadbox's cookies. */
function appHeaders(req: http.IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "cookie") out[k] = v;
  const cookie = appCookies(req.headers.cookie);
  if (cookie) out.cookie = cookie;
  return out;
}

// The web UI's address, for sending a browser there to sign in: the one it was
// last opened at (core: noteUiOrigin, from the UI's own requests), else the
// forward's host name on the UI's port.
let uiOrigin: string | null | undefined;
export function noteUiOrigin(origin: string): void {
  if (origin === uiOrigin) return;
  uiOrigin = origin;
  db.query("INSERT INTO settings (key, value) VALUES ('uiOrigin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(origin);
}
function uiOriginFor(req: http.IncomingMessage): string {
  if (uiOrigin === undefined) {
    uiOrigin = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'uiOrigin'").get()?.value ?? null;
  }
  if (uiOrigin) return uiOrigin;
  let host = "localhost";
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch {}
  return `http://${host}:${config.port}`;
}

/** The path in the web UI that opens this forward (sign-in first, if need be). */
export const openPath = (f: Pick<PortForward, "id">, next = "/") => `/forwards/${f.id}/open?next=${encodeURIComponent(next)}`;

function text(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  try { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }); res.end(body + "\n"); } catch {}
}

function gate(f: PortForward, socketPath: string, sockets: Set<net.Socket>): http.Server {
  // upstream connections are kept and reused: each new one is an exec into the VM
  const agent = new http.Agent({ keepAlive: true });
  const allowed = (req: http.IncomingMessage) => forwardPassValid(f.id, cookieValue(req.headers.cookie, passCookie(f)));

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    const https = req.headers["x-forwarded-proto"] === "https";

    if (url === AUTH_PATH || url.startsWith(AUTH_PATH + "?")) {
      req.resume();
      const q = new URL(url, "http://x").searchParams;
      const pass = redeemForwardTicket(f.id, q.get("t"));
      if (!pass) return text(res, 403, "sadbox: this link has expired or was used already. Open the port again from the sadbox web UI.");
      return text(res, 302, "", {
        location: safeNext(q.get("next")),
        "set-cookie": `${passCookie(f)}=${pass}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PASS_DAYS * 86_400}${https ? "; Secure" : ""}`,
        "cache-control": "no-store",
      });
    }

    if (!allowed(req)) {
      req.resume();
      // a page load is sent to sign in; anything else (fetch, curl) is refused
      if ((req.method === "GET" || req.method === "HEAD") && String(req.headers.accept || "").includes("text/html")) {
        return text(res, 302, "", { location: uiOriginFor(req) + openPath(f, url), "cache-control": "no-store" });
      }
      return text(res, 401, `sadbox: port ${f.host_port} is open to a browser signed in to sadbox only. Open it from the sadbox web UI.`);
    }

    const up = http.request({ socketPath, agent, method: req.method, path: url, headers: appHeaders(req) }, (upRes) => {
      const headers = { ...upRes.headers };
      // the app may not set (or clear) sadbox's cookies either
      const sc = headers["set-cookie"]?.filter((c) => !isSadboxCookie(c.split("=")[0].trim()));
      if (sc?.length) headers["set-cookie"] = sc; else delete headers["set-cookie"];
      try { res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, headers); } catch {}
      upRes.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) text(res, 502, `sadbox: nothing answered on port ${f.guest_port} in the VM`);
      else res.destroy();
    });
    req.pipe(up);
  });

  // WebSockets (and any other Upgrade): the same check, then a raw pipe
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => {});
    if (!allowed(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    const up = net.connect(socketPath, () => {
      let h = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        let v: string | null = req.rawHeaders[i + 1];
        if (req.rawHeaders[i].toLowerCase() === "cookie") v = appCookies(v);
        if (v !== null) h += `${req.rawHeaders[i]}: ${v}\r\n`;
      }
      up.write(h + "\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("close", () => up.destroy());
  });

  server.on("connection", (s: net.Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("close", () => agent.destroy());
  return server;
}

// ---- listeners ----
const listenOn = (server: net.Server, ...at: [number, string] | [string]) => new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  const done = () => { server.off("error", reject); server.on("error", () => {}); resolve(); };
  if (at.length === 2) server.listen(at[0], at[1], done); else server.listen(at[0], done);
});

const forwardSocketPath = (id: string) => join(runDir(), `fwd-${id}.sock`);

async function listen(f: PortForward): Promise<void> {
  const sockets = new Set<net.Socket>();
  if (f.access === "open") {
    const server = net.createServer((client) => bridge(f, client, sockets));
    await listenOn(server, f.host_port, config.forwardHost);
    live.set(f.id, { servers: [server], sockets });
    return;
  }
  const socketPath = forwardSocketPath(f.id);
  const front = gate(f, socketPath, sockets);
  // the host port first, so a port something else holds is refused before
  // anything is left behind
  await listenOn(front, f.host_port, config.forwardHost);
  const back = net.createServer((client) => bridge(f, client, sockets));
  try {
    mkdirSync(runDir(), { recursive: true });
    rmSync(socketPath, { force: true });
    await listenOn(back, socketPath);
    chmodSync(socketPath, 0o600);
  } catch (e) { front.close(); throw e; }
  live.set(f.id, { servers: [front, back], sockets, socketPath });
}

async function unlisten(id: string): Promise<void> {
  const l = live.get(id);
  if (!l) return;
  live.delete(id);
  for (const s of l.sockets) { try { s.destroy(); } catch {} }
  await Promise.all(l.servers.map((s) => new Promise<void>((r) => { try { s.close(() => r()); } catch { r(); } })));
  if (l.socketPath) rmSync(l.socketPath, { force: true });
}

// ---- CRUD ----
const validPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;
const validAccess = (a: unknown): a is ForwardAccess => a === "signin" || a === "open";

export function listForwards(projectId: string): PortForward[] {
  return db.query<PortForward, [string]>(
    "SELECT * FROM port_forwards WHERE project_id=? ORDER BY host_port",
  ).all(projectId).map((f) => ({ ...f, active: live.has(f.id) }));
}

export function getForward(id: string): PortForward | null {
  return db.query<PortForward, [string]>("SELECT * FROM port_forwards WHERE id=?").get(id) ?? null;
}

export async function createForward(projectId: string, o: { hostPort: unknown; guestPort: unknown; access?: unknown }): Promise<PortForward> {
  const hostPort = Number(o.hostPort), guestPort = Number(o.guestPort);
  const access = o.access ?? "signin";
  if (!validPort(guestPort)) throw new Error("VM port must be 1–65535");
  if (!validPort(hostPort) || hostPort < 1024) throw new Error("host port must be 1024–65535");
  if (!validAccess(access)) throw new Error("access must be 'signin' or 'open'");
  if (hostPort === config.port || hostPort === config.proxyPort) {
    throw new Error(`port ${hostPort} is used by sadbox itself`);
  }
  const proj = db.query("SELECT 1 FROM projects WHERE id=? AND state != 'destroyed'").get(projectId);
  if (!proj) throw new Error("project not found");
  if (db.query("SELECT 1 FROM port_forwards WHERE host_port=?").get(hostPort)) {
    throw new Error(`host port ${hostPort} is already forwarded`);
  }

  const f: PortForward = {
    id: crypto.randomUUID().slice(0, 8), project_id: projectId,
    host_port: hostPort, guest_port: guestPort, access, created_at: "",
  };
  // bind first, so a port something else holds is refused rather than stored
  try { await listen(f); } catch (e) { throw listenError(hostPort, e); }
  db.query("INSERT INTO port_forwards (id, project_id, host_port, guest_port, access) VALUES (?, ?, ?, ?, ?)")
    .run(f.id, projectId, hostPort, guestPort, access);
  logEvent(projectId, "forward.add", `${config.forwardHost}:${hostPort} → vm:${guestPort} (${access === "open" ? "open to anyone" : "sign-in"})`);
  return listForwards(projectId).find((x) => x.id === f.id)!;
}

function listenError(hostPort: number, e: unknown): Error {
  const code = (e as NodeJS.ErrnoException).code;
  return new Error(code === "EADDRINUSE"
    ? `host port ${hostPort} is already in use on this machine`
    : `cannot listen on ${hostPort}: ${(e as Error).message}`);
}

/** Put a forward behind sign-in, or open it to anyone. */
export async function setForwardAccess(projectId: string, id: string, access: unknown): Promise<PortForward> {
  if (!validAccess(access)) throw new Error("access must be 'signin' or 'open'");
  const f = db.query<PortForward, [string, string]>("SELECT * FROM port_forwards WHERE id=? AND project_id=?").get(id, projectId);
  if (!f) throw new Error("port forward not found");
  if (f.access !== access) {
    await unlisten(id);
    db.query("UPDATE port_forwards SET access=? WHERE id=?").run(access, id);
    if (access === "open") dropForwardPasses(id);
    logEvent(projectId, "forward.access", `${f.host_port} → vm:${f.guest_port}: ${access === "open" ? "open to anyone" : "sign-in"}`);
    try { await listen({ ...f, access }); } catch (e) { throw listenError(f.host_port, e); }
  }
  return listForwards(projectId).find((x) => x.id === id)!;
}

export function deleteForward(projectId: string, id: string): void {
  const f = db.query<PortForward, [string, string]>(
    "SELECT * FROM port_forwards WHERE id=? AND project_id=?",
  ).get(id, projectId);
  if (!f) return;
  void unlisten(id);
  db.query("DELETE FROM port_forwards WHERE id=?").run(id);
  dropForwardPasses(id);
  logEvent(projectId, "forward.remove", `${f.host_port} → vm:${f.guest_port}`);
}

/** Close + remove all of a project's forwards (destroy-time cleanup — project
 *  rows are soft-deleted, so the ON DELETE CASCADE never fires). */
export function purgeProjectForwards(projectId: string): void {
  for (const f of listForwards(projectId)) { void unlisten(f.id); dropForwardPasses(f.id); }
  db.query("DELETE FROM port_forwards WHERE project_id=?").run(projectId);
}

/** Re-open every stored forward at supervisor start. A port that is no longer
 *  free is skipped (shown as inactive in the UI), not fatal. */
export async function startForwards(): Promise<void> {
  const rows = db.query<PortForward, []>(
    `SELECT f.* FROM port_forwards f JOIN projects p ON p.id = f.project_id WHERE p.state != 'destroyed'`,
  ).all();
  for (const f of rows) {
    try { await listen(f); }
    catch (e) { console.error(`⚠ port forward ${f.host_port} not started: ${(e as Error).message}`); }
  }
  if (rows.length) console.log(`sadbox forwards: ${live.size}/${rows.length} listening on ${config.forwardHost}`);
}
