import { describe, expect, test, beforeEach } from "bun:test";
import { setSecrets, substituteRequest, redactResponse, swap } from "./subst";
import { prefixOf, variantA, variantB, variantC } from "./placeholder";

const GH = { name: "GITHUB_TOKEN", placeholder: "ghp_sbxPLACEHOLDER", value: "ghp_REALVALUE123", hosts: ["api.github.com", "*.github.com"] };
const ANT = { name: "ANTHROPIC_API_KEY", placeholder: "sk-ant-api03-sbxPH", value: "sk-ant-api03-REAL", hosts: ["api.anthropic.com"] };
const b64 = (s: string) => Buffer.from(s).toString("base64");

beforeEach(() => setSecrets([GH, ANT]));

describe("substituteRequest", () => {
  test("bearer to a bound host is swapped", () => {
    const h: Record<string, unknown> = { authorization: `Bearer ${GH.placeholder}` };
    const r = substituteRequest("https", "api.github.com", "/user", h);
    expect(h.authorization).toBe(`Bearer ${GH.value}`);
    expect(r.injected).toEqual(["GITHUB_TOKEN@authorization(bearer)"]);
  });

  test("wildcard binding matches subdomain and bare domain", () => {
    for (const host of ["github.com", "uploads.github.com"]) {
      const h: Record<string, unknown> = { authorization: `token ${GH.placeholder}` };
      substituteRequest("https", host, "/", h);
      expect(h.authorization).toBe(`token ${GH.value}`);
    }
  });

  test("git Basic auth is decoded, swapped, re-encoded", () => {
    const h: Record<string, unknown> = { authorization: `Basic ${b64(`x-access-token:${GH.placeholder}`)}` };
    const r = substituteRequest("https", "github.com", "/o/r.git/info/refs", h);
    expect(h.authorization).toBe(`Basic ${b64(`x-access-token:${GH.value}`)}`);
    expect(r.injected).toEqual(["GITHUB_TOKEN@authorization(basic)"]);
  });

  test("x-api-key raw header", () => {
    const h: Record<string, unknown> = { "x-api-key": ANT.placeholder };
    substituteRequest("https", "api.anthropic.com", "/v1/messages", h);
    expect(h["x-api-key"]).toBe(ANT.value);
  });

  test("unbound host keeps the placeholder", () => {
    const h: Record<string, unknown> = { authorization: `Bearer ${GH.placeholder}` };
    const r = substituteRequest("https", "evil.example", "/", h);
    expect(h.authorization).toBe(`Bearer ${GH.placeholder}`);
    expect(r.unbound).toEqual(["GITHUB_TOKEN@authorization(bearer)"]);
    expect(r.injected).toEqual([]);
  });

  test("secret A's placeholder is not swapped on secret B's host", () => {
    const h: Record<string, unknown> = { "x-api-key": GH.placeholder };
    substituteRequest("https", "api.anthropic.com", "/", h);
    expect(h["x-api-key"]).toBe(GH.placeholder);
  });

  test("plain http is never swapped", () => {
    const h: Record<string, unknown> = { authorization: `Bearer ${GH.placeholder}` };
    const r = substituteRequest("http", "api.github.com", "/", h);
    expect(h.authorization).toBe(`Bearer ${GH.placeholder}`);
    expect(r.refused.length).toBe(1);
  });

  test("placeholder in the URL is reported, not swapped", () => {
    const r = substituteRequest("https", "api.github.com", `/x?key=${GH.placeholder}`, {});
    expect(r.inPath).toEqual(["GITHUB_TOKEN"]);
  });

  test("no secrets loaded is a no-op", () => {
    setSecrets([]);
    const h: Record<string, unknown> = { authorization: `Bearer ${GH.placeholder}` };
    substituteRequest("https", "api.github.com", "/", h);
    expect(h.authorization).toBe(`Bearer ${GH.placeholder}`);
  });
});

describe("redactResponse", () => {
  test("real value in a response header becomes the placeholder", () => {
    const h: Record<string, unknown> = { "x-echo": `Bearer ${GH.value}`, "content-type": "text/plain" };
    const r = redactResponse(h);
    expect(h["x-echo"]).toBe(`Bearer ${GH.placeholder}`);
    expect(r.redacted).toEqual(["GITHUB_TOKEN@x-echo(bearer)"]);
  });

  test("array-valued headers (set-cookie) are covered", () => {
    const h: Record<string, unknown> = { "set-cookie": ["a=1", `t=${ANT.value}; Path=/`] };
    redactResponse(h);
    expect(h["set-cookie"]).toEqual(["a=1", `t=${ANT.placeholder}; Path=/`]);
  });

  test("Basic-encoded real value is redacted", () => {
    const h: Record<string, unknown> = { "x-echo-auth": `Basic ${b64(`u:${GH.value}`)}` };
    redactResponse(h);
    expect(h["x-echo-auth"]).toBe(`Basic ${b64(`u:${GH.placeholder}`)}`);
  });
});

describe("swap", () => {
  test("no match leaves value and reports nothing", () => {
    expect(swap("Bearer abc", "zzz", "y")).toEqual({ value: "Bearer abc", encodings: [] });
  });
});

describe("placeholder variants", () => {
  const real = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  test("prefix detection", () => {
    expect(prefixOf(real)).toBe("ghp_");
    expect(prefixOf("sk-ant-oat01-xyz")).toBe("sk-ant-oat01-");
    expect(prefixOf("plainopaquetoken")).toBe("");
  });
  test("(a) and (b) keep prefix and length; (a) carries the marker", () => {
    const a = variantA(real), b = variantB(real);
    expect(a.startsWith("ghp_sbx")).toBe(true);
    expect(a.length).toBe(real.length);
    expect(b.startsWith("ghp_")).toBe(true);
    expect(b.length).toBe(real.length);
    expect(/^ghp_[A-Za-z0-9]+$/.test(b)).toBe(true);
  });
  test("(c) is generic", () => {
    expect(variantC()).toMatch(/^sadbox-ph-[a-z0-9]{32}$/);
  });
});
