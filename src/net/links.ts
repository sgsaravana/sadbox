// Project links: one VM allowed to reach one port of another VM, and nothing
// else. VMs have no network, so there is no address to dial; the calling VM
// asks its proxy for http://<project>.sadbox.internal:<port>/…, and the proxy —
// having checked that a link for exactly that (from, to, port) exists — carries
// the connection over an `exec` bridge onto the target VM's own loopback, the
// same way an inbound port forward does. The host's network and the host's own
// ports are never involved, and a link is one-way: the target gets no access back.
import net from "node:net";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import type { ByteStream } from "../driver/types";
import { recordRequest } from "./events";
import { ensureGuestTools, guestConnectCmd } from "./guest";

const driver = getDriver();
// local copy of core/projects' refFor to avoid an import cycle
const refFor = (name: string) => `sadbox-${name}`;

/** The name a VM uses for another project: <project-name>.sadbox.internal */
export const LINK_DOMAIN = "sadbox.internal";
const LINK_HOST = /^([a-z0-9-]+)\.sadbox\.internal\.?$/i;
/** The project name a host means, if it is a link name (any *.sadbox.internal). */
export function linkTarget(host: string): string | null | undefined {
  const h = host.toLowerCase();
  if (h !== LINK_DOMAIN && !h.endsWith("." + LINK_DOMAIN) && !h.endsWith("." + LINK_DOMAIN + ".")) return undefined;
  return LINK_HOST.exec(h)?.[1] ?? null; // null: in the domain, but not a project name
}

export interface ProjectLink {
  id: string;
  from_project: string;
  to_project: string;
  port: number;
  created_at: string;
}
export interface LinkView { id: string; project: string; name: string; port: number; host: string }

type Row = { id: string; name: string; state: string };
const projectRow = (id: string) =>
  db.query<Row, [string]>("SELECT id, name, state FROM projects WHERE id=? AND state != 'destroyed'").get(id);
const projectByName = (name: string) =>
  db.query<Row, [string]>("SELECT id, name, state FROM projects WHERE name=? AND state != 'destroyed'").get(name);

// ---- CRUD ----
/** A project's links: the ones it may use, and the ones that reach it. */
export function listLinks(projectId: string): { outgoing: LinkView[]; incoming: LinkView[] } {
  const rows = db.query<ProjectLink & { from_name: string; to_name: string }, [string, string]>(`
    SELECT l.*, f.name AS from_name, t.name AS to_name FROM project_links l
      JOIN projects f ON f.id = l.from_project AND f.state != 'destroyed'
      JOIN projects t ON t.id = l.to_project AND t.state != 'destroyed'
    WHERE l.from_project = ? OR l.to_project = ? ORDER BY t.name, f.name, l.port`).all(projectId, projectId);
  const view = (l: (typeof rows)[number], other: "from" | "to"): LinkView => ({
    id: l.id, port: l.port,
    project: other === "to" ? l.to_project : l.from_project,
    name: other === "to" ? l.to_name : l.from_name,
    host: `${l.to_name}.${LINK_DOMAIN}:${l.port}`,
  });
  return {
    outgoing: rows.filter((l) => l.from_project === projectId).map((l) => view(l, "to")),
    incoming: rows.filter((l) => l.to_project === projectId).map((l) => view(l, "from")),
  };
}

/** Let `fromId` reach port `port` of project `to` (its id or name). */
export function createLink(fromId: string, o: { to: unknown; port: unknown }): LinkView {
  const from = projectRow(fromId);
  if (!from) throw new Error("project not found");
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1–65535");
  const toKey = typeof o.to === "string" ? o.to.trim() : "";
  const to = toKey ? projectRow(toKey) ?? projectByName(toKey) : null;
  if (!to) throw new Error("the project to link to was not found");
  if (to.id === from.id) throw new Error("a project cannot link to itself — inside a VM, use localhost");
  if (db.query("SELECT 1 FROM project_links WHERE from_project=? AND to_project=? AND port=?").get(from.id, to.id, port)) {
    throw new Error(`${from.name} can already reach ${to.name}:${port}`);
  }
  const id = crypto.randomUUID().slice(0, 8);
  db.query("INSERT INTO project_links (id, from_project, to_project, port) VALUES (?, ?, ?, ?)").run(id, from.id, to.id, port);
  logEvent(from.id, "link.add", `may reach ${to.name}.${LINK_DOMAIN}:${port}`);
  logEvent(to.id, "link.add", `port ${port} reachable from ${from.name}`);
  return listLinks(from.id).outgoing.find((l) => l.id === id)!;
}

/** Remove a link — from either end. */
export function deleteLink(projectId: string, id: string): void {
  const l = db.query<ProjectLink, [string, string, string]>(
    "SELECT * FROM project_links WHERE id=? AND (from_project=? OR to_project=?)").get(id, projectId, projectId);
  if (!l) return;
  db.query("DELETE FROM project_links WHERE id=?").run(id);
  const from = projectRow(l.from_project), to = projectRow(l.to_project);
  if (from) logEvent(from.id, "link.remove", `no longer reaches ${to?.name ?? l.to_project}:${l.port}`);
  if (to) logEvent(to.id, "link.remove", `port ${l.port} no longer reachable from ${from?.name ?? l.from_project}`);
}

/** Destroy-time cleanup, both directions (project rows are soft-deleted, so
 *  ON DELETE CASCADE never fires). */
export function purgeProjectLinks(projectId: string): void {
  db.query("DELETE FROM project_links WHERE from_project=? OR to_project=?").run(projectId, projectId);
}

