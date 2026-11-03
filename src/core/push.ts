// Push: the other direction of Sync back — copy the project's folder on this
// machine into the VM's workdir, the way a create copies it in: the folder's
// files (a repository's tracked and untracked-but-not-ignored ones, any other
// folder's every file), never its .git — and never an env file (envfiles.ts).
// Nothing is committed in the VM: what arrives shows up there as uncommitted
// changes on the project's branch.
//
// Only files whose content differs from the VM's travel, so an unchanged file
// keeps its timestamp (dev servers in the VM do not all reload). A file the
// folder no longer has is left in the VM. What is never overwritten without
// `force` is work in the VM that exists nowhere else: a file with uncommitted
// changes there (or a new one the agent has not committed). The push then
// stops and says which files are in the way.
import { existsSync, lstatSync, readdirSync } from "fs";
import { join } from "path";
import { config } from "../config";
import { logEvent } from "../db";
import { getDriver } from "../driver";
import { LONG_TASK_MS } from "../driver/types";
import { getProject, refFor, syncFolderOf } from "./projects";
import { isEnvFile } from "./envfiles";
import { isGitRepo } from "./sync";

const driver = getDriver();
const WD = config.guestWorkdir;

/** The folder's files, relative to it, as a create would copy them. */
async function folderFiles(folder: string): Promise<string[]> {
  let names: string[];
  if (await isGitRepo(folder)) {
    const ls = Bun.spawn(["git", "-C", folder, "ls-files", "-coz", "--exclude-standard"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(ls.stdout).text();
    if ((await ls.exited) !== 0) throw new Error("git ls-files failed on the folder");
    names = [...new Set(out.split("\0").filter(Boolean))]; // -c and -o can both list a path
  } else {
    names = (readdirSync(folder, { recursive: true }) as string[])
      .filter((n) => n !== ".git" && !n.startsWith(".git/"));
  }
  // tracked but deleted from the folder, or a directory: nothing to copy
  return names.filter((n) => {
    try { const s = lstatSync(join(folder, n)); return s.isFile() || s.isSymbolicLink(); } catch { return false; }
  });
}

/** path → blob id of each regular file listed, read straight from disk. */
function blobIds(stdout: string, paths: string[]): Map<string, string> {
  const ids = stdout.split("\n");
  return new Map(paths.map((p, i) => [p, ids[i]]));
}

// In the VM: blob ids of the listed paths that are regular files there, then
// the workdir's uncommitted paths ("XY path" — renames as add + delete).
const PROBE_SCRIPT =
  `cd ${WD} || exit 1; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; cat > "$tmp/list"; ` +
  `while IFS= read -r f; do if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\\n' "$f"; fi; done < "$tmp/list" > "$tmp/have"; ` +
  `git hash-object --no-filters --stdin-paths < "$tmp/have" | paste - "$tmp/have"; ` +
  `echo @@status; git status --porcelain=v1 -z --untracked-files=all --no-renames | tr '\\0' '\\n'`;

export async function pushProject(id: string, opts?: { force?: boolean }) {
  const p = getProject(id);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  const folder = syncFolderOf(p);
  if (!folder) throw new Error("this project has no local folder to push from — connect one on the project's page");
  if (!existsSync(folder)) throw new Error(`the folder no longer exists: ${folder}`);
  const ref = refFor(p.name);
  if ((await driver.inspect(ref)).state !== "running") throw new Error("start the VM first — the files are copied into it");

  // a name with a line break cannot go through the line-based probe; rare enough to report and skip
  const all = await folderFiles(folder);
  const excluded = all.filter(isEnvFile);
  const skipped = all.filter((n) => !isEnvFile(n) && n.includes("\n"));
  const files = all.filter((n) => !isEnvFile(n) && !n.includes("\n"));
  const regular = files.filter((n) => lstatSync(join(folder, n)).isFile());

  // 1. what each side holds
  const hash = Bun.spawn(["git", "hash-object", "--no-filters", "--stdin-paths"], {
    cwd: folder, stdin: new Blob([regular.map((n) => n + "\n").join("")]), stdout: "pipe", stderr: "pipe",
  });
  const [hashOut, hashErr, hashCode] = await Promise.all([new Response(hash.stdout).text(), new Response(hash.stderr).text(), hash.exited]);
  if (hashCode !== 0) throw new Error(`could not read the folder's files: ${hashErr.trim()}`);
  const here = blobIds(hashOut, regular);

  const probe = await driver.execWithStdin(ref, PROBE_SCRIPT, new TextEncoder().encode(files.map((n) => n + "\n").join("")), { timeoutMs: LONG_TASK_MS });
  const [vmPart, statusPart = ""] = probe.stdout.split("@@status\n");
  if (probe.exitCode !== 0 || !probe.stdout.includes("@@status")) throw new Error(`could not read the VM's workdir: ${probe.stderr.trim() || probe.stdout.trim()}`);
  const there = new Map<string, string>();
  for (const line of vmPart.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) there.set(line.slice(tab + 1), line.slice(0, tab));
  }
  const dirty = new Set(statusPart.split("\n").filter((l) => l.length > 3).map((l) => l.slice(3)));

  // 2. what would change, and what in the VM is in the way. A link is always
  // copied: its target is what matters, and that is not worth a second probe.
  const changed = files.filter((n) => !here.has(n) || here.get(n) !== there.get(n));
  const blocking = changed.filter((n) => dirty.has(n));

  let applied: "copied" | "current" | "not-applied";
  if (!changed.length) applied = "current";
  else if (blocking.length && !opts?.force) applied = "not-applied";
  else {
    // 3. copy them in, as a create does
    const tar = Bun.spawn(["tar", "--no-xattrs", "--null", "-C", folder, "-T", "-", "-cf", "-"], {
      stdin: new Blob([changed.map((n) => n + "\0").join("")]), stdout: "pipe", stderr: "pipe",
    });
    const [bytes, tarErr, tarCode] = await Promise.all([new Response(tar.stdout).bytes(), new Response(tar.stderr).text(), tar.exited]);
    if (tarCode !== 0) throw new Error(`tar failed on the folder: ${tarErr.trim()}`);
    const cp = await driver.execWithStdin(ref, `mkdir -p ${WD} && tar -xf - -C ${WD}`, bytes, { timeoutMs: LONG_TASK_MS });
    if (cp.exitCode !== 0) throw new Error(`copy into the VM failed: ${cp.stderr.trim()}`);
    applied = "copied";
  }

  logEvent(id, "push", `${folder} → VM: ${applied} · ${applied === "copied" ? changed.length : 0} file(s)` +
    (blocking.length && applied === "not-applied" ? ` (${blocking.length} in the way)` : "") +
    (opts?.force && blocking.length ? " (forced)" : ""));
  return {
    folder,
    applied,
    changed: applied === "copied" ? changed : [], // the files written in the VM
    blocking: applied === "not-applied" ? blocking : [], // uncommitted work in the VM — `force` overwrites it
    forced: !!opts?.force && applied === "copied" && blocking.length > 0,
    excluded,      // env files, never pushed
    skipped,       // names this push cannot carry (a line break in them)
  };
}
