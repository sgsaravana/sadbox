import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db, migrateToVault } from "../db";
import { encrypt } from "../crypto";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { existingPlaceholder, makePlaceholder, placeholderFor, prefixOf } from "./placeholders";
import {
  addBinding, createItem, deleteBinding, deleteItem, getItem, injectVault, listBindings, listItems,
  projectVaultView, purgeProjectVault, revealItem, setItemProjects, setProjectItems, updateItem,
} from "./vault";

const A = makeProject("vault-a");
const B = makeProject("vault-b");
const OFF = makeProject("vault-off", "stopped");
const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const github = [{ host: "api.github.com" }, { host: "github.com" }];

// capture what injectVault writes into the VM instead of running it there
const written = new Map<string, string>();
const exec = spyOn(getDriver(), "execWithStdin").mockImplementation(async (ref, _cmd, stdin) => {
  written.set(ref, new TextDecoder().decode(stdin as Uint8Array));
  return { exitCode: 0, stdout: "", stderr: "" };
});
afterAll(() => exec.mockRestore());
const envOf = (id: string) => written.get(`sadbox-proj-${id}`) ?? "";
const events = (type: string) => db.query<{ detail: string }, [string]>(
  "SELECT detail FROM events WHERE type = ? ORDER BY rowid").all(type).map((r) => r.detail);

beforeEach(() => {
  db.run("DELETE FROM secrets");
  db.run("DELETE FROM secret_placeholders");
  db.run("DELETE FROM project_secrets");
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

  test("one per (project, item): stable for a project, different across projects", () => {
    const s = createItem({ name: "GITHUB_TOKEN", value: GH, mode: "proxy", bindings: github });
    const a1 = placeholderFor(A, s.id, GH), a2 = placeholderFor(A, s.id, GH), b1 = placeholderFor(B, s.id, GH);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });
});

describe("creating items", () => {
  test("defaults: a string secret, fetched at runtime, not in the env file, asking first", () => {
    const s = createItem({ name: "DB_PASSWORD", value: "pw" });
    expect(s).toMatchObject({ kind: "secret", type: "string", mode: "fetch", inEnv: false, askOnFetch: true, bindings: [], projectIds: [] });
    expect(s).not.toHaveProperty("value");
  });

  test("a variable shows its value and does not ask by default", () => {
    const v = createItem({ name: "REGION", value: "eu-west-1", kind: "variable" });
    expect(v).toMatchObject({ kind: "variable", value: "eu-west-1", askOnFetch: false });
    expect(listItems().find((x) => x.id === v.id)).toHaveProperty("value", "eu-west-1");
  });

  test("values are checked against their type", () => {
    expect(createItem({ name: "N", value: " 42 ", type: "number" }).type).toBe("number");
    expect(revealItem(listItems()[0].id).value).toBe("42");
    expect(() => createItem({ name: "N2", value: "4x", type: "number" })).toThrow(/not a number/);
    expect(() => createItem({ name: "N3", value: "Infinity", type: "number" })).toThrow(/not a number/);
    expect(createItem({ name: "CFG", value: '{"a":[1,2]}', type: "json" }).type).toBe("json");
    expect(() => createItem({ name: "CFG2", value: "{a:1}", type: "json" })).toThrow(/not valid JSON/);
    expect(() => createItem({ name: "T", value: "x", type: "yaml" as any })).toThrow(/type must be/);
  });

  test("names are env-var style; kind and mode are checked; only a fetch item can also go in the env", () => {
    expect(() => createItem({ name: "lower", value: "x" })).toThrow(/env-var style/);
    expect(() => createItem({ name: "K", value: "x", kind: "other" as any })).toThrow(/kind must be/);
    expect(() => createItem({ name: "M", value: "x", mode: "env" as any })).toThrow(/mode must be/);
    expect(() => createItem({ name: "P", value: GH, mode: "proxy", bindings: github, inEnv: true })).toThrow(/only a fetch item/);
  });

  test("a proxy item stores its hosts, normalized, and needs at least one", () => {
    const s = createItem({ name: "GITHUB_TOKEN", value: GH, mode: "proxy", bindings: [{ host: "API.GitHub.com", method: "post", header: "Authorization" }] });
    expect(s.bindings[0]).toMatchObject({ host: "api.github.com", method: "POST", header: "authorization" });
    expect(() => createItem({ name: "X", value: GH, mode: "proxy" })).toThrow(/at least one host/);
  });

  test("hosts that would send a value anywhere, or are malformed, are refused — and nothing is kept", () => {
    for (const host of ["*", "*.com", "a*.github.com"]) {
      expect(() => createItem({ name: "X", value: GH, mode: "proxy", bindings: [{ host }] })).toThrow();
    }
    expect(() => createItem({ name: "X", value: GH, mode: "proxy", bindings: [{ host: "ok.com" }, { host: "x.com", path: "no-slash" }] })).toThrow(/bad path/);
    expect(listItems()).toEqual([]);
  });

  test("given projects get access; a project can't have two items of one name, two projects can", () => {
    const a = createItem({ name: "GITHUB_TOKEN", value: "work", projectIds: [A] });
    expect(a.projectIds).toEqual([A]);
    expect(() => createItem({ name: "GITHUB_TOKEN", value: "x", projectIds: [B, A] })).toThrow(/already has a vault item named GITHUB_TOKEN/);
    expect(createItem({ name: "GITHUB_TOKEN", value: "personal", projectIds: [B] }).projectIds).toEqual([B]);
    expect(() => createItem({ name: "Y", value: "x", projectIds: ["nope"] })).toThrow(/project not found/);
  });
});

