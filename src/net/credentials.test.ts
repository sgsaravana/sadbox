import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import {
  addBinding, assignSecrets, createGlobalSecret, createProjectSecret, injectSecrets, listBindings, projectSecretView,
  type BindingInput,
} from "../core/secrets";
import { bindFromApproval, redactResponse, substituteRequest } from "./credentials";
import { listPending, requestApproval, resolveApproval } from "./approvals";

const A = makeProject("cred-a");
const B = makeProject("cred-b");
const GH = "ghp_" + "R3alT0kenR3alT0kenR3alT0kenR3alT0ken";
const ANT = "sk-ant-api03-" + "k".repeat(40);

// injectSecrets writes into the VM; here it only needs to mint placeholders
const exec = spyOn(getDriver(), "execWithStdin").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
afterAll(() => exec.mockRestore());

beforeEach(() => {
  db.run("DELETE FROM secrets");
  db.run("DELETE FROM secret_placeholders");
});

/** A proxy secret assigned to `projectId`, injected; returns its id and that project's placeholder. */
async function proxySecret(name: string, value: string, bindings: BindingInput[], projectId = A) {
  const s = createGlobalSecret(name, value, { delivery: "proxy", bindings });
  const assigned = db.query<{ secret_id: string }, [string]>(
    "SELECT secret_id FROM project_secrets WHERE project_id = ?").all(projectId).map((r) => r.secret_id);
  assignSecrets(projectId, [...assigned, s.id]);
  await injectSecrets(projectId);
  const ph = projectSecretView(projectId).assigned.find((x) => x.id === s.id)!.placeholder!;
  return { id: s.id, ph };
}

