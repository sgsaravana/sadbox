import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../config";
import { db, logEvent } from "../db";
import { makeProject } from "../../test/helpers";
import { startServer } from "./http";

// The create form reads this over HTTP while a project is being made.
const A = makeProject("papi-ev");
let server: ReturnType<typeof startServer>;
let base = "";
let cookie = "";

beforeAll(async () => {
  config.port = 0;
  config.password = "events-api-test-password";
  server = startServer();
  base = `http://localhost:${server.port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: config.password }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("=");
});

afterAll(() => {
  server.stop(true);
  db.query("DELETE FROM events WHERE project_id = ?").run(A);
  db.query("DELETE FROM projects WHERE id = ?").run(A);
});

const call = async (path: string) => {
  const r = await fetch(base + path, { headers: { cookie, origin: base } });
  return { status: r.status, body: await r.json() as any };
};

describe("/api/projects/:id/events", () => {
  test("needs a session", async () => {
    expect((await fetch(`${base}/api/projects/${A}/events`)).status).toBe(401);
  });

  test("returns this project's events, and only after an id", async () => {
    expect((await call(`/api/projects/${A}/events`)).body).toEqual([]);

    logEvent(A, "create.start", "x");
    logEvent(null, "login.refresh", "not this project");
    logEvent(A, "vm.ready", "y");

    const all = await call(`/api/projects/${A}/events`);
    expect(all.status).toBe(200);
    expect(all.body.map((e: any) => [e.type, e.detail])).toEqual([
      ["create.start", "x"],
      ["vm.ready", "y"],
    ]);
    expect(all.body[0]).toHaveProperty("at");

    const after = await call(`/api/projects/${A}/events?after=${all.body[0].id}`);
    expect(after.body.map((e: any) => e.type)).toEqual(["vm.ready"]);
  });

  test("an unknown project is a 404", async () => {
    const r = await call(`/api/projects/no-such-project/events`);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/);
  });
});
