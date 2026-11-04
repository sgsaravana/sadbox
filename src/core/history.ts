// Agent conversation history kept by the supervisor, per project name
// (docs/research/13, A1–A3). Each project's store is a host folder,
// ~/.sadbox/agents/history/<project-name>/<tool>/…, mounted into the VM when
// it is created, so a project destroyed and recreated under the same name gets
// its history back. One VM per name exists at a time, so every store has a
// single writer — SQLite in it stays safe.
//
// A VM cannot mount anything itself (no mount rights in the guest), so the
// mounts are fixed when it is created:
//   - folders, and Claude's history.jsonl (which Claude opens O_NOFOLLOW, so a
//     symlink would break it), are mounted straight onto the tool's own path;
//   - SQLite files (omp, opencode) are symlinked into a mounted folder, so
//     their -wal / -shm files land in the store beside them (SQLite follows
//     the link; checked in a VM, 2026-11-04).
//
// A VM from before this has its history on its own disk: the first Rebuild
// (or a Destroy) copies it out into the store first (A3).
import { lstatSync, mkdirSync, readdirSync, writeFileSync, appendFileSync, copyFileSync, rmSync, existsSync, readFileSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { config } from "../config";
import { getDriver } from "../driver";
import { LONG_TASK_MS } from "../driver/types";

export const HISTORY_TOOLS = ["claude", "omp", "opencode"] as const;
export type HistoryTool = (typeof HISTORY_TOOLS)[number];

interface Spot {
  tool: HistoryTool;
  /** Where the tool keeps it, under the VM user's home. */
  guest: string;
  /** Where it is kept in the project's store. */
  store: string;
  kind: "dir" | "file" | "sqlite";
}

// Seen in a VM, 2026-11-03/04 (research/13, "Where each tool keeps things").
// Logins sit next to these (.credentials.json, agent.db, auth.json) and are
// deliberately left out — they are step 6's business.
const SPOTS: Spot[] = [
  { tool: "claude", guest: ".claude/projects", store: "claude/projects", kind: "dir" },         // transcripts, per cwd
  { tool: "claude", guest: ".claude/file-history", store: "claude/file-history", kind: "dir" }, // what /rewind restores
  { tool: "claude", guest: ".claude/history.jsonl", store: "claude/history.jsonl", kind: "file" }, // prompt history
  { tool: "omp", guest: ".omp/agent/sessions", store: "omp/sessions", kind: "dir" },
  { tool: "omp", guest: ".omp/agent/history.db", store: "omp/db/history.db", kind: "sqlite" },
  { tool: "opencode", guest: ".local/share/opencode/opencode.db", store: "opencode/db/opencode.db", kind: "sqlite" },
  { tool: "opencode", guest: ".local/share/opencode/snapshot", store: "opencode/snapshot", kind: "dir" },
];
const SQLITE_SIDES = ["", "-wal", "-shm"];
/** Where a tool's folder of SQLite files is mounted in the VM. */
const sqliteMount = (tool: HistoryTool) => `${config.guestHome}/.sadbox/history/${tool}`;

export const historyRoot = () => join(config.dataDir, "agents", "history");

function storeDir(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`not a project name: ${name}`);
  return join(historyRoot(), name);
}

/** A path in the store must be exactly what is expected — never a symlink.
 *  The store is written by a VM; a symlink planted there (or carried in by a
 *  copy-out) and then used as a mount source would hand the VM that part of
 *  this machine. */
function ensure(path: string, kind: "dir" | "file") {
  let st;
  try { st = lstatSync(path); } catch {
    if (kind === "dir") mkdirSync(path); else writeFileSync(path, "");
    return;
  }
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) {
    throw new Error(`agent history store: ${path} is not a plain ${kind === "dir" ? "folder" : "file"} — remove it and try again`);
  }
}
function ensureTree(path: string) {
  // every folder from the data dir down, checked one at a time
  const parts = path.slice(config.dataDir.length).split("/").filter(Boolean);
  mkdirSync(config.dataDir, { recursive: true });
  let at = config.dataDir;
  for (const part of parts) ensure(at = join(at, part), "dir");
}

