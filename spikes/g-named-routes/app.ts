// A stand-in for an app running in a project VM. It deliberately uses the
// patterns real apps use, so the router's behaviour can be measured:
//
//   /          HTML with root-absolute AND relative links
//   /absurl    HTML built from the request's Host (what frameworks do)
//   /go        302 to a root-absolute path
//   /cookie    Set-Cookie with Path=/
//   /ws        WebSocket echo
//   /echo      the request as the upstream saw it
//
// Start: bun run app.ts [port]   (default 4101)
import http from "node:http";

export function startApp(port: number, name = "app") {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://upstream");
    const path = u.pathname;
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };

    if (path === "/") {
      return send(200, `<!doctype html><html><head>
<link rel="stylesheet" href="/style.css">
<script type="module" src="/app.js"></script>
</head><body>
<a href="/absolute">absolute</a>
<a href="relative">relative</a>
<img src="./logo.png">
</body></html>`);
    }
    if (path === "/absurl") {
      const host = req.headers["x-forwarded-host"] || req.headers.host || "unknown";
      const proto = req.headers["x-forwarded-proto"] || "http";
      return send(200, `<a href="${proto}://${host}/absolute">absolute link</a>`);
    }
    if (path === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(`fetch("/api/data").then(r=>r.text()).then(console.log);`);
    }
    if (path === "/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      return res.end("body{background:url(/bg.png)}");
    }
    if (path === "/go") {
      res.writeHead(302, { location: "/after" });
      return res.end();
    }
    if (path === "/after") return send(200, "after");
    if (path === "/cookie") {
      res.writeHead(200, { "set-cookie": `sid=abc; Path=/; HttpOnly; SameSite=Lax`, "content-type": "text/plain" });
      return res.end("cookie set");
    }
    if (path === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, app: name }));
    }
    if (path === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        path: req.url,
        host: req.headers.host,
        forwardedPrefix: req.headers["x-forwarded-prefix"] ?? null,
        forwardedHost: req.headers["x-forwarded-host"] ?? null,
      }));
    }
    send(404, "the app itself has no such path: " + path);
  });

  // Minimal WebSocket echo (RFC 6455 text frames only) so the router's upgrade
  // path can be tested without another dependency.
  server.on("upgrade", (req, socket) => {
    if (!(req.url || "").startsWith("/ws")) return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const accept = createAccept(req.headers["sec-websocket-key"] as string);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "upgrade: websocket\r\nconnection: upgrade\r\n" +
      `sec-websocket-accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (buf) => {
      // decode one masked client frame, reply with an unmasked text frame
      const opcode = buf[0] & 0x0f;
      if (opcode === 8) return socket.end();
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i % 4];
      const reply = Buffer.from(`echo:${payload.toString()}`);
      const out = Buffer.alloc(2 + reply.length);
      out[0] = 0x81;
      out[1] = reply.length;
      reply.copy(out, 2);
      socket.write(out);
    });
    socket.on("error", () => {});
  });

  return new Promise<http.Server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Small SHA-1/base64 helper, using Bun's WebCrypto for the handshake.
function createAccept(key: string): string {
  const hash = new Bun.CryptoHasher("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest();
  return Buffer.from(hash).toString("base64");
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 4101);
  await startApp(port, process.argv[3] ?? "app");
  console.log(`app on http://127.0.0.1:${port}`);
}
