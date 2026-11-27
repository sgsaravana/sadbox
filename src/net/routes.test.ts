import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { forwardTicket } from "../core/auth";
import { AUTH_PATH } from "./httpgate";
import {
  createNamedRoute, deleteNamedRoute, listNamedRoutes, purgeProjectNamedRoutes,
  routeHost, setNamedRouteAccess, startRoutes, stopRoutes,
} from "./routes";

// The preload stubs the `container` CLI so every VM resolves to 127.0.0.1 — the
// "guest" side of a route is just a local server here.
const A = makeProject("route-a");
const B = makeProject("route-b");
const closers: (() => void)[] = [];
let port = 0;

beforeAll(async () => {
  config.routeDomain = "sadbox.test";
  config.routesPort = 0; // ephemeral; the test reads the bound port back
  port = await startRoutes();
});
afterEach(() => { purgeProjectNamedRoutes(A); purgeProjectNamedRoutes(B); });
afterAll(async () => {
  for (const c of closers) c();
  await stopRoutes();
});

/** A stand-in for an app in the VM. /cookie answers with the Cookie it got,
 *  /set tries to set sadbox's cookies, /ws is a WebSocket echo. */
async function guestApp(body = "hello from the vm"): Promise<number> {
  const server = Bun.serve<{ cookie: string | null }>({
    port: 0, hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && srv.upgrade(req, { data: { cookie: req.headers.get("cookie") } })) return;
      if (url.pathname === "/cookie") return new Response(req.headers.get("cookie") ?? "(none)");
      if (url.pathname === "/set") {
        const h = new Headers();
        h.append("set-cookie", "sadbox_session=evil; Path=/");
        h.append("set-cookie", "sadbox_route_x=evil; Path=/");
        h.append("set-cookie", "app=1; Path=/");
        return new Response("set", { headers: h });
      }
      if (url.pathname === "/path") return new Response(url.pathname + url.search);
      if (url.pathname === "/host") return new Response(req.headers.get("host") ?? "");
      if (req.method === "POST") return new Response(String((await req.arrayBuffer()).byteLength));
      return new Response(body);
    },
    websocket: { message(ws, m) { ws.send(`echo ${m} (cookie: ${ws.data.cookie ?? "none"})`); } },
  });
  closers.push(() => server.stop(true));
  return server.port!;
}

/** A stand-in for an app bound to IPv6 loopback only — what a dev server does
 *  when "localhost" resolves to ::1 (seen on Intel Macs' VMs). Null when this
 *  host has no IPv6 loopback. */
async function guestAppV6(body = "hello over ipv6"): Promise<number | null> {
  try {
    const server = Bun.serve({ port: 0, hostname: "::1", fetch: () => new Response(body) });
    closers.push(() => server.stop(true));
    return server.port!;
  } catch { return null; }
}

