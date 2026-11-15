// Prototype of a single named-route gateway: one listener that maps a name to
// an app's port, either by path prefix (/p/<name>/…) or by host
// (<name>.sadbox.test). It mirrors what sadbox would need on the host: strip a
// prefix, rewrite Location/Set-Cookie, carry WebSockets, and (optionally)
// inject a <base> tag.
//
// Start: MODE=path|host bun run router.ts [port] [sample:4101,other:4102]
import http from "node:http";
import net from "node:net";

export type Mode = "path" | "host";

export interface RouterOptions {
  mode: Mode;
  port: number;
  routes: Map<string, number>;
  /** prefix for path mode, default /p */
  prefix?: string;
  /** suffix for host mode, default sadbox.test */
  domain?: string;
  /** inject <base href> into HTML responses (path mode only) */
  injectBase?: boolean;
  /** remove the prefix before forwarding (default true). Set false for apps
   *  configured with a matching basePath, which expect the full path. */
  stripPrefix?: boolean;
}

const HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
]);

function appHeaders(req: http.IncomingMessage, extra: Record<string, string>): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) out[k] = v;
  Object.assign(out, extra);
  return out;
}

export function startRouter(o: RouterOptions): Promise<http.Server> {
  const prefix = (o.prefix ?? "/p").replace(/\/+$/, "");
  const domain = (o.domain ?? "sadbox.test").replace(/^\.+/, "");
  const prefixRe = new RegExp(`^${prefix}/([a-z0-9][a-z0-9-]*)(/.*)?$`);

  /** name, public prefix ("" in host mode), and the path the app sees. */
  function resolve(req: http.IncomingMessage): { name: string; publicPrefix: string; upstreamPath: string } | null {
    const raw = req.url || "/";
    const u = new URL(raw, "http://x");
    if (o.mode === "host") {
      const host = String(req.headers.host ?? "").toLowerCase().split(":")[0];
      const name = host.endsWith("." + domain) ? host.slice(0, -(domain.length + 1)) : "";
      if (!name || name.includes(".")) return null;
      return { name, publicPrefix: "", upstreamPath: raw };
    }
    const m = u.pathname.match(prefixRe);
    if (!m) return null;
    const rest = m[2] || "/";
    return {
      name: m[1],
      publicPrefix: `${prefix}/${m[1]}`,
      upstreamPath: (o.stripPrefix === false ? u.pathname : rest) + u.search,
    };
  }

  function rewriteLocation(loc: string, publicPrefix: string): string {
    if (!publicPrefix || !loc.startsWith("/") || loc.startsWith("//")) return loc;
    return publicPrefix + loc;
  }

  function rewriteCookie(cookie: string, publicPrefix: string): string {
    if (!publicPrefix) return cookie;
    // Scope every app cookie to the route's path. Cookies set from JavaScript
    // never pass through here, so this is only a partial fix.
    return cookie.replace(/;\s*path=\/(?=;|$)/i, `; Path=${publicPrefix}`);
  }

  function rewriteHtml(body: Buffer, contentType: string | undefined, publicPrefix: string): Buffer {
    if (!publicPrefix || !o.injectBase || !contentType?.includes("text/html")) return body;
    const html = body.toString("utf8");
    if (/<base\s/i.test(html)) return body;
    return Buffer.from(html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${publicPrefix}/">`));
  }

  const server = http.createServer((req, res) => {
    const route = resolve(req);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end(`no named route for ${req.headers.host ?? ""}${req.url}\n`);
    }
    const port = o.routes.get(route.name);
    if (!port) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end(`no app mapped to "${route.name}"\n`);
    }
    // A prefix without a trailing slash makes relative URLs resolve one level
    // too high in the browser, so send the browser to the canonical form.
    const u = new URL(req.url || "/", "http://x");
    if (o.mode === "path" && route.publicPrefix && u.pathname === route.publicPrefix) {
      res.writeHead(308, { location: route.publicPrefix + "/" + u.search });
      return res.end();
    }

    const extra: Record<string, string> = {
      "x-forwarded-host": String(req.headers["x-forwarded-host"] ?? req.headers.host ?? ""),
      "x-forwarded-proto": String(req.headers["x-forwarded-proto"] ?? "http"),
      "x-forwarded-for": String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? ""),
    };
    if (route.publicPrefix) extra["x-forwarded-prefix"] = route.publicPrefix;

    const up = http.request({
      host: "127.0.0.1", port, method: req.method, path: route.upstreamPath, headers: appHeaders(req, extra),
    }, (upRes) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (HOP.has(k)) continue;
        if (k === "location" && typeof v === "string") headers[k] = rewriteLocation(v, route.publicPrefix);
        else if (k === "set-cookie" && Array.isArray(v)) headers[k] = v.map((c) => rewriteCookie(c, route.publicPrefix));
        else headers[k] = v;
      }

      const contentType = String(upRes.headers["content-type"] ?? "");
      const rewriteBody = o.injectBase && route.publicPrefix && contentType.includes("text/html");
      if (!rewriteBody) {
        res.writeHead(upRes.statusCode ?? 502, headers);
        return upRes.pipe(res);
      }
      // Buffered only for the spike. A production proxy should not buffer
      // arbitrary HTML (SSE, streaming, large pages).
      const chunks: Buffer[] = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        const body = rewriteHtml(Buffer.concat(chunks), contentType, route.publicPrefix);
        delete headers["content-length"];
        headers["content-length"] = String(body.length);
        res.writeHead(upRes.statusCode ?? 502, headers);
        res.end(body);
      });
    });
    up.on("error", () => {
      if (!res.headersSent) { res.writeHead(502, { "content-type": "text/plain" }); res.end("upstream failed\n"); }
      else res.destroy();
    });
    req.pipe(up);
  });

  // WebSocket/Upgrade: raw pipe to the app, with the prefix removed from the
  // request line and X-Forwarded-Prefix added.
  server.on("upgrade", (req, socket, head) => {
    const route = resolve(req);
    const port = route ? o.routes.get(route.name) : undefined;
    if (!route || !port) return socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");

    const up = net.connect(port, "127.0.0.1", () => {
      const lines = [`${req.method} ${route.upstreamPath} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (k.toLowerCase() === "x-forwarded-prefix" && !route.publicPrefix) continue;
        lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      if (route.publicPrefix && !req.headers["x-forwarded-prefix"]) lines.push(`x-forwarded-prefix: ${route.publicPrefix}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => up.destroy());
  });

  return new Promise((resolve) => server.listen(o.port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 4100);
  const routes = new Map<string, number>();
  for (const pair of (process.argv[3] ?? "sample:4101").split(",")) {
    const [name, p] = pair.split(":");
    routes.set(name, Number(p));
  }
  const mode = (process.env.MODE as Mode) || "path";
  await startRouter({ mode, port, routes, injectBase: process.env.INJECT_BASE === "1" });
  console.log(`router (${mode}) on http://127.0.0.1:${port}`);
}
