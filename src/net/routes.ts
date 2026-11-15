// Named routes: <name>.<route domain> → a port inside one project's VM. They
// need no host port of their own: Caddy (or a wildcard DNS record) sends every
// <name>.<domain> request to the one routes listener, which looks the name up,
// applies the same sign-in gate as a port forward, and carries the connection
// into the VM. The app runs at "/" on its own origin, so it needs no base-path
// configuration and cannot reach the sadbox UI's session cookie.
//
// Only HTTP(S) is routed. A database or other raw TCP server still uses a port
// forward; a path prefix (sadbox.domain.com/sample) is deliberately not
// offered here — see docs/research/17-named-routes.md.
import http from "node:http";
import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config, runDir } from "../config";
import { db, logEvent } from "../db";
import { dropForwardPasses } from "../core/auth";
import { createGate, text, type Gate } from "./httpgate";
import { bridgeConnection } from "./forwards";

export type RouteAccess = "signin" | "open";

export interface NamedRoute {
  id: string;
  project_id: string;
  name: string;
  guest_port: number;
  access: RouteAccess;
  created_at: string;
  active?: boolean; // back socket currently bound (false ⇒ it could not start)
}

/** The wildcard suffix routes live under, e.g. `sadbox.domain.com` → sample.sadbox.domain.com. */
export const routeDomain = () => (config.routeDomain ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
/** The public host of a named route (empty when no domain is configured). */
export const routeHost = (name: string) => `${name}.${routeDomain()}`;

// Names Caddy, browsers or the UI are likely to want for themselves. The first
// label of the route domain (usually "sadbox") is reserved at create time too.
const RESERVED = new Set([
  "sadbox", "www", "api", "app", "admin", "login", "logout", "auth", "mail",
  "docs", "support", "status", "vault", "proxy", "static", "assets", "cdn",
]);

const validPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;
const validAccess = (a: unknown): a is RouteAccess => a === "signin" || a === "open";

/** Lower-case, trimmed, valid DNS-label name. Throws a user-facing message. */
function routeName(raw: unknown): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error("route name must be a DNS label: a-z, 0-9 and hyphens, at most 63 characters");
  }
  if (RESERVED.has(name) || name === routeDomain().split(".")[0]) throw new Error(`route name "${name}" is reserved`);
  return name;
}

const routeSocketPath = (id: string) => join(runDir(), `route-${id}.sock`);

type Live = { back: net.Server; sockets: Set<net.Socket>; socketPath: string; gate: Gate };
const live = new Map<string, Live>();
let router: http.Server | null = null;

const listenOn = (server: net.Server, ...at: [number, string] | [string]) => new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  const done = () => { server.off("error", reject); server.on("error", () => {}); resolve(); };
  if (at.length === 2) server.listen(at[0], at[1], done); else server.listen(at[0], done);
});

// ---- one listener, many names ----
function hostOf(req: http.IncomingMessage): string {
  const raw = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim().toLowerCase();
  return raw.replace(/:\d+$/, "").replace(/\.$/, "");
}

function resolveRoute(req: http.IncomingMessage): NamedRoute | null {
  const domain = routeDomain();
  if (!domain) return null;
  const host = hostOf(req);
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const name = host.slice(0, -suffix.length);
  if (!name || name.includes(".")) return null;
  return getNamedRouteByName(name);
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const r = resolveRoute(req);
  if (!r) return text(res, 404, `sadbox: no named route for ${hostOf(req) || "(no host)"}`);
  const l = live.get(r.id);
  if (!l) return text(res, 502, `sadbox: named route "${r.name}" is not active`);
  l.gate.handler(req, res);
}

function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  const r = resolveRoute(req);
  const l = r ? live.get(r.id) : undefined;
  if (!l) {
    socket.on("error", () => {});
    socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    return;
  }
  l.gate.upgrade(req, socket, head);
}

// ---- listeners ----
async function listenRoute(r: NamedRoute): Promise<void> {
  const sockets = new Set<net.Socket>();
  const socketPath = routeSocketPath(r.id);
  const back = net.createServer((client) => bridgeConnection(r.project_id, r.guest_port, client, sockets));
  try {
    mkdirSync(runDir(), { recursive: true });
    rmSync(socketPath, { force: true });
    await listenOn(back, socketPath);
    chmodSync(socketPath, 0o600);
  } catch (e) { try { back.close(); } catch {} throw e; }

  const gate = createGate({
    id: r.id,
    cookie: `sadbox_route_${r.id}`,
    guestPort: r.guest_port,
    socketPath,
    openPath: (next) => `/routes/${r.id}/open?next=${encodeURIComponent(next)}`,
    denied: `sadbox: ${routeHost(r.name)} is open to a browser signed in to sadbox only. Open it from the sadbox web UI.`,
    uiFallback: (req) => `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${routeDomain()}`,
    isOpen: () => getNamedRoute(r.id)?.access === "open",
  });
  live.set(r.id, { back, sockets, socketPath, gate });
}

async function unlistenRoute(id: string): Promise<void> {
  const l = live.get(id);
  if (!l) return;
  live.delete(id);
  for (const s of l.sockets) { try { s.destroy(); } catch {} }
  l.gate.close();
  await new Promise<void>((r) => { try { l.back.close(() => r()); } catch { r(); } });
  rmSync(l.socketPath, { force: true });
}

// ---- CRUD ----
export function listNamedRoutes(projectId: string): NamedRoute[] {
  return db.query<NamedRoute, [string]>(
    "SELECT * FROM named_routes WHERE project_id=? ORDER BY name",
  ).all(projectId).map((r) => ({ ...r, active: live.has(r.id) }));
}

