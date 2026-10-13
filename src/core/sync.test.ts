import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { db } from "../db";
import { branchFor, connectSyncFolder, getProject } from "./projects";
import { syncProject } from "./sync";

// The preload's stub `container exec` runs guest commands on this machine with
// the guest workdir mapped to WD — so WD plays the VM's workdir here, and the
// "local folders" are ordinary repositories in a temp dir.
const WD = process.env.SADBOX_TEST_WORKDIR!;
const tmp = mkdtempSync(join(tmpdir(), "sadbox-sync-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const commit = (repo: string, file: string, text: string) => {
  writeFileSync(join(repo, file), text);
  git(repo, "add", "-A"); git(repo, "commit", "-qm", `add ${file}`);
  return git(repo, "rev-parse", "HEAD");
};
const dir = (name: string) => { const d = join(tmp, name); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };

let n = 0, id = "", name = "", remote = "", base = "";

/** A project "created from a git URL": the VM workdir is a clone of `remote`
 *  on the project's work branch, and there is no local folder. */
beforeEach(() => {
  for (const e of readdirSync(WD)) rmSync(join(WD, e), { recursive: true, force: true });
  id = `sync${++n}`; name = `proj-${id}`;
  remote = dir(`remote-${n}`);
  git(remote, "init", "-q"); commit(remote, "README.md", "hello\n"); base = commit(remote, "app.js", "v1\n");
  git(tmp, "clone", "-q", remote, WD);
  git(WD, "config", "user.name", "agent"); git(WD, "config", "user.email", "agent@vm");
  git(WD, "checkout", "-q", "-b", branchFor(name));
  db.query(`INSERT INTO projects (id, name, image, state, source_path, source_branch, base_sha, last_synced_sha, git_remote)
            VALUES (?, ?, 'img', 'running', '', 'main', ?, ?, 'https://example.com/repo.git')`).run(id, name, base, base);
});

const cloneOfRemote = (label: string) => { const d = join(tmp, `${label}-${n}`); rmSync(d, { recursive: true, force: true }); git(tmp, "clone", "-q", remote, d); return d; };
const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");
const files = (d: string) => readdirSync(d).filter((f) => f !== ".git").sort();
const status = (repo: string) => git(repo, "status", "--porcelain").split("\n").map((l) => l.trim()).filter(Boolean).sort();

describe("connecting a folder", () => {
  test("without a folder there is nowhere to sync, and the error says what to do", async () => {
    await expect(syncProject(id)).rejects.toThrow(/connect one on the project's page/);
  });

  test("rejects a missing folder and a file", async () => {
    await expect(connectSyncFolder(id, join(tmp, "nope"))).rejects.toThrow(/folder not found/);
    writeFileSync(join(tmp, "a-file"), "x");
    await expect(connectSyncFolder(id, join(tmp, "a-file"))).rejects.toThrow(/not a folder/);
    expect(getProject(id)!.sync_path).toBeNull();
  });

  test("a subfolder of a repository connects the repository itself", async () => {
    const local = cloneOfRemote("local");
    mkdirSync(join(local, "src"));
    const r = await connectSyncFolder(id, join(local, "src"));
    expect(r.sync_path).toBe(git(local, "rev-parse", "--show-toplevel"));
    expect(r.isGitRepo).toBe(true);
  });

  test("a project created from a local folder cannot be pointed somewhere else", async () => {
    db.query("UPDATE projects SET source_path = ? WHERE id = ?").run(remote, id);
    await expect(connectSyncFolder(id, cloneOfRemote("local"))).rejects.toThrow(/already syncs there/);
  });

  test("unknown and destroyed projects are refused", async () => {
    await expect(connectSyncFolder("nope", tmp)).rejects.toThrow(/project not found/);
    db.query("UPDATE projects SET state = 'destroyed' WHERE id = ?").run(id);
    await expect(connectSyncFolder(id, cloneOfRemote("local"))).rejects.toThrow(/project not found/);
  });

  test("disconnecting stops syncing and leaves the folder as it is", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(WD, "feature.js"), "x\n");
    await syncProject(id);
    expect((await connectSyncFolder(id, null)).sync_path).toBeNull();
    await expect(syncProject(id)).rejects.toThrow(/no local folder/);
    expect(read(local, "feature.js")).toBe("x\n"); // what was synced stays
  });
});

