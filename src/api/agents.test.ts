// The Agents page's routes, against a real server on a spare port.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../config";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { historyRoot } from "../core/history";
import { saveClaudeLogin } from "../net/claudeoauth";
import { startServer } from "./http";

makeProject("agapi"); // a live project named proj-agapi
let server: ReturnType<typeof startServer>;
let base = "", cookie = "";
beforeAll(async () => {
  config.port = 0;
  config.password = "agents-api-test-password";
  server = startServer();
  base = `http://localhost:${server.port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ password: config.password }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});
afterAll(() => server.stop(true));
beforeEach(() => { db.run("DELETE FROM agent_logins"); db.run("DELETE FROM login_placeholders"); });

const call = async (method: string, path: string) => {
  const r = await fetch(base + path, { method, headers: { cookie, origin: base } });
  return { status: r.status, body: await r.json() as any };
};
const store = (name: string) => {
  mkdirSync(join(historyRoot(), name, "claude/projects"), { recursive: true });
  writeFileSync(join(historyRoot(), name, "claude/projects/s.jsonl"), "x".repeat(10));
};

describe("/api/agents", () => {
  test("needs a session", async () => {
    expect((await fetch(`${base}/api/agents`)).status).toBe(401);
  });

  test("logins (never their values) and history", async () => {
    saveClaudeLogin({ accessToken: "sk-ant-oat01-" + "S".repeat(80), refreshToken: "sk-ant-ort01-" + "T".repeat(80), expiresAt: Date.now() + 36e5 }, "proj-agapi");
    store("old-thing");
    const r = await call("GET", "/api/agents");
    expect(r.body.logins).toEqual([expect.objectContaining({ tool: "claude", provider: "claude.ai", kind: "oauth", shared: "placeholders", fromProject: "proj-agapi" })]);
    expect(JSON.stringify(r.body)).not.toContain("SSSS");
    expect(r.body.history.map((h: any) => h.name)).toContain("old-thing");
    expect(r.body.liveNames).toContain("proj-agapi");
  });

  test("forget a login", async () => {
    saveClaudeLogin({ accessToken: "a".repeat(20), refreshToken: "b".repeat(20), expiresAt: 0 }, "x");
    expect((await call("DELETE", "/api/agents/logins/claude/claude.ai")).body).toEqual({ ok: true });
    expect((await call("DELETE", "/api/agents/logins/claude/claude.ai")).status).toBe(404);
  });

  test("delete history — not a live project's", async () => {
    store("old-thing"); store("proj-agapi");
    expect((await call("DELETE", "/api/agents/history/old-thing")).body).toEqual({ ok: true });
    expect(existsSync(join(historyRoot(), "old-thing"))).toBe(false);
    const live = await call("DELETE", "/api/agents/history/proj-agapi");
    expect(live.status).toBe(400);
    expect(live.body.error).toMatch(/destroy it first/);
    expect((await call("DELETE", "/api/agents/history/Bad_Name")).status).toBe(400);
  });

  test("refresh with no login", async () => {
    expect((await call("POST", "/api/agents/claude/refresh")).status).toBe(404);
  });
});