export function getNamedRoute(id: string): NamedRoute | null {
  return db.query<NamedRoute, [string]>("SELECT * FROM named_routes WHERE id=?").get(id) ?? null;
}

export function getNamedRouteByName(name: string): NamedRoute | null {
  return db.query<NamedRoute, [string]>(
    `SELECT r.* FROM named_routes r JOIN projects p ON p.id = r.project_id
     WHERE r.name=? AND p.state != 'destroyed'`,
  ).get(name) ?? null;
}

export async function createNamedRoute(projectId: string, o: { name: unknown; guestPort: unknown; access?: unknown }): Promise<NamedRoute> {
  const domain = routeDomain();
  if (!domain) throw new Error("named routes need SADBOX_ROUTE_DOMAIN (for example sadbox.example.com)");
  const name = routeName(o.name);
  const guestPort = Number(o.guestPort);
  const access = o.access ?? "signin";
  if (!validPort(guestPort)) throw new Error("VM port must be 1–65535");
  if (!validAccess(access)) throw new Error("access must be 'signin' or 'open'");
  const proj = db.query("SELECT 1 FROM projects WHERE id=? AND state != 'destroyed'").get(projectId);
  if (!proj) throw new Error("project not found");
  if (getNamedRouteByName(name)) throw new Error(`route name "${name}" is already used`);

  const r: NamedRoute = {
    id: crypto.randomUUID().slice(0, 8), project_id: projectId,
    name, guest_port: guestPort, access, created_at: "",
  };
  try { await listenRoute(r); } catch (e) { throw routeError(name, e); }
  try {
    db.query("INSERT INTO named_routes (id, project_id, name, guest_port, access) VALUES (?, ?, ?, ?, ?)")
      .run(r.id, projectId, name, guestPort, access);
  } catch (e) {
    await unlistenRoute(r.id);
    if (String(e).includes("UNIQUE")) throw new Error(`route name "${name}" is already used`);
    throw e;
  }
  logEvent(projectId, "route.add", `${routeHost(name)} → vm:${guestPort} (${access === "open" ? "open to anyone" : "sign-in"})`);
  return listNamedRoutes(projectId).find((x) => x.id === r.id)!;
}

function routeError(name: string, e: unknown): Error {
  const code = (e as NodeJS.ErrnoException).code;
  return new Error(code === "EADDRINUSE"
    ? `cannot start named route "${name}": its socket is already in use`
    : `cannot start named route "${name}": ${(e as Error).message}`);
}

/** Put a route behind sign-in, or open it to anyone (still HTTP only). */
export function setNamedRouteAccess(projectId: string, id: string, access: unknown): NamedRoute {
  if (!validAccess(access)) throw new Error("access must be 'signin' or 'open'");
  const r = db.query<NamedRoute, [string, string]>("SELECT * FROM named_routes WHERE id=? AND project_id=?").get(id, projectId);
  if (!r) throw new Error("named route not found");
  if (r.access !== access) {
    db.query("UPDATE named_routes SET access=? WHERE id=?").run(access, id);
    if (access === "open") dropForwardPasses(id);
    logEvent(projectId, "route.access", `${routeHost(r.name)} → vm:${r.guest_port}: ${access === "open" ? "open to anyone" : "sign-in"}`);
  }
  return listNamedRoutes(projectId).find((x) => x.id === id)!;
}

export function deleteNamedRoute(projectId: string, id: string): void {
  const r = db.query<NamedRoute, [string, string]>(
    "SELECT * FROM named_routes WHERE id=? AND project_id=?",
  ).get(id, projectId);
  if (!r) return;
  void unlistenRoute(id);
  db.query("DELETE FROM named_routes WHERE id=?").run(id);
  dropForwardPasses(id);
  logEvent(projectId, "route.remove", `${routeHost(r.name)} → vm:${r.guest_port}`);
}

/** Close + remove all of a project's named routes (destroy-time cleanup). */
export function purgeProjectNamedRoutes(projectId: string): void {
  for (const r of listNamedRoutes(projectId)) { void unlistenRoute(r.id); dropForwardPasses(r.id); }
  db.query("DELETE FROM named_routes WHERE project_id=?").run(projectId);
}

/** Start the routes listener and re-open every stored route. Returns the bound
 *  port (0 when named routes are disabled). Call once at boot. */
export async function startRoutes(): Promise<number> {
  const rows = db.query<NamedRoute, []>(
    `SELECT r.* FROM named_routes r JOIN projects p ON p.id = r.project_id WHERE p.state != 'destroyed'`,
  ).all();
  if (!routeDomain()) {
    if (rows.length) console.error(`⚠ ${rows.length} named route(s) not started: set SADBOX_ROUTE_DOMAIN`);
    return 0;
  }
  if (!router) {
    const server = http.createServer(handleRequest);
    server.on("upgrade", handleUpgrade);
    try { await listenOn(server, config.routesPort, config.routesHost); }
    catch (e) { try { server.close(); } catch {} throw e; }
    router = server;
  }
  for (const r of rows) {
    if (live.has(r.id)) continue;
    try { await listenRoute(r); }
    catch (e) { console.error(`⚠ named route ${routeHost(r.name)} not started: ${(e as Error).message}`); }
  }
  const addr = router.address();
  const port = typeof addr === "object" && addr ? addr.port : config.routesPort;
  console.log(`sadbox named routes: ${live.size}/${rows.length} under *.${routeDomain()} → ${config.routesHost}:${port}`);
  return port;
}

/** Close the listener and every route (tests, shutdown). */
export async function stopRoutes(): Promise<void> {
  for (const id of [...live.keys()]) await unlistenRoute(id);
  if (router) {
    const r = router;
    router = null;
    await new Promise<void>((resolve) => { try { r.close(() => resolve()); } catch { resolve(); } });
  }
}
