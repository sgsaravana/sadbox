import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db";
import { encrypt } from "../crypto";
import { makeProject } from "../../test/helpers";
import {
  applyHeaders, createHeaderRule, createRule, deleteRule, evaluate, listHeaderRules, listRules, purgeProjectNet,
} from "./rules";

const A = makeProject("rules-a");
const B = makeProject("rules-b");
const req = (host: string, path = "/", method = "GET") => ({ host, path, method });

beforeEach(() => {
  db.run("DELETE FROM net_rules");
  db.run("DELETE FROM net_header_rules");
  db.run("DELETE FROM secrets");
});

function secret(id: string, value: string, projectId: string | null = null) {
  db.query("INSERT INTO secrets (id, project_id, name, value_enc) VALUES (?, ?, ?, ?)")
    .run(id, projectId, `S_${id}`, encrypt(value));
  return id;
}

describe("createRule", () => {
  test("normalizes the host: case, scheme, path and port are stripped", () => {
    const r = createRule({ scope: "global", action: "allow", host: "  HTTPS://API.GitHub.com:443/repos " });
    expect(r.host).toBe("api.github.com");
    expect(r.scope).toBe("global");
    expect(r.project_id).toBeNull();
  });

  test("uppercases the method and blanks an empty path", () => {
    const r = createRule({ scope: "global", action: "block", host: "x.com", method: "post", path: "  " });
    expect(r.method).toBe("POST");
    expect(r.path).toBeNull();
  });

  test("rejects an empty host, a bad action, and a project rule without a project", () => {
    expect(() => createRule({ scope: "global", action: "allow", host: "  " })).toThrow(/host is required/);
    expect(() => createRule({ scope: "global", action: "maybe" as any, host: "x.com" })).toThrow(/action/);
    expect(() => createRule({ scope: "project", action: "allow", host: "x.com" })).toThrow(/projectId/);
  });

  test("a global rule ignores a stray projectId", () => {
    const r = createRule({ scope: "global", projectId: A, action: "allow", host: "x.com" });
    expect(r.project_id).toBeNull();
  });
});

describe("evaluate", () => {
  test("no matching rule asks (block-by-default)", () => {
    expect(evaluate(A, req("example.com")).decision).toBe("ask");
    createRule({ scope: "global", action: "allow", host: "other.com" });
    expect(evaluate(A, req("example.com")).decision).toBe("ask");
  });

  test("an allow rule allows and reports which rule matched", () => {
    const r = createRule({ scope: "global", action: "allow", host: "example.com" });
    const v = evaluate(A, req("example.com"));
    expect(v.decision).toBe("allow");
    expect(v.rule?.id).toBe(r.id);
  });

  test("block wins over allow, whatever the scope or creation order", () => {
    createRule({ scope: "project", projectId: A, action: "allow", host: "example.com" });
    createRule({ scope: "global", action: "block", host: "*.example.com" });
    expect(evaluate(A, req("example.com")).decision).toBe("block");

    db.run("DELETE FROM net_rules");
    createRule({ scope: "project", projectId: A, action: "block", host: "example.com" });
    createRule({ scope: "global", action: "allow", host: "*" });
    expect(evaluate(A, req("example.com")).decision).toBe("block");
    expect(evaluate(A, req("elsewhere.com")).decision).toBe("allow");
  });

  test("host patterns: exact, *.suffix (incl. the bare domain) and *", () => {
    createRule({ scope: "global", action: "allow", host: "api.github.com" });
    expect(evaluate(A, req("api.github.com")).decision).toBe("allow");
    expect(evaluate(A, req("github.com")).decision).toBe("ask");
    expect(evaluate(A, req("x.api.github.com")).decision).toBe("ask");

    db.run("DELETE FROM net_rules");
    createRule({ scope: "global", action: "allow", host: "*.github.com" });
    expect(evaluate(A, req("github.com")).decision).toBe("allow");
    expect(evaluate(A, req("api.github.com")).decision).toBe("allow");
    expect(evaluate(A, req("a.b.github.com")).decision).toBe("allow");
    expect(evaluate(A, req("notgithub.com")).decision).toBe("ask");
    expect(evaluate(A, req("github.com.evil.io")).decision).toBe("ask");

    db.run("DELETE FROM net_rules");
    createRule({ scope: "global", action: "allow", host: "*" });
    expect(evaluate(A, req("anything.at.all")).decision).toBe("allow");
  });

  test("path: exact match, or prefix when the pattern ends in *", () => {
    createRule({ scope: "global", action: "allow", host: "x.com", path: "/v1/*" });
    expect(evaluate(A, req("x.com", "/v1/models")).decision).toBe("allow");
    expect(evaluate(A, req("x.com", "/v1/")).decision).toBe("allow");
    expect(evaluate(A, req("x.com", "/v2/models")).decision).toBe("ask");

    db.run("DELETE FROM net_rules");
    createRule({ scope: "global", action: "allow", host: "x.com", path: "/health" });
    expect(evaluate(A, req("x.com", "/health")).decision).toBe("allow");
    expect(evaluate(A, req("x.com", "/health/deep")).decision).toBe("ask");
    expect(evaluate(A, req("x.com", "/health?x=1")).decision).toBe("ask"); // query is part of the path
  });

  test("method restricts the rule, case-insensitively on the request side", () => {
    createRule({ scope: "global", action: "allow", host: "x.com", method: "get" });
    expect(evaluate(A, req("x.com", "/", "GET")).decision).toBe("allow");
    expect(evaluate(A, req("x.com", "/", "get")).decision).toBe("allow");
    expect(evaluate(A, req("x.com", "/", "POST")).decision).toBe("ask");
  });

  test("a narrow block carves an exception out of a broad allow", () => {
    createRule({ scope: "global", action: "allow", host: "x.com" });
    createRule({ scope: "global", action: "block", host: "x.com", path: "/admin*", method: "DELETE" });
    expect(evaluate(A, req("x.com", "/admin/users", "DELETE")).decision).toBe("block");
    expect(evaluate(A, req("x.com", "/admin/users", "GET")).decision).toBe("allow");
  });

  test("expired rules are ignored; unexpired timed rules apply", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    createRule({ scope: "global", action: "block", host: "x.com", expiresAt: past });
    expect(evaluate(A, req("x.com")).decision).toBe("ask");
    createRule({ scope: "global", action: "allow", host: "x.com", expiresAt: future });
    expect(evaluate(A, req("x.com")).decision).toBe("allow");
  });

  test("project rules apply only to their project; globals to everyone", () => {
    createRule({ scope: "project", projectId: A, action: "allow", host: "a-only.com" });
    createRule({ scope: "global", action: "allow", host: "shared.com" });
    expect(evaluate(A, req("a-only.com")).decision).toBe("allow");
    expect(evaluate(B, req("a-only.com")).decision).toBe("ask");
    expect(evaluate(B, req("shared.com")).decision).toBe("allow");
  });

  test("an unknown source (no project) is judged by global rules only", () => {
    createRule({ scope: "project", projectId: A, action: "allow", host: "a-only.com" });
    createRule({ scope: "global", action: "allow", host: "shared.com" });
    expect(evaluate(null, req("a-only.com")).decision).toBe("ask");
    expect(evaluate(null, req("shared.com")).decision).toBe("allow");
  });
});

