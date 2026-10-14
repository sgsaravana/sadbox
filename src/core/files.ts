// Workdir file access for the browser editor. Like the terminal, it needs no
// daemon in the guest: every operation is a short shell snippet run over
// `exec`, with file bytes on stdin/stdout. Paths are always relative to the
// project's workdir and are normalized on the host before they reach a shell.
import { posix } from "path";
import { config } from "../config";
import { getDriver } from "../driver";
import { LONG_TASK_MS } from "../driver/types";
import { getProject, noteBranch, refFor } from "./projects";

const driver = getDriver();

/** Largest file the editor will open or save. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_FILES = 20_000;

export class FileError extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface DirEntry { name: string; type: "dir" | "file" | "other" }

function refOf(projectId: string): string {
  const p = getProject(projectId);
  if (!p || p.state === "destroyed") throw new FileError("project not found", 404);
  return refFor(p.name);
}

/** Normalize a client path to one relative to the workdir ("" = the workdir
 *  itself). Anything that would climb out of it is refused. */
export function cleanPath(raw: unknown): string {
  if (typeof raw !== "string") throw new FileError("path is required");
  if (raw.includes("\0")) throw new FileError("invalid path");
  const norm = posix.normalize("/" + raw.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
  if (norm === ".." || norm.startsWith("../")) throw new FileError("path escapes the workdir");
  return norm;
}

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
/** `cd` into the workdir and bind $f to the (quoted, ./-prefixed) target. */
const prelude = (rel: string) => `cd ${config.guestWorkdir} || exit 2; f=${q("./" + rel)}; `;
/** sha256 of "$f", hex only. */
const SHA = `{ if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } < "$f" | cut -d' ' -f1`;

export const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export async function listDir(projectId: string, rawPath: unknown): Promise<{ path: string; entries: DirEntry[] }> {
  const ref = refOf(projectId);
  const rel = cleanPath(rawPath ?? "");
  // portable sh rather than GNU find -printf; NUL-separated so any name survives
  const r = await driver.execCaptureBytes(ref, prelude(rel) +
    `cd "$f" 2>/dev/null || exit 3; ` +
    `for e in .* *; do ` +
    `[ "$e" = . ] || [ "$e" = .. ] && continue; ` +
    `[ -e "$e" ] || [ -L "$e" ] || continue; ` +
    `if [ -d "$e" ]; then t=d; elif [ -f "$e" ]; then t=f; else t=o; fi; ` +
    `printf '%s\\t%s\\0' "$t" "$e"; done`);
  if (r.exitCode === 3) throw new FileError(`not a directory: ${rel || "/"}`, 404);
  if (r.exitCode !== 0) throw new FileError("could not list the directory (is the VM running?)", 502);
  const entries: DirEntry[] = new TextDecoder().decode(r.stdout).split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const t = line.slice(0, tab);
    return { name: line.slice(tab + 1), type: t === "d" ? "dir" : t === "f" ? "file" : "other" };
  });
  entries.sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
  return { path: rel, entries };
}

/** Every file git would track or add (so ignored build output and .git stay
 *  out) — the list behind the editor's quick-open. */
export async function fileIndex(projectId: string): Promise<{ files: string[]; truncated: boolean }> {
  const ref = refOf(projectId);
  const r = await driver.execCaptureBytes(ref,
    `cd ${config.guestWorkdir} || exit 2; git ls-files -co --exclude-standard -z`);
  if (r.exitCode !== 0) throw new FileError("could not index the workdir (is the VM running?)", 502);
  const all = new TextDecoder().decode(r.stdout).split("\0").filter(Boolean);
  return { files: all.slice(0, MAX_INDEX_FILES), truncated: all.length > MAX_INDEX_FILES };
}

export type GitState = "new" | "modified" | "deleted" | "renamed" | "conflict" | "ignored";

