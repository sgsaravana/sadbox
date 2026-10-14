import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { makeProject } from "../../test/helpers";
import {
  FileError, MAX_FILE_BYTES, cleanPath, commitStaged, discardPaths, listStashes, stash, deletePath, fileIndex, gitStatus, headFile, lastCommit, listBranches, listDir, makeDir, pushBranch, readFile, renamePath, sha256, stageFile, stagePaths, switchBranch, writeFile,
} from "./files";
import { getProject } from "./projects";

// The preload's stub `container exec` runs the guest snippets on this machine,
// with the guest workdir mapped to this scratch dir.
const WD = process.env.SADBOX_TEST_WORKDIR!;
const P = makeProject("files-a");
const put = (rel: string, data: string | Uint8Array) => {
  mkdirSync(join(WD, rel, ".."), { recursive: true });
  writeFileSync(join(WD, rel), data);
};
const get = (rel: string) => readFileSync(join(WD, rel), "utf8");

beforeEach(() => {
  for (const e of readdirSync(WD)) rmSync(join(WD, e), { recursive: true, force: true });
});

async function failure(p: Promise<unknown>): Promise<FileError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(FileError); return e as FileError; }
  throw new Error("expected the call to fail");
}

describe("cleanPath", () => {
  test("normalizes to a workdir-relative path", () => {
    expect(cleanPath("src/a.ts")).toBe("src/a.ts");
    expect(cleanPath("/src//a.ts/")).toBe("src/a.ts");
    expect(cleanPath("./src/../lib/x")).toBe("lib/x");
    expect(cleanPath("")).toBe("");
    expect(cleanPath("/")).toBe("");
  });

  test("never yields a path outside the workdir", () => {
    for (const p of ["..", "../etc/passwd", "a/../../b", "/../x", "..\\..\\x", "a/b/../../../c"]) {
      expect(cleanPath(p)).not.toMatch(/^\.\.(\/|$)/);
    }
    expect(cleanPath("../etc/passwd")).toBe("etc/passwd"); // clamped at the workdir root
  });

  test("rejects non-strings and NUL bytes", () => {
    expect(() => cleanPath(undefined)).toThrow(/path is required/);
    expect(() => cleanPath(42)).toThrow(/path is required/);
    expect(() => cleanPath("a\0b")).toThrow(/invalid path/);
  });
});

describe("listDir", () => {
  test("lists folders first, then files, including dotfiles", async () => {
    put("b.txt", "b"); put("a.txt", "a"); put(".env", "x"); put("src/main.ts", ""); put("docs/readme.md", "");
    const r = await listDir(P, "");
    expect(r.entries).toEqual([
      { name: "docs", type: "dir" }, { name: "src", type: "dir" },
      { name: ".env", type: "file" }, { name: "a.txt", type: "file" }, { name: "b.txt", type: "file" },
    ]);
  });

  test("lists a nested folder and an empty one", async () => {
    put("src/deep/x.ts", "");
    mkdirSync(join(WD, "empty"));
    expect((await listDir(P, "src/deep")).entries).toEqual([{ name: "x.ts", type: "file" }]);
    expect((await listDir(P, "empty")).entries).toEqual([]);
  });

  test("handles names with spaces, quotes and shell metacharacters", async () => {
    const names = ["a b.txt", "it's.txt", "$(touch pwned).txt", "semi;colon.txt", "-dash.txt", "star*.txt"];
    for (const n of names) put(n, "");
    const got = (await listDir(P, "")).entries.map((e) => e.name).sort();
    expect(got).toEqual([...names].sort());
    expect(existsSync(join(WD, "pwned"))).toBe(false);
  });

  test("a symlinked folder is a folder; a broken link is 'other'", async () => {
    put("real/x", "");
    symlinkSync("real", join(WD, "link"));
    symlinkSync("missing", join(WD, "broken"));
    const byName = Object.fromEntries((await listDir(P, "")).entries.map((e) => [e.name, e.type]));
    expect(byName).toEqual({ real: "dir", link: "dir", broken: "other" });
  });

  test("404 for a missing folder or a file; 404 for an unknown project", async () => {
    put("f.txt", "");
    expect((await failure(listDir(P, "nope"))).status).toBe(404);
    expect((await failure(listDir(P, "f.txt"))).status).toBe(404);
    expect((await failure(listDir("no-such-project", ""))).status).toBe(404);
  });
});