/** An HTTP request through the routes listener with a chosen Host. */
function request(
  path: string,
  host: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (out += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Raw WebSocket client: the global WebSocket cannot set Host. */
function wsEcho(host: string, path: string, cookie?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const key = Buffer.from("0123456789abcdef").toString("base64");
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        (cookie ? `Cookie: ${cookie}\r\n` : "") + "\r\n",
      );
    });
    let raw = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => reject(new Error("ws timeout")), 2000);
    s.on("data", (buf: Buffer) => {
      raw = Buffer.concat([raw, buf]);
      if (!upgraded) {
        const end = raw.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = raw.subarray(0, end).toString("latin1");
        if (!head.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          s.end();
          return resolve("refused");
        }
        upgraded = true;
        raw = raw.subarray(end + 4);
        const payload = Buffer.from("ping");
        const frame = Buffer.alloc(2 + 4 + payload.length);
        frame[0] = 0x81; frame[1] = 0x80 | payload.length;
        const mask = Buffer.from([1, 2, 3, 4]);
        mask.copy(frame, 2);
        for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
        s.write(frame);
      }
      if (raw.length >= 2 && raw[1] <= raw.length - 2) {
        const text = raw.subarray(2, 2 + raw[1]).toString("utf8");
        clearTimeout(timer);
        s.end();
        resolve(text);
      }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** A signed-in UI session, as core/auth's login() would leave it. */
function session(): string {
  const token = randomBytes(16).toString("hex");
  db.query("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
    .run(createHash("sha256").update(token).digest("hex"), Date.now() + 60_000);
  return token;
}
const uiRequest = (token: string) => new Request("http://ui/", { headers: { cookie: `sadbox_session=${token}` } });

/** Trade a ticket at the route's own host, as a browser would. */
async function signIn(route: { id: string; name: string }, token = session(), next = "/") {
  const res = await request(
    `${AUTH_PATH}?t=${forwardTicket(uiRequest(token), route.id)}&next=${encodeURIComponent(next)}`,
    routeHost(route.name),
  );
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(next);
  const set = String(res.headers["set-cookie"]);
  expect(set).toMatch(new RegExp(`^sadbox_route_${route.id}=[^;]+; Path=/; HttpOnly; SameSite=Lax`));
  return { cookie: set.split(";")[0], token };
}

describe("createNamedRoute validation", () => {
  test("needs SADBOX_ROUTE_DOMAIN", async () => {
    const domain = config.routeDomain;
    config.routeDomain = undefined;
    try { await expect(createNamedRoute(A, { name: "sample", guestPort: 3000 })).rejects.toThrow(/SADBOX_ROUTE_DOMAIN/); }
    finally { config.routeDomain = domain; }
  });

  test("rejects invalid and reserved names", async () => {
    for (const name of ["", "Bad Name", "-sample", "sample-", "a_b", "a.b", "x".repeat(64), "sadbox", "api"]) {
      await expect(createNamedRoute(A, { name, guestPort: 3000 })).rejects.toThrow(/route name/);
    }
    expect(listNamedRoutes(A)).toEqual([]);
  });

  test("rejects ports, access and unknown projects", async () => {
    for (const guestPort of [0, 65536, -1, 80.5, "abc", null, undefined]) {
      await expect(createNamedRoute(A, { name: "sample", guestPort })).rejects.toThrow(/VM port/);
    }
    await expect(createNamedRoute(A, { name: "sample", guestPort: 3000, access: "public" })).rejects.toThrow(/access/);
    await expect(createNamedRoute("nope", { name: "sample", guestPort: 3000 })).rejects.toThrow(/project not found/);
    const dead = makeProject("route-dead", "destroyed");
    await expect(createNamedRoute(dead, { name: "sample", guestPort: 3000 })).rejects.toThrow(/project not found/);
  });

  test("a name can be used once, across all projects", async () => {
    await createNamedRoute(A, { name: "sample", guestPort: 3000 });
    await expect(createNamedRoute(A, { name: "sample", guestPort: 4000 })).rejects.toThrow(/already used/);
    await expect(createNamedRoute(B, { name: "SAMPLE", guestPort: 3000 })).rejects.toThrow(/already used/);
  });

  test("names are lower-cased and the public host is derived from the domain", async () => {
    const r = await createNamedRoute(A, { name: "My-App", guestPort: "3000" });
    expect(r.name).toBe("my-app");
    expect(r.guest_port).toBe(3000);
    expect(routeHost(r.name)).toBe("my-app.sadbox.test");
  });
});

describe("routing", () => {
  test("each name reaches its own port; the path is unchanged", async () => {
    const [g1, g2] = [await guestApp("one"), await guestApp("two")];
    const one = await createNamedRoute(A, { name: "one", guestPort: g1, access: "open" });
    const two = await createNamedRoute(B, { name: "two", guestPort: g2, access: "open" });
    expect(one.active && two.active).toBe(true);
    expect((await request("/", routeHost("one"))).body).toBe("one");
    expect((await request("/", routeHost("two"))).body).toBe("two");
    expect((await request("/path?x=1", routeHost("one"))).body).toBe("/path?x=1");
    expect((await request("/host", routeHost("one"))).body).toBe(routeHost("one"));
  });

  test("reaches an app bound to IPv6 loopback only (localhost → ::1)", async () => {
    const g = await guestAppV6();
    if (g === null) return; // no IPv6 loopback on this host
    await createNamedRoute(A, { name: "v6", guestPort: g, access: "open" });
    expect((await request("/", routeHost("v6"))).body).toBe("hello over ipv6");
  });

  test("X-Forwarded-Host works too (what Caddy sends)", async () => {
    const g = await guestApp("via caddy");
    await createNamedRoute(A, { name: "caddy", guestPort: g, access: "open" });
    const res = await request("/", "127.0.0.1", { "x-forwarded-host": routeHost("caddy") });
    expect(res.body).toBe("via caddy");
  });

  test("unknown, nested and UI hosts are 404", async () => {
    const g = await guestApp();
    await createNamedRoute(A, { name: "known", guestPort: g });
    expect((await request("/", routeHost("unknown"))).status).toBe(404);
    expect((await request("/", `deep.known.sadbox.test`)).status).toBe(404);
    expect((await request("/", "sadbox.test")).status).toBe(404);
    expect((await request("/", "127.0.0.1")).status).toBe(404);
  });

  test("large uploads pass through", async () => {
    const g = await guestApp();
    await createNamedRoute(A, { name: "upload", guestPort: g, access: "open" });
    const size = 2 * 1024 * 1024;
    const res = await request("/", routeHost("upload"), {}, "POST", "x".repeat(size));
    expect(res.body).toBe(String(size));
  });
});

describe("sign-in routes", () => {
  test("new routes are behind sign-in: no pass, no app", async () => {
    const g = await guestApp();
    const r = await createNamedRoute(A, { name: "private", guestPort: g });
    expect(r.access).toBe("signin");
    expect((await request("/", routeHost("private"))).status).toBe(401);
    // a page load is sent to the UI, which hands out the pass
    const { noteUiOrigin } = await import("./httpgate");
    noteUiOrigin("https://sadbox.example.com");
    const page = await request("/app?x=1", routeHost("private"), { accept: "text/html" });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe(`https://sadbox.example.com/routes/${r.id}/open?next=${encodeURIComponent("/app?x=1")}`);
    // the UI's session cookie is no way in
    const token = session();
    expect((await request("/", routeHost("private"), { cookie: `sadbox_session=${token}` })).status).toBe(401);
  });

  test("a ticket buys a pass; the app never sees sadbox's cookies", async () => {
    const g = await guestApp();
    const r = await createNamedRoute(A, { name: "guarded", guestPort: g });
    const { cookie, token } = await signIn(r, undefined, "/cookie");
    const res = await request("/cookie", routeHost("guarded"), { cookie: `${cookie}; sadbox_session=${token}; theme=dark` });
    expect(res.body).toBe("theme=dark");
    expect((await request("/cookie", routeHost("guarded"), { cookie })).body).toBe("(none)");
    // nor may it set them
    const set = await request("/set", routeHost("guarded"), { cookie });
    expect(String(set.headers["set-cookie"])).toBe("app=1; Path=/");
  });

  test("a ticket is single-use and for its own route only", async () => {
    const [g1, g2] = [await guestApp(), await guestApp()];
    const one = await createNamedRoute(A, { name: "one-ticket", guestPort: g1 });
    const two = await createNamedRoute(B, { name: "two-ticket", guestPort: g2 });
    const t = forwardTicket(uiRequest(session()), one.id);
    expect((await request(`${AUTH_PATH}?t=${t}`, routeHost("two-ticket"))).status).toBe(403);
    expect((await request(`${AUTH_PATH}?t=${t}`, routeHost("one-ticket"))).status).toBe(403); // spent above
    expect((await request(`${AUTH_PATH}?t=made-up`, routeHost("one-ticket"))).status).toBe(403);
    // a pass for one route does not open another
    const { cookie } = await signIn(one);
    expect((await request("/", routeHost("two-ticket"), { cookie })).status).toBe(401);
  });

  test("next is a local path only", async () => {
    const g = await guestApp();
    const r = await createNamedRoute(A, { name: "next-test", guestPort: g });
    const t = forwardTicket(uiRequest(session()), r.id);
    const res = await request(`${AUTH_PATH}?t=${t}&next=${encodeURIComponent("//evil.example")}`, routeHost("next-test"));
    expect(res.headers.location).toBe("/");
  });

  test("the pass ends with the UI session it came from", async () => {
    const g = await guestApp();
    const r = await createNamedRoute(A, { name: "session-pass", guestPort: g });
    const { cookie, token } = await signIn(r);
    expect((await request("/", routeHost("session-pass"), { cookie })).status).toBe(200);
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(createHash("sha256").update(token).digest("hex"));
    expect((await request("/", routeHost("session-pass"), { cookie })).status).toBe(401);
  });

  test("WebSockets need the pass too, and go through with it", async () => {
    const g = await guestApp();
    const r = await createNamedRoute(A, { name: "ws-test", guestPort: g });
    expect(await wsEcho(routeHost("ws-test"), "/ws")).toBe("refused");
    const { cookie } = await signIn(r);
    expect(await wsEcho(routeHost("ws-test"), "/ws", `${cookie}; app=2`)).toBe("echo ping (cookie: app=2)");
  });

  test("nothing listening in the VM is a 502, not a hang", async () => {
    const r = await createNamedRoute(A, { name: "nothing", guestPort: 45678 });
    const { cookie } = await signIn(r);
    expect((await request("/", routeHost("nothing"), { cookie })).status).toBe(502);
  });

  test("a route can be opened to anyone and put back behind sign-in", async () => {
    const g = await guestApp();
    const r = await createNamedRoute(A, { name: "switch", guestPort: g });
    expect((await request("/", routeHost("switch"))).status).toBe(401);
    expect(setNamedRouteAccess(A, r.id, "open").access).toBe("open");
    expect((await request("/", routeHost("switch"))).status).toBe(200);
    setNamedRouteAccess(A, r.id, "signin");
    expect((await request("/", routeHost("switch"))).status).toBe(401);
    expect(() => setNamedRouteAccess(A, r.id, "public")).toThrow(/access/);
    expect(() => setNamedRouteAccess(B, r.id, "open")).toThrow(/not found/);
  });
});

describe("removal and restart", () => {
  test("deleteNamedRoute removes the name; another project's route stays", async () => {
    const [g1, g2] = [await guestApp("a"), await guestApp("b")];
    const one = await createNamedRoute(A, { name: "gone", guestPort: g1, access: "open" });
    const two = await createNamedRoute(B, { name: "kept", guestPort: g2, access: "open" });
    deleteNamedRoute(B, one.id); // wrong project: no-op
    expect(listNamedRoutes(A).map((x) => x.id)).toEqual([one.id]);
    deleteNamedRoute(A, one.id);
    expect(listNamedRoutes(A)).toEqual([]);
    expect((await request("/", routeHost("gone"))).status).toBe(404);
    expect((await request("/", routeHost("kept"))).body).toBe("b");
    expect(two.active).toBe(true);
  });

  test("purgeProjectNamedRoutes frees that project's names only", async () => {
    const [g1, g2] = [await guestApp("a"), await guestApp("b")];
    await createNamedRoute(A, { name: "purge-a", guestPort: g1, access: "open" });
    await createNamedRoute(B, { name: "purge-b", guestPort: g2, access: "open" });
    purgeProjectNamedRoutes(A);
    expect(listNamedRoutes(A)).toEqual([]);
    expect((await request("/", routeHost("purge-a"))).status).toBe(404);
    expect((await request("/", routeHost("purge-b"))).body).toBe("b");
  });

  test("startRoutes re-opens stored routes and skips destroyed projects", async () => {
    const g = await guestApp("restored");
    await createNamedRoute(A, { name: "restore", guestPort: g, access: "open" });
    const gone = makeProject("route-gone", "destroyed");
    db.query("INSERT INTO named_routes (id, project_id, name, guest_port, access) VALUES (?, ?, ?, ?, ?)")
      .run("r-gone", gone, "gone-route", g, "open");
    try {
      await stopRoutes();
      port = await startRoutes();
      const byName = Object.fromEntries(listNamedRoutes(A).map((r) => [r.name, r.active]));
      expect(byName).toEqual({ restore: true });
      expect((await request("/", routeHost("restore"))).body).toBe("restored");
      expect((await request("/", routeHost("gone-route"))).status).toBe(404);
    } finally {
      db.run("DELETE FROM named_routes WHERE project_id = 'route-gone'");
    }
  });
});