describe("revealing", () => {
  test("returns a secret's value and logs that it was looked at, by name", () => {
    const s = createItem({ name: "API_KEY", value: "hush" });
    expect(getItem(s.id)).not.toHaveProperty("value");
    expect(revealItem(s.id)).toEqual({ value: "hush" });
    expect(events("vault.reveal").at(-1)).toBe("API_KEY");
    expect(() => revealItem("nope")).toThrow(/not found/);
  });
});

describe("the env file", () => {
  test("a proxy item is its placeholder, a fetch item marked inEnv is its value, any other fetch item is absent", async () => {
    createItem({ name: "GITHUB_TOKEN", value: GH, mode: "proxy", bindings: github, projectIds: [A] });
    createItem({ name: "OLD_STYLE", value: "plain-value", inEnv: true, projectIds: [A] });
    createItem({ name: "DB_PASSWORD", value: "never-in-env", projectIds: [A] });
    createItem({ name: "NOT_MINE", value: "b-only", inEnv: true, projectIds: [B] });
    await injectVault(A);
    const env = envOf(A);
    expect(env).toMatch(/^GITHUB_TOKEN='ghp_sbx[A-Za-z0-9]+'$/m);
    expect(env).toContain("OLD_STYLE='plain-value'");
    expect(env).not.toContain(GH);
    expect(env).not.toContain("DB_PASSWORD");
    expect(env).not.toContain("NOT_MINE");
  });

  test("the project's view shows the placeholder its VM holds, only for proxy items", async () => {
    createItem({ name: "GITHUB_TOKEN", value: GH, mode: "proxy", bindings: github, projectIds: [A] });
    createItem({ name: "OTHER", value: "x", projectIds: [A] });
    await injectVault(A);
    const v = projectVaultView(A);
    expect(v.find((x) => x.name === "GITHUB_TOKEN")!.placeholder).toMatch(/^ghp_sbx/);
    expect(v.find((x) => x.name === "OTHER")).not.toHaveProperty("placeholder");
  });
});