/** What git says about the workdir, for colouring the editor's file tree:
 *  path → state, against the last commit (staged or not makes no difference —
 *  a new file is "new" until it is committed, a changed one "modified"). A
 *  folder git reports as a whole — untracked or ignored, nothing inside it
 *  known — is listed under `dirs`; everything in it shares its state.
 *  `staged` lists the files with something in the index: "all" when every
 *  change to the file is staged, "some" when more is waiting in the workdir.
 *  `branch` is the one checked out (null: detached), `upstream` what it
 *  tracks, `ahead`/`behind` how far apart they are, and `remote` whether there
 *  is an `origin` to push to.
 *  `repo: false` when the workdir is not a git repository. */
export async function gitStatus(projectId: string): Promise<{
  repo: boolean; files: Record<string, GitState>; dirs: Record<string, GitState>;
  staged: Record<string, "all" | "some">;
  branch: string | null; upstream: string | null; ahead: number; behind: number; remote: boolean;
}> {
  const ref = refOf(projectId);
  const r = await driver.execCaptureBytes(ref,
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    `if git remote get-url origin >/dev/null 2>&1; then printf 'R1\\0'; else printf 'R0\\0'; fi; ` +
    `git status --porcelain=v1 -z --ignored --branch 2>/dev/null`);
  const head = { branch: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, remote: false };
  if (r.exitCode === 3) return { repo: false, files: {}, dirs: {}, staged: {}, ...head };
  if (r.exitCode !== 0) throw new FileError("could not read the git status (is the VM running?)", 502);
  const files: Record<string, GitState> = {};
  const dirs: Record<string, GitState> = {};
  const staged: Record<string, "all" | "some"> = {};
  // records are "XY path", NUL-separated; a rename is followed by its old path
  const recs = new TextDecoder().decode(r.stdout).split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec === "R1") head.remote = true;
    if (rec.startsWith("## ")) {
      // "## main...origin/main [ahead 1, behind 2]" · "## main" · "## No commits yet on main" · "## HEAD (no branch)"
      const m = rec.slice(3).match(/^(?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
      if (m && m[1] !== "HEAD (no branch)") {
        head.branch = m[1]; head.upstream = m[2] ?? null;
        head.ahead = Number(m[3]?.match(/ahead (\d+)/)?.[1] ?? 0);
        head.behind = Number(m[3]?.match(/behind (\d+)/)?.[1] ?? 0);
        if (m[3] === "gone") head.upstream = null;
      }
      continue;
    }
    if (rec.length < 4) continue;
    const x = rec[0], y = rec[1], path = rec.slice(3);
    if (x === "R" || x === "C") i++; // skip the path it came from
    const state: GitState =
      x === "?" ? "new" :
      x === "!" ? "ignored" :
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D") ? "conflict" :
      x === "A" || y === "A" || x === "C" ? "new" :
      x === "D" || y === "D" ? "deleted" :
      x === "R" ? "renamed" : "modified";
    if (path.endsWith("/")) dirs[path.slice(0, -1)] = state;
    else files[path] = state;
    if (state !== "conflict" && x !== " " && x !== "?" && x !== "!") staged[path] = y === " " ? "all" : "some";
  }
  return { repo: true, files, dirs, staged, ...head };
}

