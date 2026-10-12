// Inbound port forwards: a TCP listener on the supervisor host (host_port) that
// pipes every connection to a port inside one project's VM (guest_port), so an
// app the agent is running in the VM can be opened at <supervisor-host>:<port>.
// Plain TCP passthrough — works for HTTP, WebSockets, anything — reaching the
// guest over its routable vmnet address, resolved per connection so a forward
// survives a rebuild (new VM, new IP).
import net from "node:net";
import { config } from "../config";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";

const driver = getDriver();
// local copy of core/projects' refFor to avoid a forwards<->projects import cycle
const refFor = (name: string) => `sadbox-${name}`;

export interface PortForward {
  id: string;
  project_id: string;
  host_port: number;
  guest_port: number;
  created_at: string;
  active?: boolean; // listener currently bound (false ⇒ port was taken at startup)
}

type Live = { server: net.Server; sockets: Set<net.Socket> };
const live = new Map<string, Live>();

// ---- guest address, cached briefly per project ----
const addrCache = new Map<string, { ip: string; at: number }>();

async function guestAddress(projectId: string): Promise<string | null> {
  const hit = addrCache.get(projectId);
  if (hit && Date.now() - hit.at < 3000) return hit.ip;
  const p = db.query<{ name: string }, [string]>(
    "SELECT name FROM projects WHERE id=? AND state != 'destroyed'",
  ).get(projectId);
  if (!p) return null;
  const info = await driver.inspect(refFor(p.name)).catch(() => null);
  if (!info?.address) return null;
  addrCache.set(projectId, { ip: info.address, at: Date.now() });
  return info.address;
}

// ---- listeners ----
function listen(f: PortForward): Promise<void> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer(async (client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("error", () => {});
      // Queue the client's bytes until the guest side is connected. Not
      // pause()+pipe(): under Bun a socket paused before it ever flowed is not
      // resumed by pipe(), and the connection hangs with nothing forwarded.
      let up: net.Socket | null = null;
      let queue: Buffer[] | null = [];
      client.on("data", (d: Buffer) => {
        if (queue) { queue.push(d); return; }
        if (!up!.write(d)) client.pause();
      });
      client.on("end", () => { if (!queue) up?.end(); });
      const ip = await guestAddress(f.project_id);
      if (!ip || client.destroyed) { client.destroy(); return; }
      const conn = up = net.connect(f.guest_port, ip, () => {
        for (const d of queue!) conn.write(d);
        queue = null;
        if (client.readableEnded) conn.end();
        conn.pipe(client);
      });
      up.on("drain", () => client.resume());
      sockets.add(up);
      up.on("close", () => { sockets.delete(up); client.destroy(); });
      up.on("error", () => { addrCache.delete(f.project_id); client.destroy(); });
      client.on("close", () => conn.destroy());
    });
    server.once("error", reject);
    server.listen(f.host_port, config.forwardHost, () => {
      server.off("error", reject);
      server.on("error", () => {});
      live.set(f.id, { server, sockets });
      resolve();
    });
  });
}

function unlisten(id: string): void {
  const l = live.get(id);
  if (!l) return;
  live.delete(id);
  for (const s of l.sockets) { try { s.destroy(); } catch {} }
  try { l.server.close(); } catch {}
}

// ---- CRUD ----
const validPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;

export function listForwards(projectId: string): PortForward[] {
  return db.query<PortForward, [string]>(
    "SELECT * FROM port_forwards WHERE project_id=? ORDER BY host_port",
  ).all(projectId).map((f) => ({ ...f, active: live.has(f.id) }));
}

export async function createForward(projectId: string, o: { hostPort: unknown; guestPort: unknown }): Promise<PortForward> {
  const hostPort = Number(o.hostPort), guestPort = Number(o.guestPort);
  if (!validPort(guestPort)) throw new Error("VM port must be 1–65535");
  if (!validPort(hostPort) || hostPort < 1024) throw new Error("host port must be 1024–65535");
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
    host_port: hostPort, guest_port: guestPort, created_at: "",
  };
  // bind first, so a port something else holds is refused rather than stored
  try { await listen(f); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "EADDRINUSE"
      ? `host port ${hostPort} is already in use on this machine`
      : `cannot listen on ${hostPort}: ${(e as Error).message}`);
  }
  db.query("INSERT INTO port_forwards (id, project_id, host_port, guest_port) VALUES (?, ?, ?, ?)")
    .run(f.id, projectId, hostPort, guestPort);
  logEvent(projectId, "forward.add", `${config.forwardHost}:${hostPort} → vm:${guestPort}`);
  return listForwards(projectId).find((x) => x.id === f.id)!;
}

export function deleteForward(projectId: string, id: string): void {
  const f = db.query<PortForward, [string, string]>(
    "SELECT * FROM port_forwards WHERE id=? AND project_id=?",
  ).get(id, projectId);
  if (!f) return;
  unlisten(id);
  db.query("DELETE FROM port_forwards WHERE id=?").run(id);
  logEvent(projectId, "forward.remove", `${f.host_port} → vm:${f.guest_port}`);
}

/** Close + remove all of a project's forwards (destroy-time cleanup — project
 *  rows are soft-deleted, so the ON DELETE CASCADE never fires). */
export function purgeProjectForwards(projectId: string): void {
  for (const f of listForwards(projectId)) unlisten(f.id);
  db.query("DELETE FROM port_forwards WHERE project_id=?").run(projectId);
  addrCache.delete(projectId);
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
