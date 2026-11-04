import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { isEnvFile } from "./envfiles";
import { markEnvFilesSkipped, tarSource } from "./projects";

const WD = process.env.SADBOX_TEST_WORKDIR!; // the stub VM's workdir (test/setup.ts)
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const run = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd }).stdout.toString().trim();

describe("isEnvFile", () => {
  test("matches .env and .env.* at any depth, and anything under a .env directory", () => {
    for (const p of [".env", ".env.local", ".env.production", "apps/web/.env", "apps/web/.env.dev", ".env/bin/python"]) expect(isEnvFile(p)).toBe(true);
    for (const p of ["env", "a.env", ".envrc", "src/environment.ts", "docs/.environment"]) expect(isEnvFile(p)).toBe(false);
  });
});

describe("copying a folder in on create / rebuild", () => {
  test("leaves out env files, tracked or not, and reports the tracked ones", async () => {
    const src = mkdtempSync(join(tmpdir(), "sadbox-src-"));
    run(src, "git", "init", "-q");
    put(src, "app.ts", "1\n"); put(src, ".env", "S=1\n"); put(src, "api/.env.production", "S=2\n");
    run(src, "git", "add", "-A"); run(src, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    put(src, ".env.local", "S=3\n"); // untracked, not ignored

    const { bytes, trackedEnv } = await tarSource(src);
    expect(trackedEnv.sort()).toEqual([".env", "api/.env.production"]);
    const out = mkdtempSync(join(tmpdir(), "sadbox-out-"));
    Bun.spawnSync(["tar", "-xf", "-", "-C", out], { stdin: bytes });
    expect(existsSync(join(out, "app.ts"))).toBe(true);
    expect(existsSync(join(out, ".git"))).toBe(true);
    for (const f of [".env", ".env.local", "api/.env.production"]) expect(existsSync(join(out, f))).toBe(false);
    rmSync(src, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
  });

  test("tracked env files missing from the VM's copy do not read as deleted there", async () => {
    for (const e of readdirSync(WD)) rmSync(join(WD, e), { recursive: true, force: true });
    run(WD, "git", "init", "-q");
    put(WD, ".env", "S=1\n"); put(WD, "a.ts", "1\n");
    run(WD, "git", "add", "-A"); run(WD, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    rmSync(join(WD, ".env"));
    expect(run(WD, "git", "status", "--porcelain")).toBe("D .env");
    await markEnvFilesSkipped("sadbox-envtest", [".env"]);
    expect(run(WD, "git", "status", "--porcelain")).toBe("");
  });
});