describe("listing and cleanup", () => {
  test("listRules: globals only without a project, globals + own with one", () => {
    createRule({ scope: "global", action: "allow", host: "g.com" });
    createRule({ scope: "project", projectId: A, action: "allow", host: "a.com" });
    createRule({ scope: "project", projectId: B, action: "allow", host: "b.com" });
    expect(listRules().map((r) => r.host)).toEqual(["g.com"]);
    expect(listRules(A).map((r) => r.host).sort()).toEqual(["a.com", "g.com"]);
  });

  test("deleteRule removes it from evaluation", () => {
    const r = createRule({ scope: "global", action: "allow", host: "x.com" });
    deleteRule(r.id);
    expect(evaluate(A, req("x.com")).decision).toBe("ask");
  });

  test("purgeProjectNet drops that project's rules and header rules, nothing else", () => {
    createRule({ scope: "project", projectId: A, action: "allow", host: "a.com" });
    createRule({ scope: "project", projectId: B, action: "allow", host: "b.com" });
    createRule({ scope: "global", action: "allow", host: "g.com" });
    createHeaderRule({ scope: "project", projectId: A, host: "a.com", direction: "request", op: "remove", header: "X-A" });
    createHeaderRule({ scope: "global", host: "g.com", direction: "request", op: "remove", header: "X-G" });
    purgeProjectNet(A);
    expect(listRules(A).map((r) => r.host)).toEqual(["g.com"]);
    expect(listRules(B).map((r) => r.host).sort()).toEqual(["b.com", "g.com"]);
    expect(listHeaderRules(A).map((r) => r.header)).toEqual(["X-G"]);
  });
});