export async function readFile(projectId: string, rawPath: unknown) {
  const ref = refOf(projectId);
  const rel = cleanPath(rawPath);
  if (!rel) throw new FileError("path is required");
  const r = await driver.execCaptureBytes(ref, prelude(rel) +
    `[ -f "$f" ] || exit 3; ` +
    `[ "$(wc -c < "$f")" -le ${MAX_FILE_BYTES} ] || exit 4; ` +
    `cat -- "$f"`);
  if (r.exitCode === 3) throw new FileError(`no such file: ${rel}`, 404);
  if (r.exitCode === 4) throw new FileError(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB — open it in the terminal instead`, 413);
  if (r.exitCode !== 0) throw new FileError("could not read the file (is the VM running?)", 502);
  let content: string;
  try {
    if (r.stdout.subarray(0, 8192).includes(0)) throw new Error("binary");
    content = new TextDecoder("utf-8", { fatal: true }).decode(r.stdout);
  } catch {
    // saving would re-encode as UTF-8 and corrupt it, so don't offer it for editing
    throw new FileError("binary or non-UTF-8 file — not editable here", 415, { binary: true });
  }
  return { path: rel, content, hash: sha256(r.stdout), size: r.stdout.length };
}

/** The file as of the last commit \u2014 what the editor measures a buffer against
 *  to mark its changed lines \u2014 and as staged, which tells it which of those
 *  changes are already in the index. `content` is null when there is nothing to
 *  compare with: the workdir is not a repository (`repo: false`), the file is
 *  not in the last commit (`inHead: false` \u2014 all of it is new), or the
 *  committed version is not text the editor could show. `index` likewise for
 *  the staged version; `indexOid` names it (null: not in the index, or in
 *  conflict), for stageFile to check nothing moved in between. */
export async function headFile(projectId: string, rawPath: unknown): Promise<{
  path: string; repo: boolean; inHead: boolean; content: string | null;
  inIndex: boolean; indexOid: string | null; index: string | null;
}> {
  const ref = refOf(projectId);
  const rel = cleanPath(rawPath);
  if (!rel) throw new FileError("path is required");
  // one header line \u2014 "<HEAD blob> <size> <index blob> <size>", "-" for none \u2014
  // then the HEAD blob, then the index blob when it is a different one
  const r = await driver.execCaptureBytes(ref, prelude(rel) +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    `h=$(git rev-parse -q --verify "HEAD:$f" 2>/dev/null) && [ "$(git cat-file -t "$h")" = blob ] || h=-; ` +
    `i=$(git rev-parse -q --verify ":$f" 2>/dev/null) || i=-; ` +
    `hs=0; [ $h = - ] || hs=$(git cat-file -s $h); is=0; [ $i = - ] || is=$(git cat-file -s $i); ` +
    `printf '%s %s %s %s\\n' $h $hs $i $is; ` +
    `[ $h = - ] || [ $hs -gt ${MAX_FILE_BYTES} ] || git cat-file blob $h; ` +
    `[ $i = - ] || [ $i = $h ] || [ $is -gt ${MAX_FILE_BYTES} ] || git cat-file blob $i; exit 0`);
  const none = { path: rel, repo: false, inHead: false, content: null, inIndex: false, indexOid: null, index: null };
  if (r.exitCode === 3) return none;
  const nl = r.stdout.indexOf(10);
  if (r.exitCode !== 0 || nl < 0) throw new FileError("could not read the committed version (is the VM running?)", 502);
  const [h, hs, i, is] = new TextDecoder().decode(r.stdout.subarray(0, nl)).split(" ");
  const text = (bytes: Uint8Array): string | null => {
    try {
      if (!bytes.subarray(0, 8192).includes(0)) return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {}
    return null;
  };
  const inHead = h !== "-", inIndex = i !== "-";
  const hLen = inHead && +hs <= MAX_FILE_BYTES ? +hs : -1;
  const content = hLen < 0 ? null : text(r.stdout.subarray(nl + 1, nl + 1 + hLen));
  const index = !inIndex ? null : i === h ? content
    : +is > MAX_FILE_BYTES ? null : text(r.stdout.subarray(nl + 1 + Math.max(hLen, 0)));
  return { path: rel, repo: true, inHead, content, inIndex, indexOid: inIndex ? i : null, index };
}

/** Set what is staged for one file \u2014 how the editor stages and unstages single
 *  hunks: it works out the text the index should hold and sends all of it.
 *  `content: null` puts the index entry back as last committed (nothing staged;
 *  a file not yet committed leaves the index). The file in the workdir is not
 *  touched. `expect` is the indexOid the editor computed from (null: not in
 *  the index); if the index has moved since, 409. */
export async function stageFile(
  projectId: string, rawPath: unknown, content: unknown, expect?: unknown,
): Promise<{ path: string; indexOid: string | null }> {
  const ref = refOf(projectId);
  const rel = cleanPath(rawPath);
  if (!rel) throw new FileError("path is required");
  if (content !== null && typeof content !== "string") throw new FileError("content must be a string or null");
  const bytes = new TextEncoder().encode(content ?? "");
  if (bytes.length > MAX_FILE_BYTES) throw new FileError("file is too large to stage from the editor", 413);
  let want: string;
  if (expect === undefined) want = "any";
  else if (expect === null) want = "-";
  else if (typeof expect === "string" && /^[0-9a-f]{40,64}$/.test(expect)) want = expect;
  else throw new FileError("invalid expect");

  const set = content === null
    ? `if git rev-parse -q --verify HEAD >/dev/null 2>&1; then git reset -q -- "$f"; ` +
      `else git rm -q --cached --ignore-unmatch -- "$f"; fi || exit 6; `
    : `[ -d "$f" ] && exit 5; ` +
      `mode=$(git ls-files -s -- "$f" | head -n 1 | cut -d' ' -f1); ` +
      `[ -n "$mode" ] || { if [ -x "$f" ]; then mode=100755; else mode=100644; fi; }; ` +
      `oid=$(git hash-object -w --stdin --path "$f") && ` +
      `git update-index --add --cacheinfo "$mode,$oid,$(git rev-parse --show-prefix)"${q(rel)} || exit 6; `;
  const r = await driver.execWithStdin(ref, prelude(rel) +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    `cur=$(git rev-parse -q --verify ":$f" 2>/dev/null) || cur=-; ` +
    `[ ${want} = any ] || [ "$cur" = ${want} ] || exit 9; ` +
    set +
    `git rev-parse -q --verify ":$f" 2>/dev/null || echo -`, bytes);
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode === 5) throw new FileError(`${rel} is a directory`, 409);
  if (r.exitCode === 9) throw new FileError(`what is staged for ${rel} changed in the VM — try again`, 409, { conflict: true });
  if (r.exitCode !== 0) throw new FileError(`could not stage: ${r.stderr.trim() || "is the VM running?"}`, 502);
  const oid = r.stdout.trim().split("\n").pop() ?? "-";
  return { path: rel, indexOid: /^[0-9a-f]{40,64}$/.test(oid) ? oid : null };
}

/** Stage (`on`) or unstage whole files or folders — everything about them:
 *  edits, new files, deletions. `paths: "all"` is the whole workdir. */
export async function stagePaths(projectId: string, paths: unknown, on: unknown): Promise<{ ok: true }> {
  const ref = refOf(projectId);
  let spec = "";
  let input = new Uint8Array();
  if (paths !== "all") {
    if (!Array.isArray(paths) || !paths.length) throw new FileError("paths must be a list of paths, or \"all\"");
    const rels = paths.map(cleanPath);
    if (rels.some((r) => !r)) throw new FileError("path is required");
    input = new TextEncoder().encode(rels.map((r) => "./" + r).join("\0"));
    spec = " --pathspec-from-file=- --pathspec-file-nul";
  }
  // --literal-pathspecs: a name with * or [ in it means that file, not a pattern
  const g = "git --literal-pathspecs";
  const r = await driver.execWithStdin(ref,
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    (on === true
      ? `${g} add -A${spec || " ."}`
      : `if git rev-parse -q --verify HEAD >/dev/null 2>&1; then ${g} reset -q${spec}; ` +
        `else ${g} rm -r -q --cached --ignore-unmatch${spec || " ."}; fi`) +
    ` || exit 6`, input);
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode !== 0) throw new FileError(`could not ${on === true ? "stage" : "unstage"}: ${r.stderr.trim() || "is the VM running?"}`, 502);
  return { ok: true };
}

/** Commit what is staged, on the VM's current branch, as the VM's own git
 *  identity. Nothing staged is a 409 — the editor never commits "everything".
 *  `amend` rewrites the last commit instead: what is staged is added to it and
 *  the message replaced (so with nothing staged it only rewords). */
export async function commitStaged(
  projectId: string, message: unknown, opts: { amend?: boolean } = {},
): Promise<{ sha: string; subject: string; amended: boolean }> {
  const ref = refOf(projectId);
  if (typeof message !== "string" || !message.trim()) throw new FileError("a commit message is required");
  if (message.length > 20_000) throw new FileError("commit message is too long");
  const amend = opts.amend === true;
  const r = await driver.execWithStdin(ref,
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    (amend
      ? `git rev-parse -q --verify HEAD >/dev/null 2>&1 || exit 5; ` +
        `git commit -q --amend --cleanup=strip -F - >&2 || exit 6; `
      : `git diff --cached --quiet && exit 4; ` +
        `git commit -q --cleanup=strip -F - >&2 || exit 6; `) +
    `git log -1 --format='%h %s'`, new TextEncoder().encode(message.trim() + "\n"), { timeoutMs: LONG_TASK_MS });
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode === 4) throw new FileError("nothing is staged — stage the changes to commit first", 409);
  if (r.exitCode === 5) throw new FileError("there is no commit to amend yet", 409);
  if (r.exitCode !== 0) throw new FileError(`could not commit: ${r.stderr.trim() || "is the VM running?"}`, 502);
  const line = r.stdout.trim();
  const sp = line.indexOf(" ");
  return { sha: line.slice(0, sp), subject: line.slice(sp + 1), amended: amend };
}

/** The last commit — its message is what "amend" starts from. */
export async function lastCommit(projectId: string): Promise<{ sha: string | null; message: string }> {
  const ref = refOf(projectId);
  const r = await driver.exec(ref, ["sh", "-c",
    `cd ${config.guestWorkdir} || exit 2; git log -1 --format='%h%n%B' 2>/dev/null || exit 3`]);
  if (r.exitCode === 2) throw new FileError("could not read the last commit (is the VM running?)", 502);
  if (r.exitCode !== 0) return { sha: null, message: "" };
  const nl = r.stdout.indexOf("\n");
  return { sha: r.stdout.slice(0, nl), message: r.stdout.slice(nl + 1).trim() };
}

/** Push the VM's current branch to its `origin` — from inside the VM, with the
 *  credentials it has, through the proxy like any other request it makes.
 *  A push the remote rejects because it has moved on is a 409 with
 *  `rejected: true`; `force` retries it with --force-with-lease. */
export async function pushBranch(
  projectId: string, opts: { force?: boolean } = {},
): Promise<{ branch: string; forced: boolean; output: string }> {
  const ref = refOf(projectId);
  const forced = opts.force === true;
  const r = await driver.exec(ref, ["sh", "-c",
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    `git remote get-url origin >/dev/null 2>&1 || exit 4; ` +
    `b=$(git symbolic-ref -q --short HEAD) || exit 5; ` +
    `echo "$b"; ` +
    `GIT_TERMINAL_PROMPT=0 git push${forced ? " --force-with-lease" : ""} -u origin "$b" 2>&1 || exit 6`],
    { timeoutMs: LONG_TASK_MS });
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode === 4) throw new FileError("this project has no git remote to push to", 409);
  if (r.exitCode === 5) throw new FileError("no branch is checked out in the VM", 409);
  const nl = r.stdout.indexOf("\n");
  const branch = nl < 0 ? "" : r.stdout.slice(0, nl);
  const output = nl < 0 ? "" : r.stdout.slice(nl + 1).trim();
  if (r.exitCode === 6) {
    const rejected = /\[rejected\]|non-fast-forward|fetch first|stale info/.test(output);
    throw new FileError(rejected
      ? `the remote has commits ${branch} does not (or the pushed commit was amended)`
      : `push failed: ${output.split("\n").slice(-3).join(" ") || "no output"}`, rejected ? 409 : 502, { rejected, output });
  }
  if (r.exitCode !== 0) throw new FileError("could not push (is the VM running?)", 502);
  return { branch, forced, output };
}

/** The branches the VM could switch to: its own, and the ones on `origin` it
 *  has no local branch for yet (`remote: true` — switching creates one that
 *  tracks it). */
export async function listBranches(projectId: string): Promise<{
  current: string | null; branches: { name: string; remote: boolean }[];
}> {
  const ref = refOf(projectId);
  const r = await driver.exec(ref, ["sh", "-c",
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    `echo "$(git symbolic-ref -q --short HEAD)"; ` +
    `git for-each-ref --sort=-committerdate --format='%(refname)' refs/heads refs/remotes/origin`]);
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode !== 0) throw new FileError("could not list the branches (is the VM running?)", 502);
  const [cur, ...refs] = r.stdout.split("\n");
  const local = refs.filter((x) => x.startsWith("refs/heads/")).map((x) => x.slice(11));
  const remote = refs.filter((x) => x.startsWith("refs/remotes/origin/")).map((x) => x.slice(20))
    .filter((n) => n !== "HEAD" && !local.includes(n));
  return {
    current: cur || null,
    branches: [...local.map((name) => ({ name, remote: false })), ...remote.map((name) => ({ name, remote: true }))],
  };
}

/** Check out another branch in the VM, or (`create`) start a new one from where
 *  it is now. Uncommitted changes come along, as with `git switch`; when they
 *  would be overwritten git refuses, and so does this (409, with git's words). */
export async function switchBranch(
  projectId: string, rawName: unknown, opts: { create?: boolean } = {},
): Promise<{ branch: string; created: boolean }> {
  const ref = refOf(projectId);
  if (typeof rawName !== "string") throw new FileError("a branch name is required");
  const name = rawName.trim();
  if (!name || name.startsWith("-") || /[\0\n]/.test(name)) throw new FileError("invalid branch name");
  const created = opts.create === true;
  const r = await driver.exec(ref, ["sh", "-c",
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` +
    `git check-ref-format --branch ${q(name)} >/dev/null 2>&1 || exit 4; ` +
    `git switch -q ${created ? "-c " : ""}${q(name)} 2>&1 || exit 6`], { timeoutMs: LONG_TASK_MS });
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode === 4) throw new FileError(`not a valid branch name: ${name}`);
  if (r.exitCode === 6) {
    const why = r.stdout.trim().replace(/^(error|fatal): /gm, "").replace(/\s+/g, " ");
    throw new FileError(why || `could not switch to ${name}`, 409, { output: r.stdout });
  }
  if (r.exitCode !== 0) throw new FileError("could not switch branches (is the VM running?)", 502);
  noteBranch(projectId, name); // the projects list shows it
  return { branch: name, created };
}

