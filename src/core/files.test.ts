import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { makeProject } from "../../test/helpers";
import {
  FileError, MAX_FILE_BYTES, cleanPath, deletePath, fileIndex, listDir, makeDir, readFile, renamePath, sha256, writeFile,
} from "./files";

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