describe("createHeaderRule", () => {
  const base = { scope: "global" as const, host: "x.com", direction: "request" as const, header: "X-T" };

  test("validates direction, op, header name, and that set has a value", () => {
    expect(() => createHeaderRule({ ...base, op: "set", value: "v", direction: "sideways" as any })).toThrow(/direction/);
    expect(() => createHeaderRule({ ...base, op: "replace" as any, value: "v" })).toThrow(/op/);
    expect(() => createHeaderRule({ ...base, op: "set", value: "v", header: "  " })).toThrow(/header name/);
    expect(() => createHeaderRule({ ...base, op: "set" })).toThrow(/value or a secret/);
    expect(() => createHeaderRule({ ...base, op: "set", valueSecretId: "nope" })).toThrow(/secret not found/);
  });

  test("a secret-backed rule stores the reference, not a value, and lists the secret's name", () => {
    const sid = secret("g1", "tok");
    const r = createHeaderRule({ ...base, op: "set", value: "ignored", valueSecretId: sid });
    expect(r.value).toBeNull();
    expect(r.value_secret_id).toBe(sid);
    expect(r.value_secret_name).toBe("S_g1");
  });

  test("a project's own secret is usable only by a rule scoped to that project", () => {
    const sid = secret("pa", "tok", A);
    expect(() => createHeaderRule({ ...base, op: "set", valueSecretId: sid })).toThrow(/another project/);
    expect(() => createHeaderRule({ ...base, scope: "project", projectId: B, op: "set", valueSecretId: sid }))
      .toThrow(/another project/);
    expect(createHeaderRule({ ...base, scope: "project", projectId: A, op: "set", valueSecretId: sid }).value_secret_id)
      .toBe(sid);
  });

  test("remove discards any value or secret given", () => {
    const sid = secret("g2", "tok");
    const r = createHeaderRule({ ...base, op: "remove", value: "v", valueSecretId: sid });
    expect(r.value).toBeNull();
    expect(r.value_secret_id).toBeNull();
  });
});

describe("applyHeaders", () => {
  test("set adds or overwrites, under the lowercased name", () => {
    createHeaderRule({ scope: "global", host: "x.com", direction: "request", op: "set", header: "X-Token", value: "abc" });
    const h: Record<string, unknown> = { "X-TOKEN": "old", accept: "*/*" };
    applyHeaders(A, "x.com", "request", h);
    expect(h).toEqual({ "x-token": "abc", accept: "*/*" });
  });

  test("remove deletes case-insensitively", () => {
    createHeaderRule({ scope: "global", host: "x.com", direction: "request", op: "remove", header: "cookie" });
    const h: Record<string, unknown> = { Cookie: "a=1", accept: "*/*" };
    applyHeaders(A, "x.com", "request", h);
    expect(h).toEqual({ accept: "*/*" });
  });

  test("only rules for the matching direction and host apply", () => {
    createHeaderRule({ scope: "global", host: "*.x.com", direction: "response", op: "set", header: "X-R", value: "1" });
    const reqH: Record<string, unknown> = {};
    applyHeaders(A, "api.x.com", "request", reqH);
    expect(reqH).toEqual({});
    const other: Record<string, unknown> = {};
    applyHeaders(A, "y.com", "response", other);
    expect(other).toEqual({});
    const hit: Record<string, unknown> = {};
    applyHeaders(A, "api.x.com", "response", hit);
    expect(hit).toEqual({ "x-r": "1" });
  });

  test("project header rules do not leak to other projects or unknown sources", () => {
    createHeaderRule({ scope: "project", projectId: A, host: "x.com", direction: "request", op: "set", header: "X-A", value: "1" });
    const a: Record<string, unknown> = {}, b: Record<string, unknown> = {}, none: Record<string, unknown> = {};
    applyHeaders(A, "x.com", "request", a);
    applyHeaders(B, "x.com", "request", b);
    applyHeaders(null, "x.com", "request", none);
    expect(a).toEqual({ "x-a": "1" });
    expect(b).toEqual({});
    expect(none).toEqual({});
  });

  test("a secret-backed value is decrypted at apply time", () => {
    const sid = secret("g3", "Bearer real-token");
    createHeaderRule({ scope: "global", host: "api.x.com", direction: "request", op: "set", header: "Authorization", valueSecretId: sid });
    const h: Record<string, unknown> = { authorization: "Bearer placeholder" };
    applyHeaders(A, "api.x.com", "request", h);
    expect(h.authorization).toBe("Bearer real-token");
  });

  test("a deleted secret leaves the header untouched rather than blanking it", () => {
    const sid = secret("g4", "tok");
    createHeaderRule({ scope: "global", host: "x.com", direction: "request", op: "set", header: "Authorization", valueSecretId: sid });
    db.query("DELETE FROM secrets WHERE id=?").run(sid);
    const h: Record<string, unknown> = { authorization: "original" };
    applyHeaders(A, "x.com", "request", h);
    expect(h.authorization).toBe("original");
  });

  test("another project's secret is never resolved, even if a rule references it", () => {
    const sid = secret("pb", "b-token", B);
    // bypass createHeaderRule's guard to simulate a stale/hand-edited row
    db.query(
      `INSERT INTO net_header_rules (id, scope, project_id, host, direction, op, header, value_secret_id)
       VALUES ('leak', 'global', NULL, 'x.com', 'request', 'set', 'Authorization', ?)`,
    ).run(sid);
    const a: Record<string, unknown> = {}, b: Record<string, unknown> = {};
    applyHeaders(A, "x.com", "request", a);
    applyHeaders(B, "x.com", "request", b);
    expect(a).toEqual({});
    expect(b).toEqual({ authorization: "b-token" });
  });
});