/** Throw away uncommitted changes — staged or not — to these files or folders:
 *  a committed file goes back to how it was committed, a new one is deleted.
 *  `paths: "all"` is every change in the workdir. Ignored files are never
 *  touched. There is no undo. */
export async function discardPaths(projectId: string, paths: unknown): Promise<{ ok: true }> {
  const ref = refOf(projectId);
  let script: string;
  let input = new Uint8Array();
  if (paths === "all") {
    script =
      `if git rev-parse -q --verify HEAD >/dev/null 2>&1; then git reset -q --hard HEAD; ` +
      `else git rm -r -q -f --cached --ignore-unmatch .; fi && git clean -fdq`;
  } else {
    if (!Array.isArray(paths) || !paths.length) throw new FileError("paths must be a list of paths, or \"all\"");
    const rels = paths.map(cleanPath);
    if (rels.some((r) => !r)) throw new FileError("path is required");
    input = new TextEncoder().encode(rels.map((r) => "./" + r + "\n").join(""));
    if (rels.some((r) => r.includes("\n"))) throw new FileError("invalid path");
    // per path: unstage; then back to the commit if it is in it, else remove it
    script =
      `head=0; git rev-parse -q --verify HEAD >/dev/null 2>&1 && head=1; ` +
      `while IFS= read -r f; do ` +
      `if [ $head = 1 ]; then git --literal-pathspecs reset -q -- "$f" || exit 6; ` +
      `else git --literal-pathspecs rm -r -q -f --cached --ignore-unmatch -- "$f" || exit 6; fi; ` +
      `if [ $head = 1 ] && [ -n "$(git --literal-pathspecs ls-tree -r --name-only HEAD -- "$f" | head -n 1)" ]; then ` +
      `git --literal-pathspecs checkout -q HEAD -- "$f" || exit 6; fi; ` +
      `git --literal-pathspecs clean -fdq -- "$f" || exit 6; ` +
      `done`;
  }
  const r = await driver.execWithStdin(ref,
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` + script + ` || exit 6`, input);
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode !== 0) throw new FileError(`could not discard: ${r.stderr.trim() || "is the VM running?"}`, 502);
  return { ok: true };
}

/** The stashes in the VM, newest first. */
export async function listStashes(projectId: string): Promise<{ stashes: { index: number; message: string }[] }> {
  const ref = refOf(projectId);
  const r = await driver.exec(ref, ["sh", "-c",
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; git stash list --format=%gs`]);
  if (r.exitCode === 3) return { stashes: [] };
  if (r.exitCode !== 0) throw new FileError("could not list the stashes (is the VM running?)", 502);
  return { stashes: r.stdout.split("\n").filter(Boolean).map((message, index) => ({ index, message })) };
}

