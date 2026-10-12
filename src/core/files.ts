// Workdir file access for the browser editor. Like the terminal, it needs no
// daemon in the guest: every operation is a short shell snippet run over
// `exec`, with file bytes on stdin/stdout. Paths are always relative to the
// project's workdir and are normalized on the host before they reach a shell.
import { posix } from "path";
import { config } from "../config";
import { getDriver } from "../driver";
import { getProject, refFor } from "./projects";

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
    `[ -e "$f" ] || [ -L "$f" ] || exit 3; rm -rf -- "$f"`]);
  if (r.exitCode === 3) throw new FileError(`no such file: ${rel}`, 404);
  if (r.exitCode !== 0) throw new FileError(`could not delete: ${r.stderr.trim()}`, 502);
  return { path: rel };
}