describe("sync back into a git repository", () => {
  test("the folder's files become the workdir's, uncommitted — and nothing is committed anywhere", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(local, "my-notes.txt"), "a stray file of mine\n");
    const localHead = git(local, "rev-parse", "HEAD");
    const localRefs = git(local, "for-each-ref");

    // in the VM: one commit by the agent, then loose work — an edit, a new file, a deletion
    const agentCommit = commit(WD, "feature.js", "committed by the agent\n");
    writeFileSync(join(WD, "app.js"), "v2, not committed\n");
    writeFileSync(join(WD, "new.txt"), "untracked\n");
    mkdirSync(join(WD, "src")); writeFileSync(join(WD, "src/deep.js"), "nested\n");
    rmSync(join(WD, "README.md"));
    const vmStatus = status(WD);

    const r = await syncProject(id);
    expect(r).toMatchObject({ upToDate: false, applied: "copied", kind: "git", blocking: [] });
    expect(r.changed).toContain("feature.js");

    // the folder now holds the workdir's files…
    expect(files(local)).toEqual(["app.js", "feature.js", "my-notes.txt", "new.txt", "src"]);
    expect(read(local, "app.js")).toBe("v2, not committed\n");
    expect(read(local, "feature.js")).toBe("committed by the agent\n");
    expect(read(local, "src/deep.js")).toBe("nested\n");
    // …as changes for the user to review: no commit, no branch move, no new refs
    expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(local, "for-each-ref")).toBe(localRefs);
    expect(status(local)).toEqual(["?? feature.js", "?? my-notes.txt", "?? new.txt", "?? src/", "D README.md", "M app.js"]);

    // and the VM is exactly as it was: same commits, same uncommitted work
    expect(git(WD, "rev-parse", "HEAD")).toBe(agentCommit);
    expect(git(WD, "branch", "--show-current")).toBe(branchFor(name));
    expect(status(WD)).toEqual(vmStatus);
    expect(git(WD, "log", "--format=%s")).not.toContain("autocommit");
  });

  test("a second sync with nothing new is up to date; later changes follow, touching only what changed", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(WD, "a.js"), "1\n");
    expect((await syncProject(id)).bundleBytes).toBeGreaterThan(0);
    const again = await syncProject(id);
    expect(again).toMatchObject({ upToDate: true, applied: "current", bundleBytes: 0, note: null });

    writeFileSync(join(WD, "a.js"), "2\n");
    rmSync(join(WD, "app.js"));
    const r = await syncProject(id);
    expect(r.applied).toBe("copied");
    expect(r.changed).toContain("a.js");
    expect(r.changed).not.toContain("README.md");
    expect(files(local)).toEqual(["README.md", "a.js"]);
    expect(read(local, "a.js")).toBe("2\n");
  });

  test("the usual loop: sync, commit it yourself, the agent carries on, sync again", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(WD, "app.js"), "v2\n");
    await syncProject(id);
    git(local, "add", "-A"); git(local, "commit", "-qm", "reviewed: v2");

    writeFileSync(join(WD, "app.js"), "v3\n");
    writeFileSync(join(WD, "extra.js"), "more\n");
    expect((await syncProject(id)).applied).toBe("copied");
    expect(read(local, "app.js")).toBe("v3\n");
    expect(status(local)).toEqual(["?? extra.js", "M app.js"]);
  });

  test("your own edits to other files are left alone", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(local, "README.md"), "my edit\n");
    writeFileSync(join(WD, "app.js"), "v2\n");
    expect((await syncProject(id)).applied).toBe("copied");
    expect(read(local, "README.md")).toBe("my edit\n");
    expect(read(local, "app.js")).toBe("v2\n");
  });

  test("a file you changed too is never overwritten: the sync stops and names it; force overwrites", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(local, "app.js"), "my half-finished edit\n");
    writeFileSync(join(WD, "app.js"), "the agent's version\n");
    writeFileSync(join(WD, "other.js"), "also new\n");

    const r = await syncProject(id);
    expect(r.applied).toBe("not-applied");
    expect(r.blocking).toEqual(["app.js"]);
    expect(r.upToDate).toBe(false);
    expect(read(local, "app.js")).toBe("my half-finished edit\n");
    expect(files(local)).not.toContain("other.js"); // all or nothing

    const forced = await syncProject(id, { force: true });
    expect(forced).toMatchObject({ applied: "copied", forced: true });
    expect(forced.bundleBytes).toBe(0); // already here from the first attempt
    expect(read(local, "app.js")).toBe("the agent's version\n");
    expect(read(local, "other.js")).toBe("also new\n");
  });

  test("a folder that already has some of the VM's work committed still gets the rest", async () => {
    // the agent commits and pushes; the folder pulls that — so it is no longer
    // at the commit the project started from — and the agent carries on
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(WD, "app.js"), "v2\n");
    const pushed = commit(WD, "engine.js", "first cut\n");
    git(local, "pull", "-q", WD, branchFor(name)); // stands in for push from the VM + pull here
    expect(git(local, "rev-parse", "HEAD")).toBe(pushed);
    writeFileSync(join(WD, "app.js"), "v3, loose\n");
    writeFileSync(join(WD, "engine.js"), "second cut, loose\n");
    writeFileSync(join(WD, "extra.js"), "new\n");

    const r = await syncProject(id);
    expect(r).toMatchObject({ applied: "copied", blocking: [] });
    expect(read(local, "app.js")).toBe("v3, loose\n");
    expect(read(local, "engine.js")).toBe("second cut, loose\n");
    expect(git(local, "rev-parse", "HEAD")).toBe(pushed);
    // exactly the work that is not committed yet, for review
    expect(status(local)).toEqual(["?? extra.js", "M app.js", "M engine.js"]);
    expect(r.changed).not.toContain("README.md");
  });

  test("…but an uncommitted edit in such a folder still stops the sync", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    commit(WD, "engine.js", "first cut\n");
    git(local, "pull", "-q", WD, branchFor(name)); // stands in for push from the VM + pull here
    writeFileSync(join(local, "engine.js"), "my own tweak\n");
    writeFileSync(join(WD, "engine.js"), "second cut\n");
    writeFileSync(join(WD, "app.js"), "v2\n");

    const r = await syncProject(id);
    expect(r).toMatchObject({ applied: "not-applied", blocking: ["engine.js"] });
    expect(read(local, "engine.js")).toBe("my own tweak\n");
    expect(read(local, "app.js")).toBe("v1\n");
    expect(status(local)).toEqual(["M engine.js"]);
  });

  test("a change you committed to a file the agent also changed is replaced in the folder, and stays in your history", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    const mine = commit(local, "app.js", "my committed version\n");
    writeFileSync(join(WD, "app.js"), "the agent's version\n");

    const r = await syncProject(id);
    expect(r).toMatchObject({ applied: "copied", blocking: [] });
    expect(read(local, "app.js")).toBe("the agent's version\n");
    expect(git(local, "rev-parse", "HEAD")).toBe(mine);
    expect(git(local, "show", "HEAD:app.js")).toBe("my committed version");
    expect(status(local)).toEqual(["M app.js"]);
  });

  test("a folder where a project file's place is taken by a directory is reported, not half-written", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    mkdirSync(join(local, "notes")); writeFileSync(join(local, "notes/mine.txt"), "mine\n");
    writeFileSync(join(WD, "notes"), "a file in the VM\n");
    writeFileSync(join(WD, "app.js"), "v2\n");

    const r = await syncProject(id);
    expect(r.applied).toBe("not-applied");
    expect(r.note).toBeTruthy();
    expect(read(local, "notes/mine.txt")).toBe("mine\n");
    expect(read(local, "app.js")).toBe("v1\n");
  });

  test("an untracked file of yours with the same name as a new project file blocks the sync", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(local, "notes.md"), "mine\n");
    writeFileSync(join(WD, "notes.md"), "the agent's\n");
    const r = await syncProject(id);
    expect(r.applied).toBe("not-applied");
    expect(r.blocking).toEqual(["notes.md"]);
    expect(read(local, "notes.md")).toBe("mine\n");
  });

  test("discarding the synced changes in the folder is noticed, and force puts them back", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(WD, "app.js"), "v2\n");
    await syncProject(id);
    git(local, "checkout", "--", "app.js");

    const r = await syncProject(id);
    expect(r.applied).toBe("current");
    expect(r.note).toMatch(/1 file in the folder differs from the VM/);
    expect((await syncProject(id, { force: true })).applied).toBe("copied");
    expect(read(local, "app.js")).toBe("v2\n");
  });

  test("ignored files stay in the VM", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    writeFileSync(join(WD, ".gitignore"), "node_modules/\n*.log\n");
    mkdirSync(join(WD, "node_modules")); writeFileSync(join(WD, "node_modules/big.js"), "x\n");
    writeFileSync(join(WD, "debug.log"), "noise\n");
    await syncProject(id);
    expect(files(local)).toEqual([".gitignore", "README.md", "app.js"]);
  });

  test("a repository that is not a checkout of the project gets every file, next to its own", async () => {
    const other = dir(`unrelated-${n}`);
    git(other, "init", "-q"); const own = commit(other, "mine.txt", "a different project\n");
    expect((await connectSyncFolder(id, other)).hasBase).toBe(false);
    writeFileSync(join(WD, "feature.js"), "x\n");
    expect((await syncProject(id)).applied).toBe("copied");
    expect(files(other)).toEqual(["README.md", "app.js", "feature.js", "mine.txt"]);
    expect(git(other, "rev-parse", "HEAD")).toBe(own);
  });

  test("switching to another folder fills it with everything, not just what is new since the last sync", async () => {
    const first = cloneOfRemote("first"), second = cloneOfRemote("second");
    await connectSyncFolder(id, first);
    writeFileSync(join(WD, "feature.js"), "x\n");
    await syncProject(id);

    await connectSyncFolder(id, second);
    const r = await syncProject(id); // nothing new in the VM, but `second` has none of it yet
    expect(r).toMatchObject({ upToDate: false, applied: "copied" });
    expect(read(second, "feature.js")).toBe("x\n");
  });
});

