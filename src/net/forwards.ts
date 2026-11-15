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
import { dropForwardPasses } from "../core/auth";
import { AUTH_PATH, createGate, noteUiOrigin, type Gate } from "./httpgate";
import { ensureGuestTools, guestConnectCmd } from "./guest";
export { AUTH_PATH, noteUiOrigin };

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

type Live = { servers: net.Server[]; sockets: Set<net.Socket>; socketPath?: string; gate?: Gate };
const live = new Map<string, Live>();

function refOf(projectId: string): string | null {
  const p = db.query<{ name: string }, [string]>(
    "SELECT name FROM projects WHERE id=? AND state != 'destroyed'",
  ).get(projectId);
  return p ? refFor(p.name) : null;
}

// ---- the bridge: one connection, carried into the VM ----
export function bridgeConnection(projectId: string, guestPort: number, client: net.Socket, sockets: Set<net.Socket>): void {
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
    const ref = refOf(projectId);
    try {
      if (!ref) throw new Error("project is gone");
      await ensureGuestTools(ref);
    } catch { client.destroy(); return; }
    if (client.destroyed) return;

    tunnel = driver.stream(ref, guestConnectCmd(guestPort));
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
const passCookie = (f: PortForward) => `sadbox_fwd_${f.host_port}`;

/** The path in the web UI that opens this forward (sign-in first, if need be). */
export const openPath = (f: Pick<PortForward, "id">, next = "/") => `/forwards/${f.id}/open?next=${encodeURIComponent(next)}`;

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
    const server = net.createServer((client) => bridgeConnection(f.project_id, f.guest_port, client, sockets));
    await listenOn(server, f.host_port, config.forwardHost);
    live.set(f.id, { servers: [server], sockets });
    return;
  }
  const socketPath = forwardSocketPath(f.id);
  const g = createGate({
    id: f.id, cookie: passCookie(f), guestPort: f.guest_port, socketPath,
    openPath: (next) => openPath(f, next),
    denied: `sadbox: port ${f.host_port} is open to a browser signed in to sadbox only. Open it from the sadbox web UI.`,
  });
  const front = http.createServer(g.handler);
  front.on("upgrade", g.upgrade);
  front.on("connection", (s: net.Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  front.on("close", g.close);
  // the host port first, so a port something else holds is refused before
  // anything is left behind
  await listenOn(front, f.host_port, config.forwardHost);
  const back = net.createServer((client) => bridgeConnection(f.project_id, f.guest_port, client, sockets));
  try {
    mkdirSync(runDir(), { recursive: true });
    rmSync(socketPath, { force: true });
    await listenOn(back, socketPath);
    chmodSync(socketPath, 0o600);
  } catch (e) { front.close(); throw e; }
  live.set(f.id, { servers: [front, back], sockets, socketPath, gate: g });
}

async function unlisten(id: string): Promise<void> {
  const l = live.get(id);
  if (!l) return;
  live.delete(id);
  for (const s of l.sockets) { try { s.destroy(); } catch {} }
  l.gate?.close();
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