describe("readFile", () => {
  test("returns content with a hash of the exact bytes", async () => {
    put("src/a.ts", "const π = 3.14;\n");
    const r = await readFile(P, "src/a.ts");
    expect(r.content).toBe("const π = 3.14;\n");
    expect(r.hash).toBe(sha256("const π = 3.14;\n"));
    expect(r.size).toBe(Buffer.byteLength("const π = 3.14;\n"));
  });

  test("reads an empty file and odd file names", async () => {
    put("empty", ""); put("my file's $HOME.txt", "ok");
    expect((await readFile(P, "empty")).content).toBe("");
    expect((await readFile(P, "my file's $HOME.txt")).content).toBe("ok");
  });

  test("404 for missing files and folders", async () => {
    mkdirSync(join(WD, "dir"));
    expect((await failure(readFile(P, "nope.txt"))).status).toBe(404);
    expect((await failure(readFile(P, "dir"))).status).toBe(404);
  });

  test("refuses binary and non-UTF-8 files rather than corrupting them on save", async () => {
    put("img.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    put("latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9])); // "café" in ISO-8859-1
    for (const f of ["img.png", "latin1.txt"]) {
      const e = await failure(readFile(P, f));
      expect(e.status).toBe(415);
      expect(e.extra.binary).toBe(true);
    }
  });

  test("refuses files over the size limit", async () => {
    put("big.txt", "x".repeat(MAX_FILE_BYTES + 1));
    put("ok.txt", "x".repeat(MAX_FILE_BYTES));
    expect((await failure(readFile(P, "big.txt"))).status).toBe(413);
    expect((await readFile(P, "ok.txt")).size).toBe(MAX_FILE_BYTES);
  });
});

describe("writeFile", () => {
  test("saves over the version that was opened and returns the new hash", async () => {
    put("a.txt", "one\n");
    const opened = await readFile(P, "a.txt");
    const saved = await writeFile(P, "a.txt", "two\n", { baseHash: opened.hash });
    expect(get("a.txt")).toBe("two\n");
    expect(saved.hash).toBe(sha256("two\n"));
    // the returned hash is good for the next save
    await writeFile(P, "a.txt", "three\n", { baseHash: saved.hash });
    expect(get("a.txt")).toBe("three\n");
  });

  test("refuses to clobber a file that changed in the VM since it was opened", async () => {
    put("a.txt", "one\n");
    const opened = await readFile(P, "a.txt");
    put("a.txt", "the agent rewrote this\n");
    const e = await failure(writeFile(P, "a.txt", "mine\n", { baseHash: opened.hash }));
    expect(e.status).toBe(409);
    expect(e.extra.conflict).toBe(true);
    expect(get("a.txt")).toBe("the agent rewrote this\n");
  });

  test("a conflict also covers the file having been deleted", async () => {
    put("a.txt", "one\n");
    const opened = await readFile(P, "a.txt");
    rmSync(join(WD, "a.txt"));
    expect((await failure(writeFile(P, "a.txt", "mine\n", { baseHash: opened.hash }))).status).toBe(409);
    expect(existsSync(join(WD, "a.txt"))).toBe(false);
  });

  test("force overwrites regardless", async () => {
    put("a.txt", "changed underneath\n");
    await writeFile(P, "a.txt", "mine\n", { baseHash: sha256("stale"), force: true });
    expect(get("a.txt")).toBe("mine\n");
  });

  test("a new file (no baseHash) is created with parent folders, but never over an existing file", async () => {
    await writeFile(P, "new/deep/file.txt", "hi", { baseHash: null });
    expect(get("new/deep/file.txt")).toBe("hi");
    const e = await failure(writeFile(P, "new/deep/file.txt", "again", {}));
    expect(e.status).toBe(409);
    expect(get("new/deep/file.txt")).toBe("hi");
  });

  test("saves an empty file, unicode, and content that looks like shell", async () => {
    put("a.txt", "x");
    const h = (await readFile(P, "a.txt")).hash;
    const emptied = await writeFile(P, "a.txt", "", { baseHash: h });
    expect(get("a.txt")).toBe("");
    const body = "日本語 🚀\n$(rm -rf /) `id` 'quotes' \"dq\" \\n\r\n";
    await writeFile(P, "a.txt", body, { baseHash: emptied.hash });
    expect(get("a.txt")).toBe(body);
  });

  test("keeps the file's mode (an executable script stays executable)", async () => {
    put("run.sh", "#!/bin/sh\n");
    chmodSync(join(WD, "run.sh"), 0o755);
    const h = (await readFile(P, "run.sh")).hash;
    await writeFile(P, "run.sh", "#!/bin/sh\necho hi\n", { baseHash: h });
    expect(statSync(join(WD, "run.sh")).mode & 0o777).toBe(0o755);
  });

  test("rejects bad input: non-string content, a bogus hash, a folder target, oversize", async () => {
    mkdirSync(join(WD, "dir"));
    expect((await failure(writeFile(P, "a.txt", 42 as any, {}))).message).toMatch(/content must be a string/);
    expect((await failure(writeFile(P, "a.txt", "x", { baseHash: "abc; rm -rf ." }))).message).toMatch(/invalid baseHash/);
    expect((await failure(writeFile(P, "dir", "x", { force: true }))).status).toBe(409);
    expect((await failure(writeFile(P, "big", "x".repeat(MAX_FILE_BYTES + 1), {}))).status).toBe(413);
    expect((await failure(writeFile(P, "", "x", {}))).message).toMatch(/path is required/);
  });
});