describe("sync back into a plain folder", () => {
  test("receives the files and mirrors later changes; other files are left alone", async () => {
    const plain = dir(`plain-${n}`);
    writeFileSync(join(plain, "keep-me.txt"), "nothing to do with the project\n");
    const c = await connectSyncFolder(id, plain);
    expect(c).toMatchObject({ isGitRepo: false, hasBase: null });

    commit(WD, "feature.js", "x\n");
    mkdirSync(join(WD, "src")); writeFileSync(join(WD, "src/deep.js"), "nested, uncommitted\n");
    let r = await syncProject(id);
    expect(r).toMatchObject({ kind: "folder", applied: "copied" });
    expect(readdirSync(plain).sort()).toEqual(["README.md", "app.js", "feature.js", "keep-me.txt", "src"]); // and no .git
    expect(read(plain, "src/deep.js")).toBe("nested, uncommitted\n");
    expect((await syncProject(id)).upToDate).toBe(true);

    writeFileSync(join(WD, "app.js"), "v2\n");
    rmSync(join(WD, "feature.js"));
    r = await syncProject(id);
    expect(r.applied).toBe("copied");
    expect(readdirSync(plain).sort()).toEqual(["README.md", "app.js", "keep-me.txt", "src"]);
    expect(read(plain, "app.js")).toBe("v2\n");
    expect(read(plain, "keep-me.txt")).toBe("nothing to do with the project\n");
  });

  test("a file already there under a project file's name blocks the sync until forced", async () => {
    const plain = dir(`plain-${n}`);
    writeFileSync(join(plain, "app.js"), "an old copy\n");
    await connectSyncFolder(id, plain);
    const r = await syncProject(id);
    expect(r.applied).toBe("not-applied");
    expect(r.blocking).toEqual(["app.js"]);
    expect(read(plain, "app.js")).toBe("an old copy\n");
    expect((await syncProject(id, { force: true })).applied).toBe("copied");
    expect(read(plain, "app.js")).toBe("v1\n");
    expect(readdirSync(plain).sort()).toEqual(["README.md", "app.js"]);
  });

  test("moving from one plain folder to another fills the new one completely", async () => {
    const one = dir(`one-${n}`), two = dir(`two-${n}`);
    await connectSyncFolder(id, one);
    writeFileSync(join(WD, "feature.js"), "x\n");
    await syncProject(id);
    await connectSyncFolder(id, two);
    expect((await syncProject(id)).applied).toBe("copied");
    expect(readdirSync(two).sort()).toEqual(["README.md", "app.js", "feature.js"]);
  });
});