export interface Mount { host: string; guest: string }

/** Make the project's store (if new) and return what to mount into its VM. */
export function prepareHistory(name: string): Mount[] {
  const root = storeDir(name);
  ensureTree(root);
  const mounts: Mount[] = [];
  const sqliteDirs = new Set<HistoryTool>();
  for (const s of SPOTS) {
    if (s.kind === "sqlite") {
      ensureTree(join(root, dirname(s.store)));
      if (!sqliteDirs.has(s.tool)) mounts.push({ host: join(root, dirname(s.store)), guest: sqliteMount(s.tool) });
      sqliteDirs.add(s.tool);
      continue;
    }
    ensureTree(join(root, dirname(s.store)));
    ensure(join(root, s.store), s.kind);
    mounts.push({ host: join(root, s.store), guest: `${config.guestHome}/${s.guest}` });
  }
  return mounts;
}

/** After the VM is created: hand the folders the runtime made for the mount
 *  points to the VM user (it makes them root-owned), and link the SQLite files
 *  into their mounted folder. */
export async function linkHistory(ref: string): Promise<void> {
  const h = config.guestHome;
  const parents = new Set<string>();
  const mountPoints = [...SPOTS.filter((s) => s.kind !== "sqlite").map((s) => `${h}/${s.guest}`), ...HISTORY_TOOLS.map(sqliteMount)];
  for (const m of mountPoints) for (let d = dirname(m); d.startsWith(`${h}/`); d = dirname(d)) parents.add(d);
  const own = await getDriver().exec(ref, ["sh", "-c",
    `for d in ${[...parents].sort().map(q).join(" ")}; do [ -d "$d" ] && [ ! -L "$d" ] && chown ${config.guestUser}:${config.guestUser} "$d"; done; true`],
    { user: "root" });
  if (own.exitCode !== 0) throw new Error(`agent history: could not prepare the VM's folders: ${own.stderr.trim()}`);
  const links = SPOTS.filter((s) => s.kind === "sqlite").map((s) =>
    `mkdir -p ${q(dirname(`${h}/${s.guest}`))} && ln -sfn ${q(`${sqliteMount(s.tool)}/${s.store.split("/").pop()}`)} ${q(`${h}/${s.guest}`)}`);
  const ln = await getDriver().exec(ref, ["sh", "-c", links.join(" && ")]);
  if (ln.exitCode !== 0) throw new Error(`agent history: could not link the SQLite files: ${ln.stderr.trim()}`);
}

/** Copy a VM's history from its own disk into the store: for a VM created
 *  before history was mounted, before it is destroyed. The VM must be running.
 *  Its agents are stopped first (tmux ends), so no SQLite file is mid-write.
 *  What is in the store already is kept; the VM's copy of a file wins, and
 *  Claude's prompt history is appended. Returns how many files were copied. */