describe("changing items", () => {
  test("a new value reaches the running projects that use it, not stopped ones", async () => {
    const s = createItem({ name: "TOKEN", value: "one", inEnv: true, projectIds: [A, OFF] });
    await updateItem(s.id, { value: "two" });
    expect(envOf(A)).toContain("TOKEN='two'");
    expect(written.has("sadbox-proj-vault-off")).toBe(false);
    expect(revealItem(s.id).value).toBe("two");
  });

  test("a new type is checked against the value; a rename may not clash in any project", async () => {
    const s = createItem({ name: "LIMIT", value: "50", projectIds: [A] });
    expect((await updateItem(s.id, { type: "number" })).type).toBe("number");
    await expect(updateItem(s.id, { value: "lots" })).rejects.toThrow(/not a number/);
    createItem({ name: "TAKEN", value: "x", projectIds: [A] });
    await expect(updateItem(s.id, { name: "TAKEN" })).rejects.toThrow(/already has a vault item named TAKEN/);
  });

  test("switching to proxy needs a host first; hosts can be added to any item", async () => {
    const s = createItem({ name: "TOKEN", value: GH, inEnv: true, projectIds: [A] });
    await expect(updateItem(s.id, { mode: "proxy" })).rejects.toThrow(/add one first/);
    addBinding(s.id, { host: "api.github.com" });
    const p = await updateItem(s.id, { mode: "proxy" });
    expect(p).toMatchObject({ mode: "proxy", inEnv: false }); // leaving fetch drops the env copy
    expect(envOf(A)).toMatch(/^TOKEN='ghp_sbx/m);
  });

  test("a value of another shape gets new placeholders; one of the same shape keeps them", async () => {
    const s = createItem({ name: "TOKEN", value: GH, mode: "proxy", bindings: github, projectIds: [A] });
    await injectVault(A);
    const first = existingPlaceholder(A, s.id)!;
    await updateItem(s.id, { value: "ghp_" + "Z".repeat(36) });
    expect(existingPlaceholder(A, s.id)).toBe(first);
    await updateItem(s.id, { value: "github_pat_" + "Z".repeat(40) });
    expect(existingPlaceholder(A, s.id)).toMatch(/^github_pat_sbx/);
  });
});

describe("access", () => {
  test("from the item: losing access drops that project's placeholder and rewrites its env", async () => {
    const s = createItem({ name: "TOKEN", value: GH, mode: "proxy", bindings: github, projectIds: [A, B] });
    await injectVault(A); await injectVault(B);
    await setItemProjects(s.id, [B]);
    expect(existingPlaceholder(A, s.id)).toBeNull();
    expect(existingPlaceholder(B, s.id)).not.toBeNull();
    expect(envOf(A)).not.toContain("TOKEN");
    expect(getItem(s.id).projectIds).toEqual([B]);
  });

  test("from the project: exactly the items given, and never two of one name", () => {
    const one = createItem({ name: "SAME", value: "1" });
    const two = createItem({ name: "SAME", value: "2" });
    const other = createItem({ name: "OTHER", value: "3" });
    setProjectItems(A, [one.id, other.id]);
    expect(projectVaultView(A).map((x) => x.id).sort()).toEqual([one.id, other.id].sort());
    expect(() => setProjectItems(A, [one.id, two.id])).toThrow(/two vault items are named SAME/);
    expect(() => setProjectItems(A, ["nope"])).toThrow(/not found/);
  });
});

describe("bindings", () => {
  test("added to and removed from an item", () => {
    const s = createItem({ name: "TOKEN", value: GH, mode: "proxy", bindings: [{ host: "api.github.com" }] });
    const b = addBinding(s.id, { host: "uploads.github.com", path: "/repos/*" });
    expect(listBindings(s.id).map((x) => x.host)).toEqual(["api.github.com", "uploads.github.com"]);
    deleteBinding(s.id, b.id);
    expect(listBindings(s.id).length).toBe(1);
    expect(() => deleteBinding(s.id, b.id)).toThrow(/not found/);
    expect(() => addBinding("nope", { host: "x.com" })).toThrow(/not found/);
  });
});

describe("deleting and purging", () => {
  test("deleting an item takes its hosts, access and placeholders with it, and rewrites the env files", async () => {
    const s = createItem({ name: "TOKEN", value: GH, mode: "proxy", bindings: github, projectIds: [A] });
    await injectVault(A);
    await deleteItem(s.id);
    expect(listItems()).toEqual([]);
    expect(listBindings(s.id)).toEqual([]);
    expect(existingPlaceholder(A, s.id)).toBeNull();
    expect(projectVaultView(A)).toEqual([]);
    expect(envOf(A)).not.toContain("TOKEN");
  });

  test("destroying a project removes its access and placeholders; the items stay", async () => {
    const s = createItem({ name: "TOKEN", value: GH, mode: "proxy", bindings: github, projectIds: [A, B] });
    await injectVault(A); await injectVault(B);
    purgeProjectVault(A);
    expect(getItem(s.id).projectIds).toEqual([B]);
    expect(existingPlaceholder(A, s.id)).toBeNull();
    expect(existingPlaceholder(B, s.id)).not.toBeNull();
  });
});

describe("migrating secrets to the vault", () => {
  const legacy = (id: string, name: string, delivery: string, projectId: string | null) =>
    db.query("INSERT INTO secrets (id, project_id, name, value_enc, delivery, ask_on_fetch) VALUES (?, ?, ?, ?, ?, 1)")
      .run(id, projectId, name, encrypt(`v-${id}`), delivery);

  test("env secrets keep working (fetch + env file, no asking); project-specific ones become access; own wins over a global", async () => {
    legacy("g-env", "SHARED", "env", null);
    legacy("g-proxy", "GITHUB_TOKEN", "proxy", null);
    legacy("own-a", "SHARED", "env", A); // A's own SHARED overrode the global one
    db.query("INSERT INTO project_secrets (project_id, secret_id) VALUES (?, ?), (?, ?), (?, ?)")
      .run(A, "g-env", A, "g-proxy", B, "g-env");

    migrateToVault();
    migrateToVault(); // idempotent

    const byId = Object.fromEntries(listItems().map((x) => [x.id, x]));
    expect(byId["g-env"]).toMatchObject({ mode: "fetch", inEnv: true, askOnFetch: false, projectIds: [B] });
    expect(byId["own-a"]).toMatchObject({ mode: "fetch", inEnv: true, projectIds: [A] });
    expect(byId["g-proxy"]).toMatchObject({ mode: "proxy", projectIds: [A] });
    expect(db.query("SELECT COUNT(*) AS n FROM secrets WHERE project_id IS NOT NULL").get()).toEqual({ n: 0 });

    await injectVault(A);
    expect(envOf(A)).toContain("SHARED='v-own-a'");
    await injectVault(B);
    expect(envOf(B)).toContain("SHARED='v-g-env'");
  });
});
