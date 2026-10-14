import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { makePlaceholder, placeholderFor, prefixOf } from "./placeholders";
import {
  addBinding, assignSecrets, createGlobalSecret, createProjectSecret, deleteBinding, deleteSecret,
  injectSecrets, listBindings, listGlobalSecrets, projectSecretView, purgeProjectSecrets,
} from "./secrets";

const A = makeProject("sec-a");
const B = makeProject("sec-b");
const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const github = [{ host: "api.github.com" }, { host: "github.com" }];

// capture what injectSecrets writes into the VM instead of running it there
const written = new Map<string, string>();
const exec = spyOn(getDriver(), "execWithStdin").mockImplementation(async (ref, _cmd, stdin) => {
  written.set(ref, new TextDecoder().decode(stdin as Uint8Array));
  return { exitCode: 0, stdout: "", stderr: "" };
});
afterAll(() => exec.mockRestore());
const envOf = (id: string) => written.get(`sadbox-proj-${id}`) ?? "";

beforeEach(() => {
  db.run("DELETE FROM secrets");
  db.run("DELETE FROM secret_placeholders");
  written.clear();
});

describe("placeholders", () => {
  test("keep the token's prefix and length, carry the sbx marker, and differ every time", () => {
    const a = makePlaceholder(GH), b = makePlaceholder(GH);
    expect(a.startsWith("ghp_sbx")).toBe(true);
    expect(a.length).toBe(GH.length);
    expect(/^ghp_sbx[A-Za-z0-9]+$/.test(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  test("known prefixes win over the generic separator rule", () => {
    expect(prefixOf("sk-ant-oat01-abc")).toBe("sk-ant-oat01-");
    expect(prefixOf("github_pat_11AB_xyz")).toBe("github_pat_");
    expect(prefixOf("opaque")).toBe("");
  });

  test("a short or narrow-alphabet token still gets a long, mixed random tail", () => {
    const p = makePlaceholder("abc");
    expect(p.startsWith("sbx")).toBe(true);
    expect(p.length).toBeGreaterThanOrEqual(3 + 24);
    expect(makePlaceholder("1111111111").length).toBeGreaterThanOrEqual(3 + 24);
  });

  test("one per (project, secret): stable for a project, different across projects", () => {
    const s = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: github });
    const a1 = placeholderFor(A, s.id, GH), a2 = placeholderFor(A, s.id, GH), b1 = placeholderFor(B, s.id, GH);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });
});

describe("creating secrets", () => {
  test("delivery defaults to env, with no bindings", () => {
    const s = createGlobalSecret("PLAIN", "v");
    expect(s.delivery).toBe("env");
    expect(listGlobalSecrets().find((r) => r.id === s.id)).toMatchObject({ delivery: "env", bindings: [] });
  });

  test("a proxy secret stores its bindings, normalized", () => {
    const s = createGlobalSecret("GITHUB_TOKEN", GH, {
      delivery: "proxy",
      bindings: [{ host: "HTTPS://API.GitHub.com/x", path: " /repos/* ", method: "get", header: "Authorization" }],
    });
    expect(listBindings(s.id)).toMatchObject([
      { host: "api.github.com", path: "/repos/*", method: "GET", header: "authorization", expires_at: null },
    ]);
  });

  test("a proxy secret needs a binding; an env secret can't have one", () => {
    expect(() => createGlobalSecret("X", "v", { delivery: "proxy" })).toThrow(/at least one host/);
    expect(() => createGlobalSecret("Y", "v", { bindings: github })).toThrow(/only apply to proxy/);
    expect(() => createGlobalSecret("Z", "v", { delivery: "carrier-pigeon" as any })).toThrow(/env or proxy/);
  });

  test("bindings that would send a secret anywhere, or are malformed, are refused", () => {
    const bad = (b: object) => () => createGlobalSecret("BAD", "v", { delivery: "proxy", bindings: [b as any] });
    expect(bad({ host: "*" })).toThrow(/every host/);
    expect(bad({ host: "*.com" })).toThrow(/too broad/);
    expect(bad({ host: "api.*.com" })).toThrow(/bad host pattern/);
    expect(bad({ host: " " })).toThrow(/needs a host/);
    expect(bad({ host: "a.com", path: "repos" })).toThrow(/bad path/);
    expect(bad({ host: "a.com", path: "/a*/b" })).toThrow(/bad path/);
    expect(bad({ host: "a.com", method: "GE T" })).toThrow(/bad method/);
    expect(bad({ host: "a.com", header: "x api" })).toThrow(/bad header/);
    expect(bad({ host: "a.com", expiresAt: "soon" })).toThrow(/bad expiry/);
    // nothing half-created
    expect(listGlobalSecrets().some((s) => s.name === "BAD")).toBe(false);
  });

  test("a bad binding in the list rolls back the whole secret", () => {
    expect(() => createGlobalSecret("ROLLBACK", "v", {
      delivery: "proxy", bindings: [{ host: "ok.example.com" }, { host: "*" }],
    })).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM secret_bindings").get()).toEqual({ n: 0 });
  });
});

describe("bindings", () => {
  test("added to and removed from a proxy secret", () => {
    const s = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: [{ host: "api.github.com" }] });
    const b = addBinding(s.id, { host: "*.githubusercontent.com" });
    expect(listBindings(s.id).map((x) => x.host)).toEqual(["api.github.com", "*.githubusercontent.com"]);
    deleteBinding(s.id, b.id);
    expect(listBindings(s.id).map((x) => x.host)).toEqual(["api.github.com"]);
  });

  test("can't be added to an env secret, an unknown secret, or removed from the wrong one", () => {
    const env = createGlobalSecret("PLAIN", "v");
    const px = createGlobalSecret("PX", GH, { delivery: "proxy", bindings: github });
    expect(() => addBinding(env.id, { host: "a.com" })).toThrow(/only apply to proxy/);
    expect(() => addBinding("nope", { host: "a.com" })).toThrow(/not found/);
    const [b] = listBindings(px.id);
    expect(() => deleteBinding(env.id, b.id)).toThrow(/not found/);
  });

  test("go when their secret is deleted", async () => {
    const s = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: github });
    await deleteSecret(s.id);
    expect(listBindings(s.id)).toEqual([]);
  });
});

