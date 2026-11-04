import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { createItem, getItem, revokeFetchGrant, setItemProjects } from "../core/vault";
import { listPending, resolveApproval } from "./approvals";
import { recentRequests } from "./events";
import { serveVault, VAULT_HOST } from "./vaultfetch";

const A = makeProject("vf-a");
const B = makeProject("vf-b");
const exec = spyOn(getDriver(), "execWithStdin").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
afterAll(() => exec.mockRestore());

beforeEach(() => {
  db.run("DELETE FROM secrets");
  db.run("DELETE FROM project_secrets");
  db.run("DELETE FROM vault_fetch_grants");
});

/** What a VM's GET to the vault host gets back. */
async function get(projectId: string | null, path: string, method = "GET") {
  let status = 0, body = "", headers: Record<string, string> = {};
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; headers = h; },
    end(b: Buffer) { body = b.toString("utf8"); },
  } as unknown as ServerResponse;
  await serveVault(projectId, "http", method, path, res);
  return { status, body, type: headers["content-type"] };
}
const events = (projectId: string) => db.query<{ detail: string }, [string]>(
  "SELECT detail FROM events WHERE project_id = ? AND type = 'vault.fetch' ORDER BY rowid").all(projectId).map((r) => r.detail);
/** Wait for the fetch to be held, then answer it. */
async function answer(projectId: string, action: "allow" | "block", duration = "once") {
  let p; for (let i = 0; i < 50 && !p; i++) { await Bun.sleep(10); p = listPending(projectId).find((x) => x.fetch); }
  expect(p).toBeDefined();
  expect(p!.host).toBe(VAULT_HOST);
  resolveApproval(p!.id, action, duration);
  return p!;
}

describe("listing", () => {
  test("the items this project may use, with no values", async () => {
    createItem({ name: "REGION", value: "eu-west-1", kind: "variable", projectIds: [A] });
    createItem({ name: "DB_PASSWORD", value: "hunter2-long", projectIds: [A] });
    createItem({ name: "GITHUB_TOKEN", value: "ghp_x".padEnd(40, "x"), mode: "proxy", bindings: [{ host: "api.github.com" }], projectIds: [A] });
    createItem({ name: "B_ONLY", value: "nope", projectIds: [B] });
    const r = await get(A, "/v1/");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual([
      { name: "DB_PASSWORD", kind: "secret", type: "string", mode: "fetch", asks: true },
      { name: "GITHUB_TOKEN", kind: "secret", type: "string", mode: "proxy" },
      { name: "REGION", kind: "variable", type: "string", mode: "fetch", asks: false },
    ]);
    expect(r.body).not.toContain("hunter2");
  });
});

describe("fetching", () => {
  test("an item that doesn't ask is served at once, and the read is logged by name only", async () => {
    createItem({ name: "REGION", value: "eu-west-1", kind: "variable", projectIds: [A] });
    const r = await get(A, "/v1/REGION");
    expect(r).toMatchObject({ status: 200, body: "eu-west-1" });
    expect(events(A).at(-1)).toBe("REGION: served");
    const row = recentRequests(A).at(-1)!;
    expect(row).toMatchObject({ host: VAULT_HOST, path: "/v1/REGION", status: 200, decision: "allowed", credentials: ["REGION"] });
    expect(JSON.stringify(recentRequests(A))).not.toContain("eu-west-1");
  });

  test("typed values come back typed as JSON on request", async () => {
    createItem({ name: "LIMIT", value: "50", type: "number", kind: "variable", projectIds: [A] });
    createItem({ name: "CFG", value: '{"a":[1,2]}', type: "json", kind: "variable", projectIds: [A] });
    expect(JSON.parse((await get(A, "/v1/LIMIT?format=json")).body)).toEqual({ name: "LIMIT", type: "number", value: 50 });
    const cfg = await get(A, "/v1/CFG");
    expect(cfg).toMatchObject({ body: '{"a":[1,2]}', type: "application/json" });
  });

  test("a secret that asks waits for the owner: once means once", async () => {
    createItem({ name: "DB_PASSWORD", value: "hunter2-long", projectIds: [A] });
    const pending = get(A, "/v1/DB_PASSWORD");
    const p = await answer(A, "allow", "once");
    expect(p.fetch).toEqual({ name: "DB_PASSWORD" });
    expect(await pending).toMatchObject({ status: 200, body: "hunter2-long" });
    // and the next read asks again
    const again = get(A, "/v1/DB_PASSWORD");
    await answer(A, "block");
    expect((await again).status).toBe(403);
    expect(events(A).slice(-2)).toEqual(["DB_PASSWORD: served", "DB_PASSWORD: denied"]);
  });

  test("allowed for a window: no more asking until it is revoked", async () => {
    const s = createItem({ name: "DB_PASSWORD", value: "hunter2-long", projectIds: [A] });
    const first = get(A, "/v1/DB_PASSWORD");
    await answer(A, "allow", "60m");
    expect((await first).status).toBe(200);
    expect(getItem(s.id).fetchGrants).toEqual([{ projectId: A, expiresAt: expect.any(String) }]);
    expect(await get(A, "/v1/DB_PASSWORD")).toMatchObject({ status: 200, body: "hunter2-long" }); // no prompt
    revokeFetchGrant(s.id, A);
    const asked = get(A, "/v1/DB_PASSWORD");
    await answer(A, "block");
    expect((await asked).status).toBe(403);
  });

  test("losing access takes a standing answer with it", async () => {
    const s = createItem({ name: "DB_PASSWORD", value: "hunter2-long", projectIds: [A] });
    const first = get(A, "/v1/DB_PASSWORD");
    await answer(A, "allow", "forever");
    await first;
    await setItemProjects(s.id, []);
    await setItemProjects(s.id, [A]);
    expect(getItem(s.id).fetchGrants).toEqual([]);
  });

  test("a proxy item is never served — its value must not enter the VM", async () => {
    createItem({ name: "GITHUB_TOKEN", value: "ghp_x".padEnd(40, "x"), mode: "proxy", bindings: [{ host: "api.github.com" }], projectIds: [A] });
    const r = await get(A, "/v1/GITHUB_TOKEN");
    expect(r.status).toBe(403);
    expect(r.body).toContain("used through the proxy");
    expect(r.body).not.toContain("ghp_x");
  });

  test("someone else's item, an unknown name, no project, a POST, a bad path", async () => {
    createItem({ name: "B_ONLY", value: "nope", kind: "variable", projectIds: [B] });
    expect((await get(A, "/v1/B_ONLY")).status).toBe(404);
    expect((await get(A, "/v1/NOPE")).status).toBe(404);
    expect((await get(null, "/v1/B_ONLY")).status).toBe(403);
    expect((await get(B, "/v1/B_ONLY", "POST")).status).toBe(405);
    expect((await get(B, "/v2/B_ONLY")).status).toBe(404);
  });
});
