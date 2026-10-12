// Inbound port forwards: a TCP listener on the supervisor host (host_port) that
// carries every connection to a port inside one project's VM (guest_port), so
// an app the agent is running in the VM can be opened at <supervisor-host>:<port>.
// VMs have no network interface, so there is no address to dial: each
// connection rides an `exec` into the VM, where a small bridge connects it to
// the guest's own loopback. That reaches apps bound to 127.0.0.1 as well as
// 0.0.0.0, and survives a rebuild (the VM is looked up by name each time).
import net from "node:net";
import { config } from "../config";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import type { ByteStream } from "../driver/types";
import { ensureGuestTools, guestConnectCmd } from "./guest";

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

function refOf(projectId: string): string | null {
  const p = db.query<{ name: string }, [string]>(
    "SELECT name FROM projects WHERE id=? AND state != 'destroyed'",
  ).get(projectId);
  return p ? refFor(p.name) : null;
}

// ---- listeners ----
function listen(f: PortForward): Promise<void> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer(async (client) => {
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