describe("injection", () => {
  test("an env secret's real value goes into the VM; a proxy secret's never does", async () => {
    const env = createGlobalSecret("PLAIN", "plain-value");
    const px = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: github });
    assignSecrets(A, [env.id, px.id]);
    await injectSecrets(A);

    const file = envOf(A);
    expect(file).toContain("PLAIN='plain-value'");
    expect(file).not.toContain(GH);
    const ph = projectSecretView(A).assigned.find((s) => s.id === px.id)!.placeholder!;
    expect(ph.startsWith("ghp_sbx")).toBe(true);
    expect(file).toContain(`GITHUB_TOKEN='${ph}'`);
  });

  test("re-injecting keeps the same placeholder; another project gets its own", async () => {
    const px = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: github });
    assignSecrets(A, [px.id]);
    assignSecrets(B, [px.id]);
    await injectSecrets(A);
    const first = envOf(A);
    await injectSecrets(A);
    await injectSecrets(B);
    expect(envOf(A)).toBe(first);
    expect(envOf(B)).not.toBe(first);
  });

  test("a project-specific proxy secret gets a placeholder too", async () => {
    const s = createProjectSecret(A, "OWN_TOKEN", "sk-ant-api03-" + "x".repeat(40), {
      delivery: "proxy", bindings: [{ host: "api.anthropic.com" }],
    });
    await injectSecrets(A);
    const own = projectSecretView(A).own.find((o) => o.id === s.id)!;
    expect(own.placeholder!.startsWith("sk-ant-api03-sbx")).toBe(true);
    expect(own.bindings!.map((b) => b.host)).toEqual(["api.anthropic.com"]);
    expect(envOf(A)).not.toContain("x".repeat(40));
  });

  test("the view shows no placeholder or bindings for env secrets", async () => {
    const env = createGlobalSecret("PLAIN", "v");
    assignSecrets(A, [env.id]);
    await injectSecrets(A);
    const row = projectSecretView(A).assigned[0];
    expect(row).toEqual({ id: env.id, name: "PLAIN", delivery: "env", status: "injected" });
  });
});

describe("placeholder lifetime", () => {
  const count = (projectId: string) =>
    (db.query("SELECT COUNT(*) AS n FROM secret_placeholders WHERE project_id = ?").get(projectId) as { n: number }).n;

  test("unassigning a secret drops this project's placeholder for it, not others'", async () => {
    const px = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: github });
    assignSecrets(A, [px.id]);
    assignSecrets(B, [px.id]);
    await injectSecrets(A);
    await injectSecrets(B);
    assignSecrets(A, []);
    expect(count(A)).toBe(0);
    expect(count(B)).toBe(1);
  });

  test("destroying a project drops all its placeholders, globals included", async () => {
    const px = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: github });
    createProjectSecret(A, "OWN", GH, { delivery: "proxy", bindings: github });
    assignSecrets(A, [px.id]);
    await injectSecrets(A);
    expect(count(A)).toBe(2);
    purgeProjectSecrets(A);
    expect(count(A)).toBe(0);
    expect(listGlobalSecrets().map((s) => s.id)).toEqual([px.id]); // the global itself stays
  });

  test("deleting a secret drops every project's placeholder for it", async () => {
    const px = createGlobalSecret("GITHUB_TOKEN", GH, { delivery: "proxy", bindings: github });
    assignSecrets(A, [px.id]);
    assignSecrets(B, [px.id]);
    await injectSecrets(A);
    await injectSecrets(B);
    await deleteSecret(px.id);
    expect(count(A) + count(B)).toBe(0);
  });
});