// ---- carrying a connection ----
/** Is there a link from `fromId` to project `toName` on `port`? The target row when there is. */
function allowed(fromId: string | null, toName: string | null, port: number): Row | null {
  if (!fromId || !toName) return null;
  const to = projectByName(toName);
  if (!to) return null;
  return db.query("SELECT 1 FROM project_links WHERE from_project=? AND to_project=? AND port=?").get(fromId, to.id, port)
    ? to : null;
}

function refuse(socket: net.Socket, status: number, text: string): void {
  try {
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\ncontent-type: text/plain\r\n` +
      `content-length: ${Buffer.byteLength(text) + 1}\r\nconnection: close\r\n\r\n${text}\n`);
  } catch {}
}

/** Handle a proxy request for a *.sadbox.internal name. `head` is every byte
 *  read from the client so far (it starts with the request line); the socket
 *  is paused. A CONNECT becomes a raw tunnel (TLS, WebSockets — whatever the
 *  client speaks); an absolute-form request (GET http://…) is rewritten to an
 *  ordinary one-request connection. */
export function carryLink(
  socket: net.Socket, head: Buffer, method: string, target: string, fromId: string | null,
): void {
  const started = Date.now();
  const connect = method === "CONNECT";
  let host: string, port: number, path = "";
  try {
    if (connect) {
      const m = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(target)!;
      host = m[1]; port = m[2] ? Number(m[2]) : 443;
    } else {
      const u = new URL(target);
      host = u.hostname; port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      path = u.pathname + u.search;
    }
  } catch { return refuse(socket, 403, "sadbox: bad request"); }
  const to = allowed(fromId, linkTarget(host) ?? null, port);
  const entry = { method, scheme: connect ? "tunnel" : "http", host: `${host}:${port}`, path, reqBytes: 0, respBytes: 0 };
  const log = (status: number | null, decision: "allowed" | "blocked", error?: string) => {
    if (fromId) recordRequest(fromId, {
      id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: started, ...entry,
      status, decision, durationMs: Date.now() - started, ...(error ? { error } : {}),
    });
  };
  if (!to) {
    log(403, "blocked", "no link");
    const from = fromId ? projectRow(fromId)?.name : null;
    return refuse(socket, 403, `sadbox: ${from ?? "this VM"} has no link to ${host}:${port} — add one on the project page (Links)`);
  }
  if (to.state !== "running") {
    log(502, "allowed", `${to.name} is ${to.state}`);
    return refuse(socket, 502, `sadbox: ${to.name} is ${to.state}`);
  }

  // For CONNECT nothing is sent first (the 200 goes back instead); for an
  // absolute-form request, the same request in origin form, one per connection.
  const begin = (rest: Buffer) => {
    const ref = refFor(to.name);
    let tunnel: ByteStream | null = null;
    let queue: Buffer[] | null = [rest];
    let ended = false, gotStatus = false;
    socket.on("data", (d: Buffer) => { entry.reqBytes += d.length; if (queue) queue.push(d); else tunnel!.write(d); });
    socket.on("end", () => { ended = true; if (!queue) tunnel!.end(); });
    let failed = false;
    socket.on("close", () => { tunnel?.kill(); if (!failed) log(gotStatus ? status : null, "allowed"); });
    socket.on("error", () => {});
    let status: number | null = null;
    ensureGuestTools(ref).then(() => {
      if (socket.destroyed) return;
      tunnel = driver.stream(ref, guestConnectCmd(port));
      tunnel.onData((chunk) => {
        if (!gotStatus && !connect) {
          gotStatus = true;
          const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(Buffer.from(chunk).subarray(0, 32).toString("latin1"));
          status = m ? Number(m[1]) : null;
        }
        entry.respBytes += chunk.length;
        try { socket.write(chunk); } catch {}
      });
      tunnel.onClose(() => { try { socket.end(); } catch {} });
      if (connect) { gotStatus = true; status = 200; try { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch {} }
      for (const d of queue!) if (d.length) tunnel.write(d);
      queue = null;
      if (ended) tunnel.end();
    }).catch((e) => {
      failed = true;
      log(502, "allowed", (e as Error).message);
      refuse(socket, 502, `sadbox: cannot reach ${to.name}: ${(e as Error).message}`);
    });
    socket.resume();
  };

  if (connect) {
    const nl = head.indexOf("\r\n\r\n");
    // anything after the CONNECT's own header block is already tunnel data
    return begin(nl >= 0 ? head.subarray(nl + 4) : Buffer.alloc(0));
  }
  // read the whole header block of the request, then rewrite it
  let buf = head;
  const withHead = () => {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buf.length > 65536) { socket.removeAllListeners("data"); refuse(socket, 403, "sadbox: request header too large"); return; }
      return;
    }
    socket.removeListener("data", more);
    socket.pause();
    const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
    const out = [`${method} ${path || "/"} ${lines[0].split(" ")[2] || "HTTP/1.1"}`];
    for (const line of lines.slice(1)) {
      const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
      if (name === "host" || name === "connection" || name === "proxy-connection" || name === "keep-alive" || name === "proxy-authorization") continue;
      out.push(line);
    }
    // the app sees a local caller — as through a port forward — and the name used
    out.push(`Host: localhost:${port}`, `X-Forwarded-Host: ${host}:${port}`, "Connection: close");
    begin(Buffer.concat([Buffer.from(out.join("\r\n") + "\r\n\r\n", "latin1"), buf.subarray(end + 4)]));
  };
  const more = (d: Buffer) => { buf = Buffer.concat([buf, d]); withHead(); };
  if (buf.indexOf("\r\n\r\n") >= 0) withHead();
  else { socket.on("data", more); socket.resume(); }
}
