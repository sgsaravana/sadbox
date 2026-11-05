// A git remote's token kept as a proxy vault item (core/gittoken.ts).
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { encrypt } from "../crypto";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { evaluate } from "../net/rules";
import { gitTokenForCreate, gitTokenItem, hasGitToken, migrateGitToken, setProjectGitToken, tokenShape } from "./gittoken";
import { getProject } from "./projects";
import { createItem, getItem, revealItem } from "./vault";

const driver = getDriver();
const withStdin = spyOn(driver, "execWithStdin").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
const exec = spyOn(driver, "exec").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
afterAll(() => { withStdin.mockRestore(); exec.mockRestore(); });

const GH = "https://github.com/o/r.git";
const A = makeProject("gt-a");
const B = makeProject("gt-b");
const hostsOf = (id: string) => getItem(id).bindings.map((b) => b.host).sort();
const accessOf = (id: string) => getItem(id).projectIds;

beforeEach(() => {
  db.run("DELETE FROM secrets");
  db.run("DELETE FROM project_secrets");
  db.run("UPDATE projects SET git_remote = NULL, git_token_enc = NULL");
  exec.mockClear();
});

describe("tokenShape", () => {
  test("GitHub, GitLab, anything else", () => {
    expect(tokenShape(GH)).toEqual({ name: "GITHUB_TOKEN", hosts: ["github.com", "api.github.com", "uploads.github.com"] });
    expect(tokenShape("https://gitlab.com/g/p.git")).toEqual({ name: "GITLAB_TOKEN", hosts: ["gitlab.com"] });
    expect(tokenShape("https://Git.Example.com:8443/x.git")).toEqual({ name: "GIT_TOKEN", hosts: ["git.example.com"] });
  });
});

describe("gitTokenItem", () => {
  test("makes a proxy secret bound to the remote's hosts, with no project access", () => {
    const id = gitTokenItem(GH, "ghp_one");
    expect(getItem(id)).toMatchObject({ name: "GITHUB_TOKEN", kind: "secret", mode: "proxy", projectIds: [] });
    expect(hostsOf(id)).toEqual(["api.github.com", "github.com", "uploads.github.com"]);
    expect(revealItem(id).value).toBe("ghp_one");
  });

  test("reuses an item with the same name and value (adding missing hosts); another value is a new item", () => {
    const own = createItem({ name: "GITHUB_TOKEN", value: "ghp_one", mode: "proxy", bindings: [{ host: "github.com" }] });
    expect(gitTokenItem(GH, "ghp_one")).toBe(own.id);
    expect(hostsOf(own.id)).toEqual(["api.github.com", "github.com", "uploads.github.com"]);
    expect(gitTokenItem(GH, "ghp_two")).not.toBe(own.id);
    // a fetch item is not reused: its value would go into the VM
    const f = createItem({ name: "GIT_TOKEN", value: "t", mode: "fetch" });
    expect(gitTokenItem("https://git.example.com/x.git", "t")).not.toBe(f.id);
  });
});

describe("gitTokenForCreate", () => {
  test("a chosen item of the same name stands in when it holds the token, else refused", () => {
    const chosen = createItem({ name: "GITHUB_TOKEN", value: "ghp_one", mode: "proxy", bindings: [{ host: "github.com" }] });
    expect(gitTokenForCreate(GH, "ghp_one", [chosen.id])).toBe(chosen.id);
    expect(() => gitTokenForCreate(GH, "ghp_two", [chosen.id])).toThrow(/also given vault item GITHUB_TOKEN/);
    expect(gitTokenForCreate(GH, "ghp_two", [])).not.toBe(chosen.id);
  });
});

describe("setProjectGitToken", () => {
  test("gives the project the item; the proxy then allows the remote's hosts", async () => {
    const id = await setProjectGitToken(A, GH, "ghp_one");
    expect(accessOf(id)).toEqual([A]);
    expect(evaluate(A, { host: "github.com", path: "/o/r.git/info/refs", method: "GET" }).decision).toBe("allow");
    expect(evaluate(B, { host: "github.com", path: "/", method: "GET" }).decision).toBe("ask");
    db.query("UPDATE projects SET git_remote = ? WHERE id = ?").run(GH, A);
    expect(hasGitToken(getProject(A)!)).toBe(true);
    expect(hasGitToken(getProject(B)!)).toBe(false);
  });

  test("a new token updates the project's own item in place", async () => {
    const id = await setProjectGitToken(A, GH, "ghp_one");
    expect(await setProjectGitToken(A, GH, "ghp_two")).toBe(id);
    expect(revealItem(id).value).toBe("ghp_two");
  });

  test("an item shared with another project is left to it: this project moves to a new one", async () => {
    const shared = await setProjectGitToken(A, GH, "ghp_one");
    await setProjectGitToken(B, GH, "ghp_one");
    expect(accessOf(shared)).toEqual([A, B].sort());
    const mine = await setProjectGitToken(A, GH, "ghp_two");
    expect(mine).not.toBe(shared);
    expect(accessOf(shared)).toEqual([B]);
    expect(revealItem(shared).value).toBe("ghp_one");
    expect(accessOf(mine)).toEqual([A]);
  });
});

describe("migrateGitToken", () => {
  const legacy = (id: string) => {
    db.query("UPDATE projects SET git_remote = ?, git_token_enc = ? WHERE id = ?").run(GH, encrypt("ghp_old"), id);
    return getProject(id)!;
  };

  test("a fresh VM: the token goes to the vault and the column is cleared, nothing run in the VM", async () => {
    await migrateGitToken(legacy(A), { fresh: true });
    expect(getProject(A)!.git_token_enc).toBeNull();
    const { secret_id } = db.query<{ secret_id: string }, [string]>("SELECT secret_id FROM project_secrets WHERE project_id = ?").get(A)!;
    const item = getItem(secret_id);
    expect(item).toMatchObject({ name: "GITHUB_TOKEN", mode: "proxy" });
    expect(revealItem(item.id).value).toBe("ghp_old");
    expect(exec).not.toHaveBeenCalled();
  });

  test("a running VM: its ~/.git-credentials is removed, then the column cleared", async () => {
    await migrateGitToken(legacy(A));
    const script = String(exec.mock.calls[0][1].at(-1));
    expect(script).toContain("rm -f ~/.git-credentials");
    expect(script).toContain("credential.https://github.com.username");
    expect(getProject(A)!.git_token_enc).toBeNull();
  });

  test("a failed cleanup keeps the column, so the next start tries again", async () => {
    exec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(migrateGitToken(legacy(A))).rejects.toThrow(/git-credentials/);
    expect(getProject(A)!.git_token_enc).not.toBeNull();
    expect(hasGitToken(getProject(A)!)).toBe(true);
  });
});
