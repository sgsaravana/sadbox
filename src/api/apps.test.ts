import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../config";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { startServer } from "./http";

// The optional-app catalog and the install endpoint's checks (installing for
// real needs a VM, so the happy path is exercised by the core tests).
const P = makeProject("papi-apps");
let server: ReturnType<typeof startServer>;
let base = "";
let cookie = "";

beforeAll(async () => {
  config.port = 0;
  config.password = "apps-api-test-password";
  server = startServer();
  base = `http://localhost:${server.port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: config.password }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});

afterAll(() => {
  server.stop(true);
  db.query("DELETE FROM projects WHERE id = ?").run(P);
});

const call = async (path: string, method = "GET", body?: unknown) => {
  const r = await fetch(base + path, {
    method, headers: { cookie, origin: base, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};

describe("/api/apps", () => {
  test("needs a session", async () => {
    expect((await fetch(`${base}/api/apps`)).status).toBe(401);
  });

  test("lists Blender with what the UI needs", async () => {
    const r = await call("/api/apps");
    expect(r.status).toBe(200);
    const blender = r.body.apps.find((a: any) => a.id === "blender");
    expect(blender).toMatchObject({ label: "Blender", binary: "blender" });
    expect(blender.summary).toBeTruthy();
    expect(Array.isArray(blender.packages)).toBe(true);
  });

  test("refuses an unknown app before touching a VM", async () => {
    const r = await call(`/api/projects/${P}/apps`, "POST", { id: "gimp" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown optional app/);
  });
});