describe("makeDir, renamePath, deletePath", () => {
  test("makeDir creates nested folders and refuses an existing path", async () => {
    await makeDir(P, "a/b/c");
    expect(statSync(join(WD, "a/b/c")).isDirectory()).toBe(true);
    expect((await failure(makeDir(P, "a/b"))).status).toBe(409);
  });

  test("renamePath moves files and folders, creating the destination's parents", async () => {
    put("old.txt", "x"); put("pkg/mod.ts", "y");
    await renamePath(P, "old.txt", "moved/new name.txt");
    await renamePath(P, "pkg", "lib");
    expect(get("moved/new name.txt")).toBe("x");
    expect(get("lib/mod.ts")).toBe("y");
    expect(existsSync(join(WD, "old.txt"))).toBe(false);
    expect(existsSync(join(WD, "pkg"))).toBe(false);
  });

  test("renamePath refuses to overwrite, to move a missing path, or to move a folder into itself", async () => {
    put("a.txt", "a"); put("b.txt", "b"); put("dir/x", "");
    expect((await failure(renamePath(P, "a.txt", "b.txt"))).status).toBe(409);
    expect(get("b.txt")).toBe("b");
    expect((await failure(renamePath(P, "nope", "c.txt"))).status).toBe(404);
    expect((await failure(renamePath(P, "dir", "dir/sub"))).message).toMatch(/into itself/);
    expect((await failure(renamePath(P, "a.txt", "a.txt"))).message).toMatch(/into itself/);
  });

  test("deletePath removes a file or a whole folder, and only that", async () => {
    put("keep.txt", ""); put("gone.txt", ""); put("tree/a/b.txt", "");
    await deletePath(P, "gone.txt");
    await deletePath(P, "tree");
    expect(readdirSync(WD)).toEqual(["keep.txt"]);
  });

  test("deletePath never deletes the workdir itself, and 404s on a missing path", async () => {
    put("keep.txt", "");
    for (const root of ["", "/", ".", "a/.."]) {
      expect((await failure(deletePath(P, root))).message).toMatch(/workdir itself/);
    }
    expect((await failure(deletePath(P, "nope"))).status).toBe(404);
    expect(readdirSync(WD)).toEqual(["keep.txt"]);
  });
});

describe("fileIndex", () => {
  test("lists tracked and untracked files, leaving out ignored ones and .git", async () => {
    Bun.spawnSync(["git", "init", "-q", WD]);
    put(".gitignore", "node_modules/\n*.log\n");
    put("src/a.ts", ""); put("README.md", ""); put("node_modules/x/index.js", ""); put("debug.log", "");
    const r = await fileIndex(P);
    expect(r.files.sort()).toEqual([".gitignore", "README.md", "src/a.ts"]);
    expect(r.truncated).toBe(false);
  });
});