/** Stash: `push` puts every uncommitted change (new files too) away and leaves
 *  the workdir as last committed; `pop` brings stash `index` back and removes
 *  it — kept, with a 409, if it does not apply cleanly; `drop` deletes it. */
export async function stash(
  projectId: string, action: unknown, opts: { index?: unknown; message?: unknown } = {},
): Promise<{ ok: true }> {
  const ref = refOf(projectId);
  let cmd: string;
  if (action === "push") {
    const msg = typeof opts.message === "string" ? opts.message.trim().replace(/\s+/g, " ").slice(0, 200) : "";
    cmd = `[ -n "$(git status --porcelain | head -n 1)" ] || exit 4; git stash push -q -u${msg ? ` -m ${q(msg)}` : ""} 2>&1 || exit 6`;
  } else if (action === "pop" || action === "drop") {
    if (!Number.isInteger(opts.index) || (opts.index as number) < 0) throw new FileError("a stash index is required");
    cmd = `git rev-parse -q --verify 'stash@{${opts.index}}' >/dev/null 2>&1 || exit 5; ` +
      `git stash ${action} -q 'stash@{${opts.index}}' 2>&1 || exit 6`;
  } else throw new FileError("action must be push, pop or drop");
  const r = await driver.exec(ref, ["sh", "-c",
    `cd ${config.guestWorkdir} || exit 2; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ` + cmd], { timeoutMs: LONG_TASK_MS });
  if (r.exitCode === 3) throw new FileError("the workdir is not a git repository", 409);
  if (r.exitCode === 4) throw new FileError("there are no changes to stash", 409);
  if (r.exitCode === 5) throw new FileError("that stash no longer exists", 409);
  if (r.exitCode === 6) {
    const why = r.stdout.trim().replace(/^(error|fatal): /gm, "").replace(/\s+/g, " ");
    throw new FileError(why || `could not ${action} the stash`, 409, { output: r.stdout });
  }
  if (r.exitCode !== 0) throw new FileError("could not reach the VM's git (is the VM running?)", 502);
  return { ok: true };
}

