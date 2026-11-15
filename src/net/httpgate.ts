// The HTTP gate shared by sign-in port forwards and named routes: a browser
// gets a one-time ticket from the UI, trades it here for a cookie scoped to one
// forward/route, and only then reaches the app. The app never sees sadbox's
// cookies, and a pass ends with the UI session it came from.
import http from "node:http";
import net from "node:net";
import { COOKIE, cookieValue, forwardPassValid, redeemForwardTicket, safeNext } from "../core/auth";
import { config } from "../config";
import { db } from "../db";

/** Where a forward's/route's ticket is traded for its pass. Taken from the app's paths. */
export const AUTH_PATH = "/__sadbox/auth";
const PASS_DAYS = 30;

export const isSadboxCookie = (name: string) =>
  name === COOKIE || name.startsWith("sadbox_fwd_") || name.startsWith("sadbox_route_");

/** A Cookie header without sadbox's own cookies (null when nothing is left). */
function appCookies(header: string | undefined): string | null {
  if (!header) return null;
  const kept = header.split(";").map((p) => p.trim()).filter((p) => p && !isSadboxCookie(p.split("=")[0].trim()));
  return kept.length ? kept.join("; ") : null;
}

/** The request's headers for the app: as sent, less sadbox's cookies. */
export function appHeaders(req: http.IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "cookie") out[k] = v;
  const cookie = appCookies(req.headers.cookie);
  if (cookie) out.cookie = cookie;
  return out;
}

export function text(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  try { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }); res.end(body + "\n"); } catch {}
}

// The web UI's address, for sending a browser there to sign in: the one it was
// last opened at (noteUiOrigin, from the UI's own requests), else the caller's
// fallback (routes know their domain), else the request's host on the UI port.
let uiOrigin: string | null | undefined;
export function noteUiOrigin(origin: string): void {
  if (origin === uiOrigin) return;
  uiOrigin = origin;
  db.query("INSERT INTO settings (key, value) VALUES ('uiOrigin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(origin);
}
export function uiOriginFor(req: http.IncomingMessage, fallback?: string): string {
  if (uiOrigin === undefined) {
    uiOrigin = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'uiOrigin'").get()?.value ?? null;
  }
  if (uiOrigin) return uiOrigin;
  if (fallback) return fallback;
  let host = "localhost";
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch {}
  return `http://${host}:${config.port}`;
}

export interface GateOptions {
  /** The forward/route id: what a ticket and a pass are good for. */
  id: string;
  /** This target's pass cookie name. */
  cookie: string;
  guestPort: number;
  /** Unix socket the bridge into the VM listens on. */
  socketPath: string;
  /** The UI path that opens this target (sign-in first, if need be). */
  openPath: (next: string) => string;
  /** Body of the 401 for requests that are not page loads. */
  denied: string;
  /** UI address to use when none has been learned yet. */
  uiFallback?: (req: http.IncomingMessage) => string;
  /** Open to anyone: skip the pass check (a named route's "open"). */
  isOpen?: () => boolean;
}

export interface Gate {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  upgrade: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void;
  close: () => void;
}

export function createGate(g: GateOptions): Gate {
  // upstream connections are kept and reused: each new one is an exec into the VM
  const agent = new http.Agent({ keepAlive: true });
  const allowed = (req: http.IncomingMessage) =>
    (g.isOpen?.() ?? false) || forwardPassValid(g.id, cookieValue(req.headers.cookie, g.cookie));

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url || "/";
    const https = req.headers["x-forwarded-proto"] === "https";

    if (url === AUTH_PATH || url.startsWith(AUTH_PATH + "?")) {
      req.resume();
      const q = new URL(url, "http://x").searchParams;
      const pass = redeemForwardTicket(g.id, q.get("t"));
      if (!pass) return text(res, 403, "sadbox: this link has expired or was used already. Open it again from the sadbox web UI.");
      return text(res, 302, "", {
        location: safeNext(q.get("next")),
        "set-cookie": `${g.cookie}=${pass}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PASS_DAYS * 86_400}${https ? "; Secure" : ""}`,
        "cache-control": "no-store",
      });
    }

    if (!allowed(req)) {
      req.resume();
      // a page load is sent to sign in; anything else (fetch, curl) is refused
      if ((req.method === "GET" || req.method === "HEAD") && String(req.headers.accept || "").includes("text/html")) {
        const ui = uiOriginFor(req, g.uiFallback?.(req));
        return text(res, 302, "", { location: ui + g.openPath(url), "cache-control": "no-store" });
      }
      return text(res, 401, g.denied);
    }

    const up = http.request({ socketPath: g.socketPath, agent, method: req.method, path: url, headers: appHeaders(req) }, (upRes) => {
      const headers = { ...upRes.headers };
      // the app may not set (or clear) sadbox's cookies either
      const sc = headers["set-cookie"]?.filter((c) => !isSadboxCookie(c.split("=")[0].trim()));
      if (sc?.length) headers["set-cookie"] = sc; else delete headers["set-cookie"];
      try { res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, headers); } catch {}
      upRes.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) text(res, 502, `sadbox: nothing answered on port ${g.guestPort} in the VM`);
      else res.destroy();
    });
    req.pipe(up);
  };

  // WebSockets (and any other Upgrade): the same check, then a raw pipe
  const upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => {});
    if (!allowed(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    const up = net.connect(g.socketPath, () => {
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
  };

  return { handler, upgrade, close: () => agent.destroy() };
}