describe("gitStatus", () => {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", WD, ...args]);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };

  test("a workdir that is not a repository has no states", async () => {
    put("a.txt", "x");
    expect(await gitStatus(P)).toMatchObject({ repo: false, files: {}, dirs: {}, staged: {}, branch: null, remote: false });
  });

  test("reports each path against the last commit, staged or not", async () => {
    git("init", "-q");
    put(".gitignore", "node_modules/\n*.log\n");
    put("kept.ts", "1"); put("edited.ts", "1"); put("staged-edit.ts", "1"); put("gone.ts", "1"); put("old name.ts", "same content\n");
    git("add", "-A"); git("commit", "-qm", "base");

    put("edited.ts", "2");                              // changed, not staged
    put("staged-edit.ts", "2"); git("add", "staged-edit.ts"); // changed, staged
    put("added.ts", "new"); git("add", "added.ts");     // new, staged
    put("loose.ts", "new");                             // new, untracked
    put("fresh/deep/x.ts", "new");                      // a whole new folder
    rmSync(join(WD, "gone.ts"));
    git("mv", "old name.ts", "new name.ts");
    put("node_modules/x/index.js", ""); put("debug.log", "");

    const r = await gitStatus(P);
    expect(r.repo).toBe(true);
    expect(r.files).toEqual({
      "edited.ts": "modified", "staged-edit.ts": "modified",
      "added.ts": "new", "loose.ts": "new",
      "gone.ts": "deleted", "new name.ts": "renamed",
      "debug.log": "ignored",
    });
    expect(r.dirs).toEqual({ fresh: "new", node_modules: "ignored" });
  });

  test("a merge conflict is reported as one", async () => {
    git("init", "-q", "-b", "main");
    put("f.txt", "base\n"); git("add", "-A"); git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "other"); put("f.txt", "theirs\n"); git("commit", "-qam", "theirs");
    git("checkout", "-q", "main"); put("f.txt", "ours\n"); git("commit", "-qam", "ours");
    Bun.spawnSync(["git", "-C", WD, "merge", "-q", "other"]); // stops on the conflict
    expect((await gitStatus(P)).files).toEqual({ "f.txt": "conflict" });
  });
});