const req = (host: string, path = "/", scheme = "https", method = "GET") => ({ scheme, host, path, method });
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("substituteRequest", () => {
  test("a bound host gets the real value; the result names the secret, not the value", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}` };
    const r = substituteRequest(A, req("api.github.com", "/user"), h);
    expect(h.authorization).toBe(`Bearer ${GH}`);
    expect(r).toEqual({ injected: ["GITHUB_TOKEN"], unbound: [], plainHttp: [], inUrl: [] });
  });

  test("git's Basic credential is decoded, swapped and re-encoded", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "github.com" }]);
    const h: Record<string, unknown> = { authorization: `Basic ${b64(`x-access-token:${ph}`)}` };
    substituteRequest(A, req("github.com", "/o/r.git/info/refs?service=git-upload-pack"), h);
    expect(h.authorization).toBe(`Basic ${b64(`x-access-token:${GH}`)}`);
  });

  test("raw x-api-key and `token` schemes are covered", async () => {
    const ant = await proxySecret("ANTHROPIC_API_KEY", ANT, [{ host: "api.anthropic.com" }]);
    const gh = await proxySecret("GH_TOKEN", GH, [{ host: "api.github.com" }]);
    const h1: Record<string, unknown> = { "x-api-key": ant.ph };
    substituteRequest(A, req("api.anthropic.com", "/v1/messages", "https", "POST"), h1);
    expect(h1["x-api-key"]).toBe(ANT);
    const h2: Record<string, unknown> = { authorization: `token ${gh.ph}` };
    substituteRequest(A, req("api.github.com", "/graphql", "https", "POST"), h2);
    expect(h2.authorization).toBe(`token ${GH}`);
  });

  test("an unbound host is reported and left with the placeholder", async () => {
    const { id, ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}` };
    const r = substituteRequest(A, req("evil.example"), h);
    expect(h.authorization).toBe(`Bearer ${ph}`);
    expect(r.unbound).toEqual([{ secretId: id, name: "GITHUB_TOKEN" }]);
    expect(r.injected).toEqual([]);
  });

  test("plain http never gets a real value", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}` };
    const r = substituteRequest(A, req("api.github.com", "/", "http"), h);
    expect(h.authorization).toBe(`Bearer ${ph}`);
    expect(r.plainHttp).toEqual(["GITHUB_TOKEN"]);
  });

  test("a placeholder in the URL is reported, never swapped", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const r = substituteRequest(A, req("api.github.com", `/user?access_token=${ph}`), {});
    expect(r.inUrl).toEqual(["GITHUB_TOKEN"]);
    expect(r.injected).toEqual([]);
  });

  test("bindings narrow by path (query ignored), method and header", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [
      { host: "api.github.com", path: "/repos/*", method: "GET", header: "authorization" },
    ]);
    const ok = (path: string, method = "GET", header = "authorization") => {
      const h: Record<string, unknown> = { [header]: `Bearer ${ph}` };
      return substituteRequest(A, req("api.github.com", path, "https", method), h).injected.length === 1;
    };
    expect(ok("/repos/o/r?page=2")).toBe(true);
    expect(ok("/user")).toBe(false);
    expect(ok("/repos/o/r", "DELETE")).toBe(false);
    expect(ok("/repos/o/r", "GET", "x-token")).toBe(false);
  });

  test("a placeholder in an uncovered header holds back the whole secret", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com", header: "authorization" }]);
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}`, "x-forward-token": ph };
    const r = substituteRequest(A, req("api.github.com"), h);
    expect(r.unbound.length).toBe(1);
    expect(h.authorization).toBe(`Bearer ${ph}`);
  });

  test("an expired binding no longer counts", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [
      { host: "api.github.com", expiresAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    const r = substituteRequest(A, req("api.github.com"), { authorization: `Bearer ${ph}` });
    expect(r.unbound.length).toBe(1);
  });

  test("alsoAllow lets an approved secret through without a binding", async () => {
    const { id, ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}` };
    const r = substituteRequest(A, req("uploads.example.com"), h, new Set([id]));
    expect(r.injected).toEqual(["GITHUB_TOKEN"]);
    expect(h.authorization).toBe(`Bearer ${GH}`);
  });

  test("another project's placeholder means nothing here", async () => {
    const { ph: phB } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }], B);
    const h: Record<string, unknown> = { authorization: `Bearer ${phB}` };
    const r = substituteRequest(A, req("api.github.com"), h);
    expect(h.authorization).toBe(`Bearer ${phB}`);
    expect(r).toEqual({ injected: [], unbound: [], plainHttp: [], inUrl: [] });
  });

  test("a secret unassigned from the project stops being swapped", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    assignSecrets(A, []);
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}` };
    expect(substituteRequest(A, req("api.github.com"), h).injected).toEqual([]);
  });

  test("a project-specific proxy secret works like a global one", async () => {
    const s = createProjectSecret(A, "OWN", GH, { delivery: "proxy", bindings: [{ host: "api.github.com" }] });
    await injectSecrets(A);
    const ph = projectSecretView(A).own.find((o) => o.id === s.id)!.placeholder!;
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}` };
    expect(substituteRequest(A, req("api.github.com"), h).injected).toEqual(["OWN"]);
  });
});

describe("redactResponse", () => {
  test("a real value in a response header goes back to the placeholder", async () => {
    const { ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const h: Record<string, unknown> = {
      "x-echo": `Bearer ${GH}`,
      "set-cookie": ["a=1", `t=${GH}; Path=/`],
      "x-auth": `Basic ${b64(`u:${GH}`)}`,
      "content-type": "application/json",
    };
    expect(redactResponse(A, h)).toEqual(["GITHUB_TOKEN"]);
    expect(h["x-echo"]).toBe(`Bearer ${ph}`);
    expect(h["set-cookie"]).toEqual(["a=1", `t=${ph}; Path=/`]);
    expect(h["x-auth"]).toBe(`Basic ${b64(`u:${ph}`)}`);
    expect(h["content-type"]).toBe("application/json");
  });

  test("nothing to redact, nothing reported", async () => {
    await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    expect(redactResponse(A, { "content-type": "text/plain" })).toEqual([]);
  });
});

describe("credential approvals", () => {
  const ask = (secretId: string, host: string) =>
    requestApproval({ projectId: A, host, method: "GET", scheme: "https", path: "/", credential: { secretId, name: "GITHUB_TOKEN" } });
  const pendingFor = (host: string) => listPending(A).find((p) => p.host === host && p.credential)!;

  test("shows the secret's name (never its id or value) and is separate from a network ask", async () => {
    const { id } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const net = requestApproval({ projectId: A, host: "x.example", method: "GET", scheme: "https", path: "/" });
    const cred = ask(id, "x.example");
    const views = listPending(A).filter((p) => p.host === "x.example");
    expect(views.length).toBe(2);
    expect(pendingFor("x.example").credential).toEqual({ name: "GITHUB_TOKEN" });
    for (const v of views) resolveApproval(v.id, "block", "once");
    expect(await net).toBe("block");
    expect(await cred).toBe("block");
  });

  test("allow forever binds the secret to the host; it then swaps without asking", async () => {
    const { id, ph } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const p = ask(id, "uploads.example.com");
    resolveApproval(pendingFor("uploads.example.com").id, "allow", "forever");
    expect(await p).toBe("allow");
    expect(listBindings(id).find((b) => b.host === "uploads.example.com")).toMatchObject({ expires_at: null });
    const h: Record<string, unknown> = { authorization: `Bearer ${ph}` };
    expect(substituteRequest(A, req("uploads.example.com"), h).injected).toEqual(["GITHUB_TOKEN"]);
  });

  test("a timed allow binds with an expiry; once and block bind nothing", async () => {
    const { id } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    for (const [host, action, duration] of [["t.example", "allow", "5m"], ["o.example", "allow", "once"], ["b.example", "block", "forever"]] as const) {
      const p = ask(id, host);
      resolveApproval(pendingFor(host).id, action, duration);
      await p;
    }
    const hosts = Object.fromEntries(listBindings(id).map((b) => [b.host, b.expires_at]));
    expect(Date.parse(hosts["t.example"]!)).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect("o.example" in hosts).toBe(false);
    expect("b.example" in hosts).toBe(false);
  });

  test("blocking a credential never writes a network block rule", async () => {
    const { id } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    const p = ask(id, "nb.example");
    resolveApproval(pendingFor("nb.example").id, "block", "forever");
    await p;
    expect(db.query("SELECT COUNT(*) AS n FROM net_rules WHERE host = 'nb.example'").get()).toEqual({ n: 0 });
  });

  test("bindFromApproval adds a host-only binding", async () => {
    const { id } = await proxySecret("GITHUB_TOKEN", GH, [{ host: "api.github.com" }]);
    bindFromApproval(id, "raw.example.com", null);
    expect(listBindings(id).map((b) => b.host)).toEqual(["api.github.com", "raw.example.com"]);
    addBinding(id, { host: "z.example.com" }); // and the normal path still works alongside
    expect(listBindings(id).length).toBe(3);
  });
});
