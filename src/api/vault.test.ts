// The vault over HTTP: the routes the Vaults UI uses, against a real server on
// a spare port.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { config } from "../config";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { startServer } from "./http";

const A = makeProject("vapi-a");
const exec = spyOn(getDriver(), "execWithStdin").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
let server: ReturnType<typeof startServer>;
let base = "";
let cookie = "";

beforeAll(async () => {
  config.port = 0; // any free port — not the supervisor that may be running
  config.password = "vault-api-test-password";
  server = startServer();
  base = `http://localhost:${server.port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: config.password }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("=");
});
afterAll(() => { server.stop(true); exec.mockRestore(); });
beforeEach(() => { db.run("DELETE FROM secrets"); db.run("DELETE FROM project_secrets"); });

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method, headers: { "content-type": "application/json", cookie, origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};

describe("/api/vault", () => {
  test("needs a session", async () => {
    expect((await fetch(`${base}/api/vault`)).status).toBe(401);
  });

  test("create, list (a secret's value hidden), reveal, edit, access, delete", async () => {
    const made = await call("POST", "/api/vault", { name: "DB_PASSWORD", value: "pw", projectIds: [A] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "DB_PASSWORD", kind: "secret", mode: "fetch", projectIds: [A] });
    const id = made.body.id;

    const list = await call("GET", "/api/vault");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty("value");
    expect((await call("GET", `/api/vault/${id}/value`)).body).toEqual({ value: "pw" });

    expect((await call("PATCH", `/api/vault/${id}`, { value: "pw2", kind: "variable" })).body).toMatchObject({ kind: "variable", value: "pw2" });
    expect((await call("PUT", `/api/vault/${id}/projects`, { projectIds: [] })).body.projectIds).toEqual([]);
    expect((await call("PUT", `/api/projects/${A}/vault`, { itemIds: [id] })).body.map((x: any) => x.id)).toEqual([id]);

    const b = await call("POST", `/api/vault/${id}/bindings`, { host: "api.example.com" });
    expect(b.status).toBe(201);
    expect((await call("DELETE", `/api/vault/${id}/bindings/${b.body.id}`)).body).toEqual({ ok: true });

    expect((await call("DELETE", `/api/vault/${id}`)).body).toEqual({ ok: true });
    expect((await call("GET", "/api/vault")).body).toEqual([]);
  });

  test("a note labels an item, and can be changed or cleared", async () => {
    const made = await call("POST", "/api/vault", { name: "NOTE_TEST", value: "x", note: "for app-a" });
    expect(made.status).toBe(201);
    expect(made.body.note).toBe("for app-a");
    const id = made.body.id;
    expect((await call("PATCH", `/api/vault/${id}`, { note: "for app-b" })).body.note).toBe("for app-b");
    // leaving it out keeps it; an empty one clears it
    expect((await call("PATCH", `/api/vault/${id}`, { kind: "variable" })).body.note).toBe("for app-b");
    expect((await call("PATCH", `/api/vault/${id}`, { note: "" })).body.note).toBe("");
  });

  test("the routes of the old Secrets page are gone", async () => {
    expect((await fetch(`${base}/api/secrets`, { headers: { cookie } })).status).toBe(404);
  });

  test("bad input is a 400 with the reason", async () => {
    const r = await call("POST", "/api/vault", { name: "N", value: "x", type: "number" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not a number/);
  });
});

describe("a proxy item's hosts in the project's rules", () => {
  test("listed as read-only allows: refused to delete or move, gone with the access", async () => {
    const it = (await call("POST", "/api/vault", { name: "GITHUB_TOKEN", value: "ghp_x", mode: "proxy", bindings: [{ host: "github.com" }], projectIds: [A] })).body;
    const rules = (await call("GET", `/api/projects/${A}/net/rules`)).body as any[];
    const v = rules.find((r) => r.source === "vault");
    expect(v).toMatchObject({ host: "github.com", action: "allow", secret_name: "GITHUB_TOKEN" });
    for (const [m, b] of [["DELETE", undefined], ["PATCH", { scope: "global" }]] as const) {
      const r = await call(m, `/api/projects/${A}/net/rules/${v.id}`, b);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/vault item GITHUB_TOKEN/);
    }
    expect((await call("DELETE", `/api/projects/${A}/net/rules/vault-nope`)).status).toBe(404);
    await call("PUT", `/api/vault/${it.id}/projects`, { projectIds: [] });
    expect(((await call("GET", `/api/projects/${A}/net/rules`)).body as any[]).some((r) => r.source === "vault")).toBe(false);
  });
});

describe("a new item given to a running project", () => {
  test("reaches its VM at once: env file written with the placeholder, access no longer pending", async () => {
    exec.mockClear();
    const made = (await call("POST", "/api/vault", { name: "GITHUB_TOKEN", value: "ghp_new", mode: "proxy", bindings: [{ host: "github.com" }], projectIds: [A] })).body;
    expect(made.projectIds).toEqual([A]);
    const env = exec.mock.calls.find((c) => String(c[1]).includes(".sadbox/env"));
    expect(env).toBeDefined();
    const written = new TextDecoder().decode(env![2] as Uint8Array);
    expect(written).toMatch(/^GITHUB_TOKEN='ghp_sbx/m);
    expect(written).not.toContain("ghp_new");
    expect(db.query("SELECT status FROM project_secrets WHERE secret_id = ?").get(made.id)).toEqual({ status: "injected" });
  });
});
