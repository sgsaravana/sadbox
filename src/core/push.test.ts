import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { pushProject } from "./push";

// the stub VM's workdir is this scratch dir (test/setup.ts)
const WD = process.env.SADBOX_TEST_WORKDIR!;
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const run = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd }).stdout.toString().trim();
let folder = "";
let n = 0;

/** A project whose local folder is a fresh git repository. */
function project(): string {
  const id = makeProject(`push${++n}`);
  db.query("UPDATE projects SET source_path = ? WHERE id = ?").run(folder, id);
  return id;
}

beforeEach(() => {
  for (const e of readdirSync(WD)) rmSync(join(WD, e), { recursive: true, force: true });
  run(WD, "git", "init", "-q");
  run(WD, "git", "config", "user.email", "t@t"); run(WD, "git", "config", "user.name", "t");
  folder = mkdtempSync(join(tmpdir(), "sadbox-push-"));
  run(folder, "git", "init", "-q");
});

describe("pushProject", () => {
  test("copies new and changed files into the VM, never env files, and leaves unchanged ones alone", async () => {
    const id = project();
    put(folder, "same.txt", "same\n"); put(WD, "same.txt", "same\n");
    run(WD, "git", "add", "-A"); run(WD, "git", "commit", "-qm", "base");
    const before = statSync(join(WD, "same.txt")).mtimeMs;
    put(folder, "src/new.ts", "export {}\n");
    put(folder, ".env", "SECRET=1\n"); put(folder, ".env.local", "SECRET=2\n");
    put(folder, "apps/api/.env.production", "SECRET=3\n");
    put(folder, ".gitignore", "ignored.log\n"); put(folder, "ignored.log", "x\n");

    const r = await pushProject(id);
    expect(r.applied).toBe("copied");
    expect(r.changed.sort()).toEqual([".gitignore", "src/new.ts"]);
    expect(r.excluded.sort()).toEqual([".env", ".env.local", "apps/api/.env.production"]);
    expect(readFileSync(join(WD, "src/new.ts"), "utf8")).toBe("export {}\n");
    for (const f of [".env", ".env.local", "apps/api/.env.production", "ignored.log"]) expect(existsSync(join(WD, f))).toBe(false);
    expect(statSync(join(WD, "same.txt")).mtimeMs).toBe(before);

    expect((await pushProject(id)).applied).toBe("current");
  });

  test("does not overwrite uncommitted work in the VM unless forced", async () => {
    const id = project();
    put(WD, "a.txt", "base\n"); run(WD, "git", "add", "-A"); run(WD, "git", "commit", "-qm", "base");
    put(WD, "a.txt", "agent's edit\n");
    put(folder, "a.txt", "mine\n"); put(folder, "b.txt", "new\n");

    const r = await pushProject(id);
    expect(r.applied).toBe("not-applied");
    expect(r.blocking).toEqual(["a.txt"]);
    expect(readFileSync(join(WD, "a.txt"), "utf8")).toBe("agent's edit\n");
    expect(existsSync(join(WD, "b.txt"))).toBe(false);

    const f = await pushProject(id, { force: true });
    expect(f).toMatchObject({ applied: "copied", forced: true });
    expect(readFileSync(join(WD, "a.txt"), "utf8")).toBe("mine\n");
  });

  test("a committed file in the VM is overwritten; a plain folder works too", async () => {
    rmSync(join(folder, ".git"), { recursive: true, force: true });
    const id = project();
    put(WD, "a.txt", "base\n"); run(WD, "git", "add", "-A"); run(WD, "git", "commit", "-qm", "base");
    put(folder, "a.txt", "newer\n"); put(folder, "deep/.env", "S=1\n");
    const r = await pushProject(id);
    expect(r).toMatchObject({ applied: "copied", changed: ["a.txt"], excluded: ["deep/.env"] });
    expect(readFileSync(join(WD, "a.txt"), "utf8")).toBe("newer\n");
  });
});