describe("headFile", () => {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", WD, ...args]);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };

  test("returns the committed version, whatever the file holds now", async () => {
    git("init", "-q");
    put("src/it's a.ts", "one\ntwo\n"); put("bin.dat", new Uint8Array([1, 0, 2]));
    git("add", "-A"); git("commit", "-qm", "base");
    put("src/it's a.ts", "one\nTWO\nthree\n"); git("add", "-A"); // staged or not, HEAD is the measure
    put("fresh.ts", "new\n");

    expect(await headFile(P, "src/it's a.ts")).toMatchObject({
      path: "src/it's a.ts", repo: true, inHead: true, content: "one\ntwo\n", inIndex: true, index: "one\nTWO\nthree\n",
    });
    expect(await headFile(P, "fresh.ts")).toEqual({
      path: "fresh.ts", repo: true, inHead: false, content: null, inIndex: false, indexOid: null, index: null,
    });
    expect(await headFile(P, "bin.dat")).toMatchObject({ repo: true, inHead: true, content: null, inIndex: true, index: null });
    rmSync(join(WD, "src/it's a.ts")); // deleted in the workdir, still committed
    expect((await headFile(P, "src/it's a.ts")).content).toBe("one\ntwo\n");
  });

  test("a workdir without a repository, or without a commit, has nothing to compare with", async () => {
    put("a.txt", "x");
    expect(await headFile(P, "a.txt")).toMatchObject({ repo: false, content: null });
    git("init", "-q");
    expect(await headFile(P, "a.txt")).toMatchObject({ repo: true, inHead: false, content: null });
  });

  test("the path cannot leave the workdir", async () => {
    await failure(headFile(P, ""));
    expect((await headFile(P, "../../etc/passwd")).path).toBe("etc/passwd");
  });

  test("staging sets the index for one file and leaves the workdir alone", async () => {
    const out = (...args: string[]) => Bun.spawnSync(["git", "-C", WD, ...args]).stdout.toString();
    git("init", "-q");
    put("sub/a b.txt", "one\ntwo\nthree\n"); put("run.sh", "#!/bin/sh\n");
    git("add", "-A"); git("update-index", "--chmod=+x", "run.sh"); git("commit", "-qm", "base");
    put("sub/a b.txt", "ONE\ntwo\nTHREE\n");

    const before = await headFile(P, "sub/a b.txt");
    expect(before.index).toBe("one\ntwo\nthree\n");
    // stage only the first line's change
    const r = await stageFile(P, "sub/a b.txt", "ONE\ntwo\nthree\n", before.indexOid);
    expect(out("diff", "--cached")).toContain("+ONE");
    expect(out("diff", "--cached")).not.toContain("THREE");
    expect(out("diff")).toContain("+THREE");
    expect(get("sub/a b.txt")).toBe("ONE\ntwo\nTHREE\n");
    const after = await headFile(P, "sub/a b.txt");
    expect(after).toMatchObject({ content: "one\ntwo\nthree\n", index: "ONE\ntwo\nthree\n", indexOid: r.indexOid });

    // the index moved since `before` was read
    expect((await failure(stageFile(P, "sub/a b.txt", "x\n", before.indexOid))).status).toBe(409);

    // unstage: back to the last commit
    expect((await stageFile(P, "sub/a b.txt", null, after.indexOid)).indexOid).toBe(before.indexOid);
    expect(out("diff", "--cached")).toBe("");

    // a new file enters the index, and leaves it again; the mode is kept
    put("new.txt", "hi\n");
    await stageFile(P, "new.txt", "hi\n", null);
    expect(out("status", "--porcelain")).toContain("A  new.txt");
    await stageFile(P, "new.txt", null);
    expect(out("status", "--porcelain")).toContain("?? new.txt");
    await stageFile(P, "run.sh", "#!/bin/sh\necho\n");
    expect(out("ls-files", "-s", "run.sh")).toStartWith("100755 ");
  });

  test("staging needs a repository and a file path", async () => {
    put("a.txt", "x");
    expect((await failure(stageFile(P, "a.txt", "y"))).status).toBe(409);
    await failure(stageFile(P, "", "y"));
    await failure(stageFile(P, "a.txt", 5));
    await failure(stageFile(P, "a.txt", "y", "nope"));
  });

  test("whole files are staged, unstaged and committed", async () => {
    const out = (...args: string[]) => Bun.spawnSync(["git", "-C", WD, ...args]).stdout.toString();
    git("init", "-q"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
    put("a.txt", "1\n"); put("b [1].txt", "1\n"); put("gone.txt", "1\n");
    git("add", "-A"); git("commit", "-qm", "base");
    put("a.txt", "2\n"); put("b [1].txt", "2\n"); put("dir/new.txt", "n\n"); rmSync(join(WD, "gone.txt"));

    expect((await failure(commitStaged(P, "nothing yet"))).status).toBe(409);
    await stagePaths(P, ["a.txt", "dir", "gone.txt"], true);
    expect((await gitStatus(P)).staged).toEqual({ "a.txt": "all", "dir/new.txt": "all", "gone.txt": "all" });
    put("a.txt", "3\n"); // more, after staging
    expect((await gitStatus(P)).staged["a.txt"]).toBe("some");
    await stagePaths(P, ["gone.txt"], false);
    expect((await gitStatus(P)).staged["gone.txt"]).toBeUndefined();

    const c = await commitStaged(P, "  second commit\n\nbody\n");
    expect(c.subject).toBe("second commit");
    expect(out("log", "-1", "--format=%h")).toBe(c.sha + "\n");
    expect(out("show", "--stat", "--format=", "HEAD")).toContain("dir/new.txt");
    expect(out("status", "--porcelain")).toBe(' M a.txt\n M "b [1].txt"\n D gone.txt\n');

    await stagePaths(P, "all", true);
    expect(Object.keys((await gitStatus(P)).staged).sort()).toEqual(["a.txt", "b [1].txt", "gone.txt"]);
    await stagePaths(P, "all", false);
    expect((await gitStatus(P)).staged).toEqual({});
    await stagePaths(P, ["b [1].txt"], true); // brackets are not a pattern
    expect((await gitStatus(P)).staged).toEqual({ "b [1].txt": "all" });

    await failure(commitStaged(P, "  "));
    await failure(stagePaths(P, [], true));
    await failure(stagePaths(P, [""], true));
  });

  test("amend rewrites the last commit; push sends the branch to origin", async () => {
    const out = (...args: string[]) => Bun.spawnSync(["git", "-C", WD, ...args]).stdout.toString();
    const origin = join(WD, "..", `origin-${Date.now()}.git`);
    Bun.spawnSync(["git", "init", "-q", "--bare", origin]);
    git("init", "-q", "-b", "work"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
    expect(await lastCommit(P)).toEqual({ sha: null, message: "" });
    expect((await failure(commitStaged(P, "x", { amend: true }))).status).toBe(409);
    put("a.txt", "1\n"); git("add", "-A"); git("commit", "-qm", "first\n\nbody");
    expect(await gitStatus(P)).toMatchObject({ branch: "work", upstream: null, remote: false });
    expect((await failure(pushBranch(P))).status).toBe(409); // no origin

    git("remote", "add", "origin", origin);
    expect((await pushBranch(P)).branch).toBe("work");
    expect(await gitStatus(P)).toMatchObject({ branch: "work", upstream: "origin/work", ahead: 0, behind: 0, remote: true });
    expect(Bun.spawnSync(["git", "-C", origin, "log", "-1", "--format=%s", "work"]).stdout.toString()).toBe("first\n");

    // amend: staged change joins the commit, message replaced, still one commit
    expect((await lastCommit(P)).message).toBe("first\n\nbody");
    put("a.txt", "2\n"); git("add", "-A");
    const c = await commitStaged(P, "first, reworded", { amend: true });
    expect(c).toMatchObject({ subject: "first, reworded", amended: true });
    expect(out("rev-list", "--count", "HEAD")).toBe("1\n");
    expect(out("show", "HEAD:a.txt")).toBe("2\n");
    expect((await commitStaged(P, "reworded again", { amend: true })).subject).toBe("reworded again"); // nothing staged: reword only
    expect(await gitStatus(P)).toMatchObject({ ahead: 1, behind: 1 });

    // the pushed commit was amended: refused, unless forced
    const e = await failure(pushBranch(P));
    expect(e.status).toBe(409);
    expect(e.extra.rejected).toBe(true);
    expect((await pushBranch(P, { force: true })).forced).toBe(true);
    expect(Bun.spawnSync(["git", "-C", origin, "log", "-1", "--format=%s", "work"]).stdout.toString()).toBe("reworded again\n");
    expect(await gitStatus(P)).toMatchObject({ ahead: 0, behind: 0 });
    rmSync(origin, { recursive: true, force: true });
  });

  test("branches are listed, switched to and created", async () => {
    const origin = join(WD, "..", `origin-b-${Date.now()}.git`);
    Bun.spawnSync(["git", "init", "-q", "--bare", origin]);
    git("init", "-q", "-b", "main"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
    put("a.txt", "main\n"); git("add", "-A"); git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "theirs"); put("a.txt", "theirs\n"); git("commit", "-qam", "theirs");
    git("remote", "add", "origin", origin); git("push", "-q", "origin", "theirs");
    git("checkout", "-q", "main"); git("branch", "-q", "-D", "theirs");

    expect(await listBranches(P)).toEqual({ current: "main", branches: [{ name: "main", remote: false }, { name: "theirs", remote: true }] });
    expect(await switchBranch(P, "theirs")).toEqual({ branch: "theirs", created: false }); // from origin, tracking it
    expect(get("a.txt")).toBe("theirs\n");
    expect(await gitStatus(P)).toMatchObject({ branch: "theirs", upstream: "origin/theirs" });

    // an uncommitted change that the switch would overwrite: refused, nothing lost
    put("a.txt", "mine\n");
    const e = await failure(switchBranch(P, "main"));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/overwritten|a\.txt/);
    expect(get("a.txt")).toBe("mine\n");
    // a new branch keeps it
    expect(await switchBranch(P, "feature/x", { create: true })).toEqual({ branch: "feature/x", created: true });
    expect(get("a.txt")).toBe("mine\n");
    expect((await listBranches(P)).current).toBe("feature/x");
    expect(getProject(P)?.branch).toBe("feature/x"); // remembered for the projects list

    expect((await failure(switchBranch(P, "feature/x", { create: true }))).status).toBe(409); // exists
    expect((await failure(switchBranch(P, "nope"))).status).toBe(409);
    await failure(switchBranch(P, "-f"));
    await failure(switchBranch(P, "bad..name", { create: true }));
    await failure(switchBranch(P, 7));
    rmSync(origin, { recursive: true, force: true });
  });

  test("discard puts files back as committed and removes new ones", async () => {
    const out = (...args: string[]) => Bun.spawnSync(["git", "-C", WD, ...args]).stdout.toString();
    git("init", "-q"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
    put(".gitignore", "*.log\n"); put("a.txt", "1\n"); put("b [1].txt", "1\n"); put("gone.txt", "1\n"); put("keep.txt", "1\n");
    git("add", "-A"); git("commit", "-qm", "base");
    put("a.txt", "2\n"); git("add", "a.txt"); put("a.txt", "3\n");   // staged and more
    put("b [1].txt", "2\n"); rmSync(join(WD, "gone.txt")); put("keep.txt", "2\n");
    put("new.txt", "n\n"); git("add", "new.txt"); put("dir/x.txt", "x\n"); put("debug.log", "l\n");

    await discardPaths(P, ["a.txt", "b [1].txt", "gone.txt", "new.txt", "dir"]);
    expect(get("a.txt")).toBe("1\n"); expect(get("b [1].txt")).toBe("1\n"); expect(get("gone.txt")).toBe("1\n");
    expect(existsSync(join(WD, "new.txt"))).toBe(false); expect(existsSync(join(WD, "dir"))).toBe(false);
    expect(out("status", "--porcelain")).toBe(" M keep.txt\n"); // the one not named
    expect(get("debug.log")).toBe("l\n");

    put("other.txt", "o\n");
    await discardPaths(P, "all");
    expect(out("status", "--porcelain")).toBe("");
    expect(get("keep.txt")).toBe("1\n"); expect(get("debug.log")).toBe("l\n"); // ignored files survive
    await failure(discardPaths(P, []));
    await failure(discardPaths(P, [""]));
  });

  test("stash puts changes away and brings them back", async () => {
    const out = (...args: string[]) => Bun.spawnSync(["git", "-C", WD, ...args]).stdout.toString();
    git("init", "-q"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
    put("a.txt", "1\n"); git("add", "-A"); git("commit", "-qm", "base");
    expect((await failure(stash(P, "push"))).status).toBe(409); // nothing to stash
    expect(await listStashes(P)).toEqual({ stashes: [] });

    put("a.txt", "2\n"); put("new.txt", "n\n");
    await stash(P, "push", { message: "half done" });
    expect(out("status", "--porcelain")).toBe("");
    expect(existsSync(join(WD, "new.txt"))).toBe(false);
    expect((await listStashes(P)).stashes).toEqual([{ index: 0, message: expect.stringContaining("half done") }]);

    // a change in the way: the stash stays
    put("a.txt", "3\n");
    expect((await failure(stash(P, "pop", { index: 0 }))).status).toBe(409);
    expect((await listStashes(P)).stashes.length).toBe(1);
    await discardPaths(P, "all");
    await stash(P, "pop", { index: 0 });
    expect(get("a.txt")).toBe("2\n"); expect(get("new.txt")).toBe("n\n");
    expect(await listStashes(P)).toEqual({ stashes: [] });

    await stash(P, "push");
    await stash(P, "drop", { index: 0 });
    expect(await listStashes(P)).toEqual({ stashes: [] });
    expect((await failure(stash(P, "pop", { index: 0 }))).status).toBe(409);
    await failure(stash(P, "pop"));
    await failure(stash(P, "explode"));
  });
});
