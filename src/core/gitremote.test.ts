import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { makeProject } from "../../test/helpers";
import { getProject, refFor, setGitRemote } from "./projects";

const WD = process.env.SADBOX_TEST_WORKDIR!;
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", WD, ...args]).stdout.toString().trim();
const stopped = (id: string) => join(process.env.SADBOX_TEST_WORKDIR!, "..", `stopped-${refFor(`proj-${id}`)}`);

beforeEach(() => {
  for (const e of readdirSync(WD)) rmSync(join(WD, e), { recursive: true, force: true });
  Bun.spawnSync(["git", "-C", WD, "init", "-q"]);
});

describe("setGitRemote", () => {
  test("adds origin to a VM created without one, and records it", async () => {
    const id = makeProject("gr1");
    expect(await setGitRemote(id, { remote: "https://github.com/o/r.git" })).toEqual({ git_remote: "https://github.com/o/r.git", has_git_token: false });
    expect(git("remote", "get-url", "origin")).toBe("https://github.com/o/r.git");
    expect(getProject(id)!.git_remote).toBe("https://github.com/o/r.git");
  });

  test("changes an existing origin", async () => {
    const id = makeProject("gr2");
    git("remote", "add", "origin", "https://example.com/old.git");
    await setGitRemote(id, { remote: "https://example.com/new.git" });
    expect(git("remote", "get-url", "origin")).toBe("https://example.com/new.git");
  });

  test("refuses a non-http URL and a stopped VM", async () => {
    const id = makeProject("gr3");
    await expect(setGitRemote(id, { remote: "git@github.com:o/r.git" })).rejects.toThrow(/http\(s\) URL/);
    writeFileSync(stopped(id), "");
    try {
      await expect(setGitRemote(id, { remote: "https://github.com/o/r.git" })).rejects.toThrow(/start the VM first/);
    } finally { rmSync(stopped(id), { force: true }); }
    expect(getProject(id)!.git_remote).toBeNull();
  });
});
