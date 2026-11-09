// Port forwards over HTTP: the UI's /forwards/:id/open, which sends a signed-in
// browser to a sign-in forward with a ticket, end to end against a real server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { config } from "../config";
import { makeProject } from "../../test/helpers";
import { purgeProjectForwards } from "../net/forwards";
import { startServer } from "./http";

const A = makeProject("fapi-a");
let server: ReturnType<typeof startServer>;
let app: ReturnType<typeof Bun.serve>;
let base = "";
let cookie = "";

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const port = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(port));
  });
});

beforeAll(async () => {
  config.port = 0;
  config.password = "forward-api-test-password";
  server = startServer();
  base = `http://localhost:${server.port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: config.password }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  // the app "in the VM" (the test container stub resolves every VM to this machine)
  app = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(`app ${new URL(req.url).pathname}`) });
});
afterAll(() => { purgeProjectForwards(A); server.stop(true); app.stop(true); });

const add = async (access?: string) => {
  const hostPort = await freePort();
  const r = await fetch(`${base}/api/projects/${A}/forwards`, {
    method: "POST", headers: { "content-type": "application/json", cookie, origin: base },
    body: JSON.stringify({ hostPort, guestPort: app.port, access }),
  });
  expect(r.status).toBe(201);
  return await r.json() as { id: string; host_port: number; access: string };
};

describe("/forwards/:id/open", () => {
  test("signed out: to the login page first", async () => {
    const f = await add();
    const r = await fetch(`${base}/forwards/${f.id}/open`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toStartWith("/login?next=");
  });

  test("signed in: a ticket at the forward's address, then the app, behind sign-in", async () => {
    const f = await add();
    expect(f.access).toBe("signin");
    const r = await fetch(`${base}/forwards/${f.id}/open?next=${encodeURIComponent("/page")}`, { headers: { cookie }, redirect: "manual" });
    const loc = new URL(r.headers.get("location")!);
    expect(`${loc.hostname}:${loc.port}${loc.pathname}`).toBe(`localhost:${f.host_port}/__sadbox/auth`);
    loc.hostname = "127.0.0.1"; // where the test forward listens
    expect(loc.searchParams.get("next")).toBe("/page");
    // the forward trades it for its cookie and sends the browser on
    const trade = await fetch(loc, { redirect: "manual" });
    expect(trade.headers.get("location")).toBe("/page");
    const pass = trade.headers.get("set-cookie")!.split(";")[0];
    const page = await fetch(`http://127.0.0.1:${f.host_port}/page`, { headers: { cookie: pass } });
    expect(await page.text()).toBe("app /page");
    expect((await fetch(`http://127.0.0.1:${f.host_port}/page`)).status).toBe(401);
  });

  test("an open forward is just its address", async () => {
    const f = await add("open");
    const r = await fetch(`${base}/forwards/${f.id}/open`, { headers: { cookie }, redirect: "manual" });
    expect(r.headers.get("location")).toBe(`http://localhost:${f.host_port}/`);
  });

  test("PATCH switches access", async () => {
    const f = await add();
    const r = await fetch(`${base}/api/projects/${A}/forwards/${f.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ access: "open" }),
    });
    expect((await r.json()).access).toBe("open");
    expect(await (await fetch(`http://127.0.0.1:${f.host_port}/x`)).text()).toBe("app /x");
  });
});
