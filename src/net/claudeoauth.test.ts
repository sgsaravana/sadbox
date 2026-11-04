import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import {
  answerTokenRequest, claudeLogin, claudePlaceholders, isClaudeTokenRequest, oauthHttp, refreshClaude, refreshIfDue, saveClaudeLogin, vmOauth,
} from "./claudeoauth";
import { bodyRedactor, redactResponse, substituteRequest } from "./credentials";

const A = makeProject("co-a");
const B = makeProject("co-b");
const REAL_A = "sk-ant-oat01-" + "A".repeat(90);
const REAL_R = "sk-ant-ort01-" + "R".repeat(90);

// the token server: what was asked, and what it answers
let calls: { url: string; body: any }[] = [];
let answer: (body: any) => { status: number; json: any } = () => ({ status: 500, json: {} });
oauthHttp.fetch = async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  calls.push({ url, body });
  const a = answer(body);
  return new Response(JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
};
let n = 0;
const tokens = () => { n++; return { access_token: `sk-ant-oat01-${"N".repeat(80)}${n}`, refresh_token: `sk-ant-ort01-${"M".repeat(80)}${n}`, expires_in: 28_800, scope: "user:inference user:profile", token_type: "Bearer", account: { uuid: "acc" } }; };

/** A VM's call to the token endpoint. */
async function vmCall(projectId: string, body: unknown) {
  let status = 0, text = "";
  const res = {
    writeHead(s: number) { status = s; },
    end(b: Buffer | string) { text = b.toString(); },
  } as unknown as ServerResponse;
  await answerTokenRequest(projectId, projectId, "platform.claude.com", JSON.stringify(body), "application/json", res);
  return { status, json: JSON.parse(text || "{}"), text };
}

beforeEach(() => {
  db.run("DELETE FROM agent_logins"); db.run("DELETE FROM login_placeholders");
  calls = []; answer = () => ({ status: 200, json: tokens() });
});
const keep = () => saveClaudeLogin({ accessToken: REAL_A, refreshToken: REAL_R, expiresAt: Date.now() + 8 * 36e5, scopes: ["user:inference"] }, "co-a");

test("which requests are the token endpoint", () => {
  expect(isClaudeTokenRequest("https", "platform.claude.com", "POST", "/v1/oauth/token")).toBe(true);
  expect(isClaudeTokenRequest("https", "console.anthropic.com", "POST", "/v1/oauth/token?x=1")).toBe(true);
  expect(isClaudeTokenRequest("http", "platform.claude.com", "POST", "/v1/oauth/token")).toBe(false);
  expect(isClaudeTokenRequest("https", "platform.claude.com", "GET", "/v1/oauth/token")).toBe(false);
  expect(isClaudeTokenRequest("https", "api.anthropic.com", "POST", "/v1/oauth/token")).toBe(false);
});

describe("a /login in a VM", () => {
  test("sadbox makes the code exchange, keeps the tokens and hands the VM placeholders", async () => {
    const r = await vmCall(A, { grant_type: "authorization_code", code: "c", code_verifier: "v", client_id: "cid", redirect_uri: "x" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(calls[0].body.code).toBe("c");
    const kept = claudeLogin()!;
    expect(kept.accessToken).toStartWith("sk-ant-oat01-NNN");
    expect(kept.clientId).toBe("cid");
    const ph = claudePlaceholders(A)!;
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ access_token: ph.access, refresh_token: ph.refresh, account: { uuid: "acc" }, scope: "user:inference user:profile" });
    expect(r.json.expires_in).toBeGreaterThan(5 * 365 * 86400);
    expect(r.text).not.toContain("NNNN");
    expect(ph.access).toStartWith("sk-ant-oat01-sbx");
    expect(db.query("SELECT from_project FROM agent_logins").get()).toEqual({ from_project: A });
  });

  test("a refusal is passed on as it is, nothing kept", async () => {
    answer = () => ({ status: 400, json: { error: "invalid_grant" } });
    const r = await vmCall(A, { grant_type: "authorization_code", code: "bad" });
    expect(r).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect(claudeLogin()).toBeNull();
  });
});

