// Sync back: make the project's folder on this machine look like the VM's
// workdir — as plain, uncommitted file changes, for the user to review and
// commit themselves. Nothing is committed on either side: not in the VM (its
// branch, index and uncommitted work are left exactly as they are) and not in
// the folder (its own repository, if it is one, is never written to).
//
// How: the VM records its workdir — committed or not, minus ignored files — as
// a snapshot commit on a hidden ref, which travels as a git bundle over exec
// stdout into a private repository in sadbox's data dir. That repository's work
// tree is the folder, so checking the snapshot out there writes the files. Git
// does the writing on this side, which gives two things for free:
//   · only files that changed since the last sync are touched, and a file the
//     user has edited meanwhile is never overwritten — the sync stops and says
//     which files are in the way;
//   · nothing a VM sends can land outside the folder.
import { existsSync, mkdirSync, realpathSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { config } from "../config";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { LONG_TASK_MS } from "../driver/types";
import { getProject, refFor, syncFolderOf } from "./projects";

const driver = getDriver();

/** The hidden ref the workdir snapshot lives on, in the VM and in the copy here. */
const SNAPSHOT_REF = "refs/sadbox/snapshot";

async function hostGit(at: string[], args: string[]) {
  const proc = Bun.spawn(["git", ...at, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

/** Is `folder` the top of a git repository (as opposed to a plain folder)? */
export async function isGitRepo(folder: string): Promise<boolean> {
  const top = await hostGit(["-C", folder], ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return false;
  try { return realpathSync(top.out) === realpathSync(folder); } catch { return false; }
}

/** The private repository that tracks what a project's folder was last given. */
export const mirrorPath = (projectId: string) => join(config.dataDir, "sync", `${projectId}.git`);
export async function forgetMirror(projectId: string): Promise<void> {
  await rm(mirrorPath(projectId), { recursive: true, force: true });
}

/** Record the workdir as a commit on SNAPSHOT_REF without disturbing anything
 *  the agent (or the user in the terminal) can see: a throwaway index, no
 *  change to the branch. The commit is a pure function of the files and the
 *  branch tip, so an unchanged workdir yields the same id again. */
const SNAPSHOT_SCRIPT =
  `set -e; cd ${config.guestWorkdir}; ` +
  `tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; ` +
  // start from a copy of the real index so unchanged files are not re-read;
  // -p keeps its timestamp, which git relies on to spot a file edited in the
  // same second the index was written
  `cp -p "$(git rev-parse --git-path index)" "$tmp/index" 2>/dev/null || true; ` +
  `export GIT_INDEX_FILE="$tmp/index"; ` +
  `git add -A; tree=$(git write-tree); ` +
  `head=$(git rev-parse -q --verify HEAD || true); ` +
  `when=$(git log -1 --format=%cI 2>/dev/null || echo 2000-01-01T00:00:00Z); ` +
  `export GIT_AUTHOR_NAME=sadbox GIT_AUTHOR_EMAIL=sadbox@local GIT_COMMITTER_NAME=sadbox GIT_COMMITTER_EMAIL=sadbox@local; ` +
  `export GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when"; ` +
  `snap=$(git commit-tree "$tree" \${head:+-p "$head"} -m "sadbox: workdir snapshot"); ` +
  `git update-ref ${SNAPSHOT_REF} "$snap"; ` +
  `echo "snapshot=$snap"`;

const firstLines = (text: string, n = 6) => text.split("\n").slice(0, n).join("\n");

/** The files git named when it refused a checkout rather than overwrite them. */
function filesInTheWay(stderr: string): string[] {
  const files: string[] = [];
  let listing = false;
  for (const line of stderr.split("\n")) {
    if (/would be overwritten by checkout|would be removed by checkout/.test(line)) { listing = true; continue; }
    if (listing && /^\t/.test(line)) files.push(line.trim());
    else listing = false;
  }
  return files;
}

export async function syncProject(id: string, opts?: { force?: boolean }) {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  const folder = syncFolderOf(p);
  if (!folder) {
    throw new Error("this project was cloned from a git remote and has no local folder to sync into — connect one on the project's page, or commit and `git push` from inside the VM");
  }
  if (!existsSync(folder)) throw new Error(`the connected folder no longer exists: ${folder}`);
  const ref = refFor(p.name);

  // the private repository, with the folder as its work tree
  const mirror = mirrorPath(id);
  const at = ["--git-dir", mirror, "--work-tree", folder];
  const has = (sha: string) => hostGit(at, ["cat-file", "-e", `${sha}^{commit}`]).then((r) => r.code === 0);
  const fresh = !existsSync(mirror);
  if (fresh) {
    mkdirSync(join(config.dataDir, "sync"), { recursive: true });
    const init = await hostGit([], ["init", "-q", "--bare", mirror]);
    if (init.code !== 0) throw new Error(`could not prepare the sync history: ${init.err}`);
    // a folder that is a repository already holds most of the history: borrow
    // its objects (read-only) so only what is new has to travel
    if (await isGitRepo(folder)) {
      const objects = await hostGit(["-C", folder], ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
      if (objects.code === 0) await Bun.write(join(mirror, "objects", "info", "alternates"), objects.out + "\n");
    }
  }

  // 1. snapshot the workdir in the VM
  const snap = await driver.exec(ref, ["sh", "-c", SNAPSHOT_SCRIPT], { timeoutMs: LONG_TASK_MS });
  const tip = /snapshot=([0-9a-f]{40,64})/.exec(snap.stdout)?.[1];
  if (snap.exitCode !== 0 || !tip) throw new Error(`could not snapshot the workdir: ${snap.stderr.trim() || snap.stdout.trim()}`);

  // 2. bring it here, leaving out whatever history this side already holds
  let bundleBytes = 0;
  const fetched = !(await has(tip));
  if (fetched) {
    const known: string[] = [];
    for (const sha of new Set([p.base_sha, p.last_synced_sha])) {
      if (sha && /^[0-9a-f]{40,64}$/.test(sha) && await has(sha)) known.push(sha);
    }
    const bundle = await driver.execCaptureBytes(ref,
      `cd ${config.guestWorkdir} && ` +
      // only name commits the VM has too (an old snapshot may be gone from it)
      `not=""; for s in ${known.join(" ")}; do git cat-file -e "$s^{commit}" 2>/dev/null && not="$not ^$s"; done; ` +
      `git bundle create - ${SNAPSHOT_REF} $not`, { timeoutMs: LONG_TASK_MS });
    if (bundle.exitCode !== 0 || bundle.stdout.length === 0) throw new Error("bundle creation failed in guest");
    bundleBytes = bundle.stdout.length;
    const bundlePath = join(config.dataDir, `${ref}-${Date.now()}.bundle`);
    await Bun.write(bundlePath, bundle.stdout);
    try {
      const fetch = await hostGit(at, ["fetch", "-q", bundlePath, `+${SNAPSHOT_REF}:${SNAPSHOT_REF}`]);
      if (fetch.code !== 0) throw new Error(`host fetch failed: ${fetch.err}`);
    } finally {
      await Bun.file(bundlePath).delete().catch(() => {});
    }
  }

  // 3. the first time, say what the folder is expected to hold already. A
  // repository that has the commit the project started from is taken to be a
  // checkout of it, so only what the project changed is written (and its own
  // newer files are left alone). Any other folder is taken to hold nothing of
  // the project's, so every file is written.
  if (fresh) {
    const folderHasBase = p.base_sha != null && await isGitRepo(folder) &&
      (await hostGit(["-C", folder], ["cat-file", "-e", `${p.base_sha}^{commit}`])).code === 0;
    if (folderHasBase && await has(p.base_sha!)) {
      await hostGit(at, ["read-tree", p.base_sha!]);
      await hostGit(at, ["update-ref", "--no-deref", "HEAD", p.base_sha!]);
    }
  }

  // 4. write the files
  const before = await hostGit(at, ["rev-parse", "-q", "--verify", "HEAD"]);
  const previous = before.code === 0 ? before.out : null;
  let applied: "copied" | "current" | "not-applied";
  let note: string | null = null;
  let blocking: string[] = [];
  let changed = "";
  if (previous === tip && !opts?.force) {
    applied = "current";
    // nothing new from the VM — but the folder may have moved on since
    const drift = await hostGit(at, ["diff", "--name-only", tip]);
    const n = drift.out ? drift.out.split("\n").length : 0;
    if (n) note = `${n} file${n === 1 ? "" : "s"} in the folder differ${n === 1 ? "s" : ""} from the VM (edited or committed there since the last sync)`;
  } else {
    let co = await hostGit(at, ["checkout", "-q", ...(opts?.force ? ["-f"] : []), "--detach", tip]);
    // forced: write every file out again, whatever git believes is already in
    // place — its changed-file check goes by size and timestamp, and can miss
    // an edit made in the same instant as the last sync. Rebuilding the index
    // from the snapshot drops those notes, so nothing is assumed unchanged.
    if (opts?.force && co.code === 0) {
      await hostGit(at, ["read-tree", tip]);
      co = await hostGit(at, ["checkout-index", "-q", "-f", "-a"]);
      await hostGit(at, ["update-index", "-q", "--refresh"]);
    }
    if (co.code === 0) {
      applied = "copied";
      // against the previous snapshot, or — the first time into a folder that
      // held nothing of the project's — against an empty tree
      const from = previous ?? (await hostGit(at, ["hash-object", "-t", "tree", "/dev/null"])).out;
      const stat = await hostGit(at, ["diff", "--stat", from, tip]);
      changed = previous === tip ? "" : stat.out;
    } else {
      applied = "not-applied";
      blocking = filesInTheWay(co.err);
      note = blocking.length
        ? "these files in the folder were changed there too (or already exist), and were not overwritten"
        : firstLines(co.err);
    }
  }

  if (applied !== "not-applied") db.query("UPDATE projects SET last_synced_sha = ? WHERE id = ?").run(tip, id);
  logEvent(id, "sync", `${tip.slice(0, 7)} → ${folder}: ${applied}` +
    (blocking.length ? ` (${blocking.length} file(s) in the way)` : "") + (fetched ? ` · ${bundleBytes} bytes` : ""));

  return {
    // nothing travelled and nothing changed in the folder
    upToDate: applied === "current",
    folder,
    kind: (await isGitRepo(folder)) ? "git" as const : "folder" as const,
    applied,
    note,
    blocking,      // files that stopped the sync — `force` overwrites them
    forced: !!opts?.force,
    tip,
    bundleBytes,
    changed,       // diffstat of what this sync wrote
  };
}

/** Preview without syncing: how much uncommitted work is in the VM's workdir? */
export async function syncStatus(id: string) {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  const r = await driver.exec(refFor(p.name), ["sh", "-c",
    `cd ${config.guestWorkdir} && echo "dirty=$(git status --porcelain | wc -l)"`,
  ]);
  const dirty = Number(/dirty=\s*(\d+)/.exec(r.stdout)?.[1] ?? 0);
  return { dirty };
}
