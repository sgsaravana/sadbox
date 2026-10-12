import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
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
const remoteRef = (repo: string) => git(repo, "rev-parse", `refs/remotes/${branchFor(name)}`);

describe("connecting a local folder to a project cloned from a git URL", () => {
  test("without a folder there is nowhere to sync, and the error says what to do", async () => {
    await expect(syncProject(id)).rejects.toThrow(/connect one on the project's page/);
  });

  test("rejects a missing folder and a folder that is not a git repository", async () => {
    await expect(connectSyncFolder(id, join(tmp, "nope"))).rejects.toThrow(/folder not found/);
    await expect(connectSyncFolder(id, dir("plain"))).rejects.toThrow(/not a git repository/);
    expect(getProject(id)!.sync_path).toBeNull();
  });

  test("a subfolder of a repository connects the repository itself", async () => {
    const local = cloneOfRemote("local");
    mkdirSync(join(local, "src"));
    const r = await connectSyncFolder(id, join(local, "src"));
    expect(r.sync_path).toBe(git(local, "rev-parse", "--show-toplevel"));
  });

  test("a clone of the same remote: only the new commits travel, and the folder's own work is untouched", async () => {
    const local = cloneOfRemote("local");
    expect((await connectSyncFolder(id, local)).hasBase).toBe(true);
    writeFileSync(join(local, "my-notes.txt"), "uncommitted work of mine\n");
    const headBefore = git(local, "rev-parse", "HEAD");

    const tip = commit(WD, "feature.js", "from the agent\n");
    const r = await syncProject(id);
    expect(r.upToDate).toBe(false);
    expect(r.fullHistory).toBe(false);
    expect(r.folder).toBe(getProject(id)!.sync_path!);
    expect(remoteRef(local)).toBe(tip);
    expect(r.commits).toContain("add feature.js");
    // nothing of the user's moved: same HEAD, same branch, the stray file still there and untracked
    expect(git(local, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(local, "status", "--porcelain")).toBe("?? my-notes.txt");
    expect(readdirSync(local)).not.toContain("feature.js");
  });

  test("a second sync with nothing new is up to date; later commits and uncommitted edits follow", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    commit(WD, "a.js", "1\n");
    await syncProject(id);
    expect((await syncProject(id)).upToDate).toBe(true);

    commit(WD, "b.js", "2\n");
    writeFileSync(join(WD, "c.js"), "not committed yet\n"); // autocommitted by the sync
    const r = await syncProject(id);
    expect(r.fullHistory).toBe(false);
    expect(git(local, "ls-tree", "-r", "--name-only", remoteRef(local)).split("\n").sort())
      .toEqual(["README.md", "a.js", "app.js", "b.js", "c.js"]);
  });

  test("a folder without the VM's starting commit gets the branch's full history", async () => {
    const other = dir(`unrelated-${n}`);
    git(other, "init", "-q"); const own = commit(other, "mine.txt", "a different project\n");
    expect((await connectSyncFolder(id, other)).hasBase).toBe(false);

    const tip = commit(WD, "feature.js", "x\n");
    const r = await syncProject(id);
    expect(r.fullHistory).toBe(true);
    expect(remoteRef(other)).toBe(tip);
    expect(git(other, "rev-list", "--count", remoteRef(other))).toBe("3"); // README, app.js, feature.js
    expect(git(other, "rev-parse", "HEAD")).toBe(own);
  });

  test("switching to another folder delivers everything since the VM's start, not just what is new since the last sync", async () => {
    const first = cloneOfRemote("first"), second = cloneOfRemote("second");
    await connectSyncFolder(id, first);
    const tip = commit(WD, "feature.js", "x\n");
    await syncProject(id);

    await connectSyncFolder(id, second);
    const r = await syncProject(id);           // nothing new in the VM, but `second` has none of it yet
    expect(r.upToDate).toBe(false);
    expect(remoteRef(second)).toBe(tip);
  });

  test("disconnecting stops syncing and leaves the folder as it is", async () => {
    const local = cloneOfRemote("local");
    await connectSyncFolder(id, local);
    const tip = commit(WD, "feature.js", "x\n");
    await syncProject(id);
    expect((await connectSyncFolder(id, null)).sync_path).toBeNull();
    await expect(syncProject(id)).rejects.toThrow(/no local folder/);
    expect(remoteRef(local)).toBe(tip); // what was synced stays
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
});