describe("a refresh a VM asks for", () => {
  test("with its placeholder: sadbox refreshes for real (at most once a minute), the VM gets its placeholders back", async () => {
    keep();
    const ph = claudePlaceholders(A)!;
    const r = await vmCall(A, { grant_type: "refresh_token", refresh_token: ph.refresh, client_id: "x" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ grant_type: "refresh_token", refresh_token: REAL_R }); // the real one, from sadbox
    expect(r.json).toMatchObject({ access_token: ph.access, refresh_token: ph.refresh });
    expect(claudeLogin()!.accessToken).not.toBe(REAL_A);
    expect(claudeLogin()!.refreshToken).not.toBe(REAL_R); // rotated, and kept
    await vmCall(A, { grant_type: "refresh_token", refresh_token: ph.refresh });
    expect(calls).toHaveLength(1); // just refreshed: not again
    expect(claudePlaceholders(A)).toEqual(ph); // the VM's placeholders never change
  });

  test("with another VM's placeholder: refused, nothing sent", async () => {
    keep();
    const b = claudePlaceholders(B)!;
    claudePlaceholders(A);
    const r = await vmCall(A, { grant_type: "refresh_token", refresh_token: b.refresh });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("when the login is refused upstream: the VM is told, and the login says why", async () => {
    keep();
    answer = () => ({ status: 400, json: { error: "invalid_grant", error_description: "Refresh token revoked" } });
    const r = await vmCall(A, { grant_type: "refresh_token", refresh_token: claudePlaceholders(A)!.refresh });
    expect(r).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect(db.query<{ status: string }, []>("SELECT status FROM agent_logins").get()!.status).toMatch(/refresh refused \(invalid_grant: Refresh token revoked\)/);
    // and sadbox does not keep trying on its own
    db.query("UPDATE agent_logins SET expires_at = ?").run(Date.now());
    await refreshIfDue();
    expect(calls).toHaveLength(1);
  });

  test("with a VM's own real refresh token (a login from before): sent on, and taken over", async () => {
    const r = await vmCall(A, { grant_type: "refresh_token", refresh_token: REAL_R, client_id: "cid" });
    expect(calls[0].body.refresh_token).toBe(REAL_R);
    expect(r.json.access_token).toBe(claudePlaceholders(A)!.access);
    expect(claudeLogin()!.accessToken).toStartWith("sk-ant-oat01-NNN");
  });
});

describe("sadbox's own refresh", () => {
  test("ahead of expiry only, one at a time", async () => {
    keep();
    await refreshIfDue();
    expect(calls).toHaveLength(0);
    db.query("UPDATE agent_logins SET expires_at = ?").run(Date.now() + 5 * 60_000);
    await Promise.all([refreshIfDue(), refreshClaude("x"), refreshClaude("y")]);
    expect(calls).toHaveLength(1);
    expect(db.query<{ expires_at: number }, []>("SELECT expires_at FROM agent_logins").get()!.expires_at).toBeGreaterThan(Date.now() + 7 * 36e5);
  });
});

describe("through the proxy", () => {
  test("the access placeholder becomes the real token — as a bearer token to Claude's API only", () => {
    keep();
    const ph = claudePlaceholders(A)!;
    const send = (host: string, headers: Record<string, unknown>) =>
      substituteRequest(A, { scheme: "https", host, path: "/v1/messages", method: "POST" }, headers);
    const h1: Record<string, unknown> = { authorization: `Bearer ${ph.access}` };
    expect(send("api.anthropic.com", h1).injected).toEqual(["Claude login"]);
    expect(h1.authorization).toBe(`Bearer ${REAL_A}`);
    const h2: Record<string, unknown> = { authorization: `Bearer ${ph.access}` };
    const elsewhere = send("evil.example.com", h2);
    expect(elsewhere).toMatchObject({ injected: [], unbound: [] }); // not swapped, nobody asked
    expect(h2.authorization).toBe(`Bearer ${ph.access}`);
    const h3: Record<string, unknown> = { "x-api-key": ph.access };
    send("api.anthropic.com", h3);
    expect(h3["x-api-key"]).toBe(ph.access);
    const h4: Record<string, unknown> = { authorization: `Bearer ${ph.refresh}` };
    send("api.anthropic.com", h4);
    expect(h4.authorization).toBe(`Bearer ${ph.refresh}`); // the refresh token is never sent
    // another project, given no placeholders, gets nothing swapped
    const h5: Record<string, unknown> = { authorization: `Bearer ${ph.access}` };
    expect(substituteRequest(B, { scheme: "https", host: "api.anthropic.com", path: "/", method: "GET" }, h5).injected).toEqual([]);
  });

  test("a real token in a response becomes the VM's placeholder", () => {
    keep();
    const ph = claudePlaceholders(A)!;
    const headers: Record<string, unknown> = { "x-echo": REAL_A };
    expect(redactResponse(A, headers)).toEqual(["Claude login"]);
    expect(headers["x-echo"]).toBe(ph.access);
    const r = bodyRedactor(A)!;
    const out = Buffer.concat([r.write(Buffer.from(`{"t":"${REAL_R.slice(0, 30)}`)), r.write(Buffer.from(`${REAL_R.slice(30)}"}`)), r.end()]).toString();
    expect(out).toBe(`{"t":"${ph.refresh}"}`);
  });

  test("the VM's login file: placeholders, an expiry years away", () => {
    keep();
    const o = vmOauth(A)!;
    expect(o).toMatchObject({ accessToken: claudePlaceholders(A)!.access, scopes: ["user:inference"] });
    expect(o.expiresAt as number).toBeGreaterThan(Date.now() + 5 * 365 * 864e5);
    expect(JSON.stringify(o)).not.toContain("AAAA");
  });
});