export async function copyOutHistory(name: string, ref: string): Promise<number> {
  const root = storeDir(name);
  const paths = SPOTS.flatMap((s) => s.kind === "sqlite" ? SQLITE_SIDES.map((x) => s.guest + x) : [s.guest]);
  const driver = getDriver();
  await driver.exec(ref, ["tmux", "kill-server"]).catch(() => {}); // the agents with it
  // only what is really there and not a link — a link would be stored as one
  const r = await driver.execCaptureBytes(ref,
    `cd ${q(config.guestHome)} && set -- && for f in ${paths.map(q).join(" ")}; do ` +
    `[ -e "$f" ] && [ ! -L "$f" ] && set -- "$@" "$f"; done; ` +
    `if [ $# -gt 0 ]; then tar -cf - "$@"; fi`,
    { timeoutMs: LONG_TASK_MS });
  if (r.exitCode !== 0) throw new Error(`could not read the VM's agent history (exit ${r.exitCode})`);
  if (!r.stdout.length) return 0;

  const tmp = await mkdtemp(join(tmpdir(), "sadbox-history-"));
  try {
    await writeFile(join(tmp, "h.tar"), r.stdout);
    mkdirSync(join(tmp, "x"));
    // bsdtar refuses absolute paths, `..` and extracting through a symlink by default
    const x = Bun.spawnSync(["tar", "-xf", join(tmp, "h.tar"), "-C", join(tmp, "x")], { stderr: "pipe" });
    if (x.exitCode !== 0) throw new Error(`could not unpack the VM's agent history: ${x.stderr.toString().trim()}`);
    ensureTree(root);
    let copied = 0;
    for (const s of SPOTS) {
      const from = join(tmp, "x", s.guest);
      const to = join(root, s.store);
      ensureTree(dirname(to));
      if (s.kind === "dir") {
        if (isDir(from)) { ensure(to, "dir"); copied += copyTree(from, to); }
      } else if (s.kind === "file") {
        if (!isFile(from)) continue;
        ensure(to, "file");
        const had = readFileSync(to);
        const add = readFileSync(from);
        // the VM's lines after whatever an earlier project of this name left
        if (had.length && !had.equals(add)) appendFileSync(to, (had.at(-1) === 0x0a ? "" : "\n") + add.toString("utf8"));
        else writeFileSync(to, add);
        copied++;
      } else if (isFile(from)) {
        // a database and its -wal / -shm belong together: replace the set
        for (const side of SQLITE_SIDES) rmSync(to + side, { force: true });
        for (const side of SQLITE_SIDES) if (isFile(from + side)) { copyFileSync(from + side, to + side); copied++; }
      }
    }
    return copied;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const isDir = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { return lstatSync(p).isFile(); } catch { return false; } };

/** Plain files and folders only — links and anything else are left behind. */
function copyTree(from: string, to: string): number {
  let n = 0;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) {
      if (existsSync(b) && !isDir(b)) rmSync(b, { recursive: true, force: true });
      ensure(b, "dir");
      n += copyTree(a, b);
    } else if (e.isFile()) {
      if (existsSync(b) && !isFile(b)) rmSync(b, { recursive: true, force: true });
      copyFileSync(a, b);
      n++;
    }
  }
  return n;
}

function sizeOf(path: string): { bytes: number; latest: number } {
  let bytes = 0, latest = 0;
  const walk = (p: string) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    latest = Math.max(latest, st.mtimeMs);
    if (st.isDirectory()) { for (const e of readdirSync(p)) walk(join(p, e)); }
    else if (st.isFile()) bytes += st.size;
  };
  walk(path);
  return { bytes, latest };
}

export interface HistoryView {
  name: string;
  bytes: number;
  /** When anything in it last changed (ISO), or null when empty. */
  updatedAt: string | null;
  tools: { tool: HistoryTool; bytes: number }[];
}

/** The stores there are, with their size — empty ones count as none. */
export function listHistory(): HistoryView[] {
  let names: string[] = [];
  try { names = readdirSync(historyRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  return names.filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)).sort().map(historyOf).filter((h): h is HistoryView => h !== null);
}

export function historyOf(name: string): HistoryView | null {
  const root = storeDir(name);
  if (!isDir(root)) return null;
  let latest = 0;
  const tools = HISTORY_TOOLS.map((tool) => {
    const s = sizeOf(join(root, tool));
    if (s.bytes) latest = Math.max(latest, s.latest);
    return { tool, bytes: s.bytes };
  }).filter((t) => t.bytes > 0);
  const bytes = tools.reduce((a, t) => a + t.bytes, 0);
  if (!bytes) return null;
  return { name, bytes, updatedAt: new Date(latest).toISOString(), tools };
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