/** Save a file. `baseHash` is the hash the editor loaded (or null for a file it
 *  believes is new); if the file in the VM no longer matches — the agent edited
 *  it meanwhile — the save is refused with 409 unless `force` is set. The check
 *  and the write happen in one guest command, so nothing can slip in between
 *  on the host side. Written in place, keeping the file's mode and inode. */
export async function writeFile(
  projectId: string, rawPath: unknown, content: unknown,
  opts: { baseHash?: string | null; force?: boolean } = {},
): Promise<{ path: string; hash: string; size: number }> {
  const ref = refOf(projectId);
  const rel = cleanPath(rawPath);
  if (!rel) throw new FileError("path is required");
  if (typeof content !== "string") throw new FileError("content must be a string");
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MAX_FILE_BYTES) throw new FileError("file is too large to save from the editor", 413);

  let expect: string;
  if (opts.force) expect = "any";
  else if (opts.baseHash == null) expect = "none";
  else if (/^[0-9a-f]{64}$/.test(opts.baseHash)) expect = opts.baseHash;
  else throw new FileError("invalid baseHash");

  const r = await driver.execWithStdin(ref, prelude(rel) +
    `[ -d "$f" ] && exit 5; ` +
    `if [ -e "$f" ]; then cur=$(${SHA}); else cur=none; fi; ` +
    `[ ${expect} = any ] || [ "$cur" = ${expect} ] || exit 9; ` +
    `mkdir -p "$(dirname "$f")" && cat > "$f"`, bytes);
  if (r.exitCode === 5) throw new FileError(`${rel} is a directory`, 409);
  if (r.exitCode === 9) {
    throw new FileError(
      expect === "none" ? `${rel} already exists` : `${rel} changed in the VM since you opened it`,
      409, { conflict: true });
  }
  if (r.exitCode !== 0) throw new FileError(`could not save: ${r.stderr.trim() || "is the VM running?"}`, 502);
  return { path: rel, hash: sha256(bytes), size: bytes.length };
}

