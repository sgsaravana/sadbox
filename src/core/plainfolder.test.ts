// A local folder need not be a git repository. Its files are copied into the
// VM, which makes its own first commit there, so the workdir is still a
// repository on the project's branch (and Sync back has a base to start from).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { db } from "../db";
import { commitPlainFolder, createProject } from "./projects";

const WD = process.env.SADBOX_TEST_WORKDIR!;
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

beforeEach(() => {
  for (const e of readdirSync(WD)) rmSync(join(WD, e), { recursive: true, force: true });
});

afterAll(() => {
  const rows = db.query<{ id: string }, [string]>("SELECT id FROM projects WHERE name = ?").all("plain-create");
  for (const { id } of rows) {
    db.query("DELETE FROM events WHERE project_id = ?").run(id);
    db.query("DELETE FROM projects WHERE id = ?").run(id);
  }
});

describe("a plain folder in the VM", () => {
  test("gets a first commit and the project's branch", async () => {
    put(WD, "app.ts", "1\n");
    put(WD, ".gitignore", "dist/\n");
    put(WD, "dist/out.js", "x\n");

    const seeded = await commitPlainFolder("sadbox-plainseed", "plainseed");
    expect(seeded.base).toMatch(/^[0-9a-f]{40,64}$/);
    expect(seeded.branch).not.toBe("");
    expect(git(WD, "rev-parse", "HEAD")).toBe(seeded.base);
    expect(git(WD, "rev-parse", "--abbrev-ref", "HEAD")).toBe("sadbox/plainseed");
    expect(git(WD, "status", "--porcelain")).toBe("");
    expect(git(WD, "ls-files").split("\n").sort()).toEqual([".gitignore", "app.ts"]);
  });

  test("an empty folder still becomes a repository with one commit", async () => {
    const seeded = await commitPlainFolder("sadbox-plainempty", "plainempty");
    expect(git(WD, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(WD, "rev-parse", "--abbrev-ref", "HEAD")).toBe("sadbox/plainempty");
    expect(git(WD, "status", "--porcelain")).toBe("");
    expect(seeded.base).toMatch(/^[0-9a-f]{40,64}$/);
  });
});

describe("create", () => {
  test("accepts a folder that is not a git repository", async () => {
    const src = mkdtempSync(join(tmpdir(), "sadbox-plainsrc-"));
    put(src, "main.py", "print('hi')\n");
    // The stub VM cannot boot, so provisioning fails there — past the old
    // "source folder must be a git repository with at least one commit" gate.
    const err = await createProject({ name: "plain-create", sourcePath: src }).catch((e) => String(e));
    expect(err).not.toMatch(/at least one commit|must be a git repository/);
    expect(err).toMatch(/volume create failed|container run failed/);
    rmSync(src, { recursive: true, force: true });
  });
});
