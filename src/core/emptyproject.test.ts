// An empty project: no folder, no git remote — repositories are cloned into
// its workdir from the terminal, signed in by the vault (git credential helper).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { ServerResponse } from "node:http";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { gitCredentialFor } from "../net/credentials";
import { serveVault } from "../net/vaultfetch";
import { fileIndex } from "./files";
import { connectSyncFolder, createProject, getProject, rebuildProject, setGitRemote } from "./projects";
import { placeholderFor } from "./placeholders";
import { addBinding, createItem } from "./vault";

const WD = process.env.SADBOX_TEST_WORKDIR!;
const empty = (id: string) => {
  makeProject(id);
  db.query("UPDATE projects SET empty = 1 WHERE id = ?").run(id);
  return id;
};
const sh = (cwd: string, cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd });

beforeEach(() => {
  for (const e of readdirSync(WD)) rmSync(join(WD, e), { recursive: true, force: true });
});

describe("create", () => {
  test("an empty project takes no folder and no remote", async () => {
    await expect(createProject({ name: "e-bad", empty: true, sourcePath: WD })).rejects.toThrow(/clone repositories from its terminal/);
    await expect(createProject({ name: "e-bad", empty: true, git: { remote: "https://github.com/o/r.git" } })).rejects.toThrow(/no local folder or git remote/);
    expect(db.query("SELECT 1 FROM projects WHERE name = 'e-bad'").get()).toBeNull();
  });

  test("without empty, one of the two is still needed", async () => {
    await expect(createProject({ name: "e-none" })).rejects.toThrow(/local folder or a git repository URL/);
  });
});

describe("what an empty project refuses", () => {
  test("a git remote of its own, and a folder to sync into", async () => {
    const id = empty("e-ref");
    await expect(setGitRemote(id, { remote: "https://github.com/o/r.git" })).rejects.toThrow(/not a repository/);
    await expect(connectSyncFolder(id, WD)).rejects.toThrow(/no repository of its own/);
    expect(getProject(id)).toMatchObject({ git_remote: null, sync_path: null });
  });

  test("a Rebuild does not ask for a source", async () => {
    const id = empty("e-reb");
    // gets past the source check (and fails later, in the stubbed VM create — not on "no source")
    const err = await rebuildProject(id).catch((e) => String(e));
    expect(err).not.toMatch(/no source to rebuild from/);
  });
});

describe("git signs in with the vault", () => {
  const P = empty("e-git");
  const Q = makeProject("e-other");
  const item = (name: string, hosts: { host: string; path?: string; header?: string; method?: string; expiresAt?: string }[], projectIds = [P], extra = {}) => {
    const value = `ghp_${name}${"x".repeat(36)}`;
    const it = createItem({ name, value, mode: "proxy", projectIds, bindings: hosts, ...extra });
    for (const pid of projectIds) placeholderFor(pid, it.id, value); // what an injection would make
    return it;
  };
  beforeEach(() => { db.run("DELETE FROM secret_bindings"); db.run("DELETE FROM secret_placeholders"); db.run("DELETE FROM project_secrets"); db.run("DELETE FROM secrets"); });

  test("the closest binding wins, and only what git could send", async () => {
    item("WILD", [{ host: "*.github.com" }]);
    item("PATHED", [{ host: "github.com", path: "/repos/*" }]);
    item("HEADER", [{ host: "github.com", header: "x-api-key" }]);
    item("METHOD", [{ host: "github.com", method: "GET" }]);
    item("OLD", [{ host: "github.com", expiresAt: new Date(Date.now() - 1000).toISOString() }]);
    expect(gitCredentialFor(P, "github.com")?.name).toBe("PATHED");
    item("EXACT", [{ host: "github.com", header: "authorization" }]);
    expect(gitCredentialFor(P, "github.com")?.name).toBe("EXACT");
    expect(gitCredentialFor(P, "api.github.com")?.name).toBe("WILD");
    expect(gitCredentialFor(P, "gitlab.com")).toBeNull();
  });

  test("not another project's item, not a fetch item", async () => {
    item("THEIRS", [{ host: "github.com" }], [Q]);
    item("FETCHED", [{ host: "github.com" }], [P], { mode: "fetch" });
    expect(gitCredentialFor(P, "github.com")).toBeNull();
  });

  test("the proxy hands git the placeholder — never the value — and nobody is asked", async () => {
    const it = item("GITHUB_TOKEN", [{ host: "github.com" }]);
    const ph = db.query<{ placeholder: string }, [string, string]>(
      "SELECT placeholder FROM secret_placeholders WHERE project_id = ? AND secret_id = ?").get(P, it.id)!.placeholder;
    const ask = async (path: string) => {
      let status = 0, text = "";
      const res = { writeHead(s: number) { status = s; }, end(b: Buffer) { text = b.toString(); } } as unknown as ServerResponse;
      await serveVault(P, "http", "GET", path, res);
      return { status, text };
    };
    expect(await ask("/git/credential?host=github.com")).toEqual({ status: 200, text: `username=x-access-token\npassword=${ph}\n` });
    expect(ph).not.toContain("xxxx");
    expect((await ask("/git/credential?host=gitlab.com")).status).toBe(404);
    expect((await ask("/git/credential?host=a%20b")).status).toBe(400);
    expect((await ask("/git/credential")).status).toBe(400);
    addBinding(it.id, { host: "gitlab.com" });
    expect((await ask("/git/credential?host=gitlab.com:443")).status).toBe(200);
  });
});

describe("the editor's quick-open in a workdir that holds repositories", () => {
  const P = empty("e-files");
  test("each repository's files as git sees them, the rest as they are", async () => {
    mkdirSync(join(WD, "app/src"), { recursive: true });
    writeFileSync(join(WD, "app/src/main.ts"), "x");
    writeFileSync(join(WD, "app/.gitignore"), "dist/\n");
    mkdirSync(join(WD, "app/dist"));
    writeFileSync(join(WD, "app/dist/out.js"), "x");
    sh(join(WD, "app"), "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm i");
    mkdirSync(join(WD, "libs/core"), { recursive: true });
    writeFileSync(join(WD, "libs/core/lib.py"), "x");
    sh(join(WD, "libs/core"), "git init -q");
    writeFileSync(join(WD, "notes.md"), "x");
    mkdirSync(join(WD, "node_modules/x"), { recursive: true });
    writeFileSync(join(WD, "node_modules/x/i.js"), "x");
    const { files } = await fileIndex(P);
    expect(files.sort()).toEqual(["app/.gitignore", "app/src/main.ts", "libs/core/lib.py", "notes.md"]);
  });

  test("a workdir that is a repository is listed as before", async () => {
    writeFileSync(join(WD, "a.txt"), "x");
    writeFileSync(join(WD, ".gitignore"), "b.txt\n");
    writeFileSync(join(WD, "b.txt"), "x");
    sh(WD, "git init -q");
    expect((await fileIndex(P)).files.sort()).toEqual([".gitignore", "a.txt"]);
  });
});