export async function makeDir(projectId: string, rawPath: unknown): Promise<{ path: string }> {
  const ref = refOf(projectId);
  const rel = cleanPath(rawPath);
  if (!rel) throw new FileError("path is required");
  const r = await driver.exec(ref, ["sh", "-c", prelude(rel) + `[ -e "$f" ] && exit 6; mkdir -p "$f"`]);
  if (r.exitCode === 6) throw new FileError(`${rel} already exists`, 409);
  if (r.exitCode !== 0) throw new FileError(`could not create the folder: ${r.stderr.trim()}`, 502);
  return { path: rel };
}

export async function renamePath(projectId: string, rawFrom: unknown, rawTo: unknown): Promise<{ from: string; to: string }> {
  const ref = refOf(projectId);
  const from = cleanPath(rawFrom), to = cleanPath(rawTo);
  if (!from || !to) throw new FileError("both paths are required");
  if (to === from || to.startsWith(from + "/")) throw new FileError("cannot move a path into itself");
  const r = await driver.exec(ref, ["sh", "-c", prelude(from) + `t=${q("./" + to)}; ` +
    `[ -e "$f" ] || [ -L "$f" ] || exit 3; [ -e "$t" ] && exit 6; ` +
    `mkdir -p "$(dirname "$t")" && mv -- "$f" "$t"`]);
  if (r.exitCode === 3) throw new FileError(`no such file: ${from}`, 404);
  if (r.exitCode === 6) throw new FileError(`${to} already exists`, 409);
  if (r.exitCode !== 0) throw new FileError(`could not rename: ${r.stderr.trim()}`, 502);
  return { from, to };
}

export async function deletePath(projectId: string, rawPath: unknown): Promise<{ path: string }> {
  const ref = refOf(projectId);
  const rel = cleanPath(rawPath);
  if (!rel) throw new FileError("refusing to delete the workdir itself");
  const r = await driver.exec(ref, ["sh", "-c", prelude(rel) +
    `[ -e "$f" ] || [ -L "$f" ] || exit 3; rm -rf -- "$f"`], { timeoutMs: LONG_TASK_MS }); // a big tree takes a while
  if (r.exitCode === 3) throw new FileError(`no such file: ${rel}`, 404);
  if (r.exitCode !== 0) throw new FileError(`could not delete: ${r.stderr.trim()}`, 502);
  return { path: rel };
}
