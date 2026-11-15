// Named routes over HTTP: creation/list/switch, and the UI's /routes/:id/open
// redirect that hands a signed-in browser to the route with a ticket.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../config";
import { makeProject } from "../../test/helpers";
import { purgeProjectNamedRoutes } from "../net/routes";
import { startServer } from "./http";

const A = makeProject("rapi-a");
let server: ReturnType<typeof startServer>;
let base = "";
let cookie = "";

beforeAll(async () => {
  config.port = 0;
  config.routeDomain = "sadbox.test";
  config.password = "route-api-test-password";
  server = startServer();
  base = `http://localhost:${server.port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: config.password }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});
afterEach(() => { purgeProjectNamedRoutes(A); });
afterAll(() => { purgeProjectNamedRoutes(A); server.stop(true); });

const add = async (access?: string, name = "sample") => {
  const r = await fetch(`${base}/api/projects/${A}/routes`, {
    method: "POST", headers: { "content-type": "application/json", cookie, origin: base },
    body: JSON.stringify({ name, guestPort: 3000, access }),
  });
  expect(r.status).toBe(201);
  return await r.json() as { id: string; name: string; access: string };
};

describe("/routes/:id/open", () => {
  test("signed out: to the login page first", async () => {
    const r = await fetch(`${base}/routes/whatever/open`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toStartWith("/login?next=");
  });

  test("signed in: a ticket at the route's own host", async () => {
    const route = await add();
    expect(route.access).toBe("signin");
    const r = await fetch(`${base}/routes/${route.id}/open?next=${encodeURIComponent("/page?x=1")}`, {
      headers: { cookie }, redirect: "manual",
    });
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin).toBe("http://sample.sadbox.test");
    expect(loc.pathname).toBe("/__sadbox/auth");
    expect(loc.searchParams.get("next")).toBe("/page?x=1");
    expect(loc.searchParams.get("t")).toBeTruthy();
  });

  test("an open route is just its address", async () => {
    const route = await add("open", "open-app");
    const r = await fetch(`${base}/routes/${route.id}/open?next=${encodeURIComponent("/x")}`, {
      headers: { cookie }, redirect: "manual",
    });
    expect(r.headers.get("location")).toBe("http://open-app.sadbox.test/x");
  });

  test("an unknown route is a 404", async () => {
    const r = await fetch(`${base}/routes/nope/open`, { headers: { cookie }, redirect: "manual" });
    expect(r.status).toBe(404);
  });
});

describe("/api/projects/:id/routes", () => {
  test("lists the routes with the configured domain", async () => {
    const route = await add(undefined, "listed");
    const r = await fetch(`${base}/api/projects/${A}/routes`, { headers: { cookie } });
    const body = await r.json() as { domain: string; routes: { id: string; name: string }[] };
    expect(body.domain).toBe("sadbox.test");
    expect(body.routes.some((x) => x.id === route.id && x.name === "listed")).toBe(true);
  });

  test("PATCH switches access; a duplicate name is refused with 400", async () => {
    const route = await add(undefined, "patch-me");
    const r = await fetch(`${base}/api/projects/${A}/routes/${route.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ access: "open" }),
    });
    expect((await r.json()).access).toBe("open");

    const dup = await fetch(`${base}/api/projects/${A}/routes`, {
      method: "POST", headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ name: "patch-me", guestPort: 4000 }),
    });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already used/);
  });

  test("DELETE removes it", async () => {
    const route = await add(undefined, "delete-me");
    const r = await fetch(`${base}/api/projects/${A}/routes/${route.id}`, {
      method: "DELETE", headers: { cookie, origin: base },
    });
    expect(r.status).toBe(200);
    const list = await (await fetch(`${base}/api/projects/${A}/routes`, { headers: { cookie } })).json() as { routes: { id: string }[] };
    expect(list.routes.some((x) => x.id === route.id)).toBe(false);
  });
});
