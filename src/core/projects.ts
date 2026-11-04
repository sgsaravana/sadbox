import { existsSync, realpathSync, statSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { config } from "../config";
import { encrypt, decrypt } from "../crypto";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { LONG_TASK_MS, type ProjectInfo, type ProjectStats } from "../driver/types";
import { injectVault, setProjectItems, purgeProjectVault } from "./vault";
import { getSettings, validMemoryMB } from "./settings";
import { installGuestProxy, openProjectSocket, closeProjectSocket, redialProjectSocket } from "../net/proxy";
import { forgetGuestTools, startGuestRelay } from "../net/guest";
import { purgeProjectNet } from "../net/rules";
import { clearProjectApprovals } from "../net/approvals";
import { clearProjectFeed } from "../net/events";
import { purgeProjectForwards } from "../net/forwards";
import { purgeProjectLinks } from "../net/links";
import { duringSetup } from "../net/setup";
import { type ToolInfo } from "./toolchain";
import { ensureBaseImage } from "./baseimage";
import { isEnvFile } from "./envfiles";
import { copyOutHistory, historyOf, linkHistory, prepareHistory } from "./history";
import { applyLoginsQuietly, purgeProjectLogins } from "./logins";
import { forgetVitals, liveStats, liveToolchain, QUERY_TIMEOUT_MS } from "./vitals";

const driver = getDriver();

export interface ProjectRow {
  id: string;
  name: string;
  image: string;
  state: string;
  source_path: string;
  source_branch: string | null;
  base_sha: string | null;
  last_synced_sha: string | null;
  apps: string;
  git_remote: string | null;
  git_token_enc: string | null;
  sync_path: string | null;   // local folder connected to a cloned project (sync target only)
  branch: string | null;      // checked out in the VM when last seen (null: never asked)
  memory_mb: number | null;   // the VM's memory (null: created before this was recorded)
  net_cutoff: number;         // 1 = all egress refused by the proxy (see net/cutoff.ts)
  history_mounted: number;    // 1 = agent history is mounted from the store (core/history.ts)
  empty: number;              // 1 = no folder, no remote: an empty workdir to clone into
  error: string | null;
  created_at: string;
}

export interface GitSetup {
  remote: string;
  token?: string;
}

export const refFor = (name: string) => `sadbox-${name}`;
/** The local folder a project's work is synced into: the folder it was created
 *  from, or one connected later to a project cloned from a git URL. */
export const syncFolderOf = (p: Pick<ProjectRow, "source_path" | "sync_path">) => p.source_path || p.sync_path || "";
export const branchFor = (name: string) => `sadbox/${name}`;
/** An empty project: no local folder, no git remote — the VM starts with an
 *  empty workdir, and you clone what you need into it from the terminal (with
 *  the vault's tokens, through the git credential helper — net/guest.ts). */
export const isEmptyProject = (p: Pick<ProjectRow, "empty">) => p.empty === 1;

async function hostGit(repo: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: code === 0 ? out.trim() : err.trim() };
}

async function imageExists(image: string): Promise<boolean> {
  return (await Bun.spawn([config.containerBin, "image", "inspect", image], {
    stdout: "ignore", stderr: "ignore",
  }).exited) === 0;
}

/** The image a new VM boots from: the base image, first brought up to date
 *  with its recipe (so tools added to it since reach the VM). Should that build
 *  fail — offline, say — the image there is still used, and `note` says so. */
async function resolveImage(note: (msg: string) => void): Promise<string> {
  try {
    await ensureBaseImage(note);
  } catch (e) {
    note(`${e instanceof Error ? e.message : e}\nusing the existing image`);
  }
  for (const img of [config.baseImage, ...config.baseImageFallbacks]) {
    if (await imageExists(img)) return img;
  }
  return config.baseImage; // create() will surface a clear error if it's missing
}

/** Tar up the source folder respecting .gitignore (spike B + C recipes):
 *  tracked + untracked-but-not-ignored files, plus .git for full history —
 *  but never an env file, tracked or not (envfiles.ts). Returns the env files
 *  the repository tracks too: missing from the copy, they must be marked so
 *  git in the VM does not take them for deleted (see markEnvFilesSkipped).
 *  The name list is materialized first — tar reads it from stdin (-T -)
 *  while the archive streams out on stdout. */
export async function tarSource(sourcePath: string): Promise<{ bytes: Uint8Array; trackedEnv: string[] }> {
  const ls = async (...args: string[]) => {
    const list = Bun.spawn(["git", "-C", sourcePath, "ls-files", "-z", ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(list.stdout).text();
    if ((await list.exited) !== 0) throw new Error("git ls-files failed on source folder");
    return out.split("\0").filter(Boolean);
  };
  const tracked = await ls("-c");
  const listed = [...new Set([...tracked, ...await ls("-o", "--exclude-standard")])];
  // .git rides in the NUL-separated name list — bsdtar stops option parsing
  // at the first positional arg, so everything must stay an option
  const names = new TextEncoder().encode([...listed.filter((n) => !isEnvFile(n)), ".git"].map((n) => n + "\0").join(""));
  const tar = Bun.spawn(
    ["tar", "--no-xattrs", "--null", "-C", sourcePath, "-T", "-", "-cf", "-"],
    {
      stdin: names,
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  const bytes = await new Response(tar.stdout).bytes();
  if ((await tar.exited) !== 0) throw new Error("tar failed on source folder");
  return { bytes, trackedEnv: tracked.filter(isEnvFile) };
}

/** Env files the repository tracks are left out of the VM's copy. Marked
 *  skip-worktree there, git treats them as unchanged rather than deleted — so
 *  neither a commit in the VM nor a Sync back can delete them from the folder. */
export async function markEnvFilesSkipped(ref: string, paths: string[]) {
  if (!paths.length) return;
  const r = await driver.execWithStdin(ref,
    `cd ${config.guestWorkdir} && git update-index -z --skip-worktree --stdin`,
    new TextEncoder().encode(paths.map((n) => n + "\0").join("")));
  if (r.exitCode !== 0) throw new Error(`could not leave env files out of the VM's git: ${r.stderr.trim()}`);
}

export function listProjects(): ProjectRow[] {
  return db.query<ProjectRow, []>(
    "SELECT * FROM projects WHERE state != 'destroyed' ORDER BY created_at DESC",
  ).all();
}

export function getProject(id: string): ProjectRow | null {
  return db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
}

/** Store an access token via git's credential helper so pushes/pulls/clones
 *  authenticate. The token lives at ~/.git-credentials (0600) inside the VM —
 *  reliable for agent-driven git regardless of shell env — and encrypted on the
 *  host. Written before any clone so private repos can be fetched. */
async function writeGitCredentials(ref: string, url: string, token: string) {
  const host = hostFromUrl(url);
  // credential line matched by protocol+host; username x-access-token works
  // for GitHub PAT/App tokens, and token-as-password works broadly elsewhere
  const credLine = `https://x-access-token:${token}@${host}\n`;
  const write = await driver.execWithStdin(
    ref,
    `umask 077 && cat > ~/.git-credentials && ` +
    `git config --global credential.helper store && ` +
    `git config --global credential.https://${host}.username x-access-token`,
    new TextEncoder().encode(credLine),
  );
  if (write.exitCode !== 0) throw new Error(`git credential setup failed: ${write.stderr}`);
}

/** Point the workdir's `origin` at an external remote and, if a token was
 *  given, store it via git's credential helper so pushes/pulls authenticate. */
async function configureGitRemote(ref: string, project: ProjectRow) {
  if (!project.git_remote) return;
  const url = project.git_remote;
  const setRemote =
    `cd ${config.guestWorkdir} && ` +
    `(git remote get-url origin >/dev/null 2>&1 ` +
    `&& git remote set-url origin ${shellArg(url)} ` +
    `|| git remote add origin ${shellArg(url)})`;
  const r = await driver.exec(ref, ["sh", "-c", setRemote]);
  if (r.exitCode !== 0) throw new Error(`git remote setup failed: ${r.stderr}`);
  if (project.git_token_enc) await writeGitCredentials(ref, url, decrypt(project.git_token_enc));
}

/** Clone an external repo into the guest workdir (the "git only" create mode).
 *  Goes out through the supervisor proxy like everything else — the VM has no
 *  other route — so the proxy env is sourced here and the caller holds the
 *  provisioning window open (nobody is there to approve the clone). Clones to a
 *  temp dir then copies in, so it works even when workdir is a sized volume
 *  with a lost+found.
 *  Returns the cloned default branch + its HEAD (the project's base). */
async function cloneIntoWorkdir(ref: string, url: string, name: string): Promise<{ base: string; branch: string }> {
  const wd = config.guestWorkdir;
  const script =
    `set -e; ` +
    `[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}; ` +
    `tmp=$(mktemp -d); ` +
    `git clone --quiet ${shellArg(url)} "$tmp/repo"; ` +
    `mkdir -p ${wd}; ` +
    `cp -a "$tmp/repo/." ${wd}/; ` +
    `rm -rf "$tmp"; ` +
    `cd ${wd}; ` +
    `git config user.name "sadbox project ${name}"; ` +
    `git config user.email "project@sadbox.local"; ` +
    `defbr=$(git rev-parse --abbrev-ref HEAD); ` +
    `base=$(git rev-parse HEAD); ` +
    `git checkout -q -b ${branchFor(name)}; ` +
    `echo "defbr=$defbr"; echo "base=$base"`;
  const r = await driver.exec(ref, ["sh", "-c", script], { timeoutMs: LONG_TASK_MS });
  if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr || r.stdout}`);
  const info = kv(r.stdout);
  return { base: info.base || "", branch: info.defbr || "HEAD" };
}

/** Append the secrets + proxy env source-hooks to the guest's shells (common to
 *  both create modes). .bashrc for interactive tmux shells, .profile for login. */
async function installShellHooks(ref: string) {
  const r = await driver.exec(ref, ["sh", "-c",
    `for f in ~/.bashrc ~/.profile; do ` +
    `grep -q sadbox/env $f 2>/dev/null || printf 'set -a; [ -f ~/.sadbox/env ] && . ~/.sadbox/env; set +a\\n' >> $f; ` +
    `grep -q sadbox/net.env $f 2>/dev/null || printf '[ -f ~/.sadbox/net.env ] && . ~/.sadbox/net.env\\n' >> $f; ` +
    `done`,
  ]);
  if (r.exitCode !== 0) throw new Error(`shell hook setup failed: ${r.stderr}`);
}

/** Boot and seed the VM for an existing project row, then start tmux. Shared by
 *  create and rebuild: copies in the local folder (or clones the remote),
 *  records the base commit, installs shell hooks + proxy, configures git, apps,
 *  and (re)injects the project's assigned secrets. Idempotent enough to run on a
 *  freshly-destroyed ref, so rebuild is just destroy + provisionVM. */
async function provisionVM(p: ProjectRow, opts: { assignSecretIds?: string[] } = {}) {
  const ref = refFor(p.name);
  const empty = isEmptyProject(p);
  const cloneMode = !p.source_path && !empty; // no local folder → clone the git remote
  const s = getSettings();          // default resource allocation
  // No network interface at all: the VM cannot reach the internet, this
  // machine, the LAN or other VMs — whatever it runs, as whichever user. Its one
  // way out is this project's own socket to the egress proxy.
  const isolated = config.network === "none";
  forgetGuestTools(ref); // a new VM under this name has a fresh filesystem
  const memoryMB = p.memory_mb ?? s.defaultMemoryMB; // the project's own, once it has one
  db.query("UPDATE projects SET memory_mb = ? WHERE id = ?").run(memoryMB, p.id);
  // a new VM starts on its own branch (an empty one on none: its workdir is no repository)
  if (empty) db.query("UPDATE projects SET branch = NULL WHERE id = ?").run(p.id);
  else noteBranch(p.id, branchFor(p.name));
  // the agents' history for this project name, kept on the host (and whatever
  // an earlier project of the same name left there)
  const mounts = prepareHistory(p.name);
  await driver.create(ref, p.image, {
    cpus: s.defaultCpus, memoryMB, diskGB: s.defaultDiskGB, network: config.network,
    socket: isolated ? { host: openProjectSocket(p.id), guest: config.guestCarrierSocket } : undefined,
    mounts,
  });
  db.query("UPDATE projects SET history_mounted = 1 WHERE id = ?").run(p.id);

  // a sized workdir volume mounts root-owned — hand it to the agent user
  if (s.defaultDiskGB) {
    await driver.exec(ref, ["chown", "agent:agent", config.guestWorkdir], { user: "root" });
  }
  await linkHistory(ref);

  // Trust the proxy CA + point the guest's tools at the proxy — before anything
  // below needs the network. For a network-less VM the proxy is the only way
  // out, so one that cannot be wired to it is a failed create. (On the
  // unenforced NAT network it stays best-effort.)
  try {
    await installGuestProxy(ref);
    logEvent(p.id, "proxy.configure", isolated ? "CA installed, egress only via supervisor" : "CA installed, egress routed via supervisor (not enforced)");
  } catch (e) {
    logEvent(p.id, "proxy.configure.error", String(e));
    if (isolated) throw new Error(`could not connect the VM to the egress proxy: ${e instanceof Error ? e.message : e}`);
  }

  if (empty) {
    // nothing to seed: the workdir is where repositories get cloned, and commits
    // in them need an author
    const setup = await driver.exec(ref, ["sh", "-c",
      `mkdir -p ${config.guestWorkdir} && ` +
      `git config --global user.name "sadbox project ${p.name}" && ` +
      `git config --global user.email "project@sadbox.local"`]);
    if (setup.exitCode !== 0) throw new Error(`guest setup failed: ${setup.stderr}`);
    db.query("UPDATE projects SET base_sha = NULL, last_synced_sha = NULL, source_branch = NULL WHERE id = ?").run(p.id);
  } else if (cloneMode) {
    if (!p.git_remote) throw new Error("no git remote to clone from");
    // creds first (private repos), then clone straight into the workdir
    if (p.git_token_enc) await writeGitCredentials(ref, p.git_remote, decrypt(p.git_token_enc));
    const remote = p.git_remote;
    const info = await duringSetup(p.id, () => cloneIntoWorkdir(ref, remote, p.name));
    db.query("UPDATE projects SET base_sha = ?, last_synced_sha = ?, source_branch = ? WHERE id = ?")
      .run(info.base, info.base, info.branch, p.id);
  } else {
    // re-read the local repo's current HEAD so a rebuild picks up new work
    const branch = await hostGit(p.source_path, ["branch", "--show-current"]);
    const head = await hostGit(p.source_path, ["rev-parse", "HEAD"]);
    if (head.code !== 0) throw new Error(`source folder is not a git repository with a commit: ${p.source_path}`);
    db.query("UPDATE projects SET base_sha = ?, last_synced_sha = ?, source_branch = ? WHERE id = ?")
      .run(head.out, head.out, branch.out || "HEAD", p.id);
    const { bytes: tarBytes, trackedEnv } = await tarSource(p.source_path);
    const cp = await driver.execWithStdin(
      ref,
      `mkdir -p ${config.guestWorkdir} && tar -xf - -C ${config.guestWorkdir}`,
      tarBytes,
      { timeoutMs: LONG_TASK_MS },
    );
    if (cp.exitCode !== 0) throw new Error(`copy-in failed: ${cp.stderr}`);
    await markEnvFilesSkipped(ref, trackedEnv);
    const setup = await driver.exec(ref, ["sh", "-c",
      `cd ${config.guestWorkdir} && ` +
      `git config user.name "sadbox project ${p.name}" && ` +
      `git config user.email "project@sadbox.local" && ` +
      `git checkout -q -b ${branchFor(p.name)}`,
    ]);
    if (setup.exitCode !== 0) throw new Error(`guest setup failed: ${setup.stderr}`);
  }

  // secrets + proxy env source-hooks for the guest's shells (both modes)
  await installShellHooks(ref);

  // external git remote + credentials — local mode only; clone mode already has
  // origin (from the clone) and credentials written above.
  if (!cloneMode && !empty) await configureGitRemote(ref, p);

  // The base image is built once and its agents go stale, so bring claude, omp
  // and opencode to their latest releases in every new or rebuilt VM. Best
  // effort (an offline registry must not fail the create), each tool on its own.
  await duringSetup(p.id, async () => {
    const env = `[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}; export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.nvm/current/bin:$PATH"; `;
    const steps: [string, string][] = [
      ["claude", "claude update"],
      ["omp", "bun install -g @oh-my-pi/pi-coding-agent@latest"],
      ["opencode", "bun install -g opencode-ai@latest"],
    ];
    for (const [tool, cmd] of steps) {
      const r = await driver.exec(ref, ["sh", "-c", env + cmd], { timeoutMs: LONG_TASK_MS });
      logEvent(p.id, "agent.update", `${tool}: ${r.exitCode === 0 ? "latest" : `exit ${r.exitCode} ${r.stderr.trim().slice(-200)}`}`);
    }
  });

  // extra apps (best effort — base toolchain is baked into the image). Run as
  // root with the proxy env, inside the provisioning window; the image ships
  // without package lists, so refresh them first.
  const apps = (JSON.parse(p.apps || "[]") as string[])
    .map((a) => a.replace(/[^a-zA-Z0-9._+-]/g, "")).filter(Boolean);
  if (apps.length) {
    const env = `[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}; export DEBIAN_FRONTEND=noninteractive; `;
    await duringSetup(p.id, async () => {
      const up = await driver.exec(ref, ["sh", "-c", env + "apt-get update -qq"], { user: "root", timeoutMs: LONG_TASK_MS });
      if (up.exitCode !== 0) logEvent(p.id, "app.install", `apt-get update: exit ${up.exitCode}`);
      for (const pkg of apps) {
        const r = await driver.exec(ref, ["sh", "-c",
          env + `command -v ${pkg} >/dev/null 2>&1 || apt-get install -y -qq ${pkg}`], { user: "root", timeoutMs: LONG_TASK_MS });
        logEvent(p.id, "app.install", `${pkg}: exit ${r.exitCode}`);
      }
    });
  }

  // assign (create only) then (re)write the env file from whatever's assigned
  if (opts.assignSecretIds?.length) setProjectItems(p.id, opts.assignSecretIds);
  await injectVault(p.id);
  // the agents' logins sadbox keeps (Claude's as placeholders)
  await applyLoginsQuietly(p);

  // tmux starts last so its shells are born with the secrets + proxy env in place
  const tmux = await driver.exec(ref, ["tmux", "new-session", "-d",
    "-s", config.tmuxSession, "-c", config.guestWorkdir]);
  if (tmux.exitCode !== 0) throw new Error(`tmux start failed: ${tmux.stderr}`);
}

export async function createProject(opts: {
  name: string;
  sourcePath?: string;    // omit to create from a git remote (clone-in-VM mode)
  empty?: boolean;        // neither: an empty workdir, to clone into from the terminal
  apps?: string[];
  secretIds?: string[];
  git?: GitSetup;
}): Promise<ProjectRow> {
  const name = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("invalid project name");
  const empty = opts.empty === true;
  const cloneMode = !opts.sourcePath && !empty; // no local folder → clone the git remote in the VM
  if (empty && (opts.sourcePath || opts.git?.remote)) {
    throw new Error("an empty project has no local folder or git remote — clone repositories from its terminal");
  }
  if (opts.git?.remote && !/^https?:\/\//.test(opts.git.remote)) {
    throw new Error("git remote must be an http(s) URL");
  }
  if (empty) {
    // nothing to check: the VM starts with an empty workdir
  } else if (cloneMode) {
    if (!opts.git?.remote) throw new Error("provide a local folder or a git repository URL");
  } else {
    if (!existsSync(opts.sourcePath!)) throw new Error(`source folder not found: ${opts.sourcePath}`);
    // fail fast before booting a VM: the folder must be a git repo with a commit
    const head = await hostGit(opts.sourcePath!, ["rev-parse", "HEAD"]);
    if (head.code !== 0) {
      throw new Error("source folder must be a git repository with at least one commit (v0 limitation)");
    }
  }

  const id = crypto.randomUUID().slice(0, 8);
  const notes: string[] = []; // logged once the project's row exists
  const image = await resolveImage((m) => notes.push(m));
  const gitRemote = opts.git?.remote ?? null;
  const gitTokenEnc = opts.git?.token ? encrypt(opts.git.token) : null;
  // base_sha/source_branch recorded by provisionVM once the workdir is seeded
  db.query(
    `INSERT INTO projects (id, name, image, state, source_path, source_branch, base_sha, last_synced_sha, apps, git_remote, git_token_enc, empty)
     VALUES (?, ?, ?, 'creating', ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).run(id, name, image, opts.sourcePath && !empty ? opts.sourcePath : "",
        JSON.stringify(opts.apps ?? []), gitRemote, gitTokenEnc, empty ? 1 : 0);
  for (const n of notes) logEvent(id, "image", n);
  const earlier = historyOf(name);
  if (earlier) logEvent(id, "history", `agent history of an earlier ${name} mounted (${earlier.tools.map((t) => t.tool).join(", ")}, ${mb(earlier.bytes)})`);
  logEvent(id, "create.start", empty ? `${name}, empty workdir` : cloneMode ? `${name} cloning ${gitRemote}` : `${name} from ${opts.sourcePath}`);

  try {
    await provisionVM(getProject(id)!, { assignSecretIds: opts.secretIds });
    db.query("UPDATE projects SET state = 'running' WHERE id = ?").run(id);
    logEvent(id, "create.done");
  } catch (e) {
    db.query("UPDATE projects SET state = 'error', error = ? WHERE id = ?").run(String(e), id);
    logEvent(id, "create.error", String(e));
    throw e;
  }
  return getProject(id)!;
}

const GUEST_PROBE = [
  'echo "nproc=$(nproc)"',
  "free -b 2>/dev/null | awk '/Mem:/{print \"mem_total=\"$2; print \"mem_used=\"$3}'",
  // df on the workdir mount reflects the sized volume (the disk allocation)
  `df -B1 ${config.guestWorkdir} 2>/dev/null | tail -1 | awk '{print "disk_total="$2; print "disk_used="$3}'`,
  'echo "workdir_bytes=$(du -sb ~/workdir 2>/dev/null | cut -f1)"',
  'echo "tmux_sessions=$(tmux list-sessions 2>/dev/null | wc -l | tr -d \\ )"',
  'echo "tmux_windows=$(tmux list-windows -t main 2>/dev/null | wc -l | tr -d \\ )"',
  'echo "tmux_clients=$(tmux list-clients -t main 2>/dev/null | wc -l | tr -d \\ )"',
  'echo "uptime=$(cut -d. -f1 /proc/uptime)"',
  `cd ${config.guestWorkdir} 2>/dev/null && echo "git_dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d \\ )" && echo "git_branch=$(git branch --show-current 2>/dev/null)"`,
].join("; ");

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Full detail view for one project: DB record + live VM state, resource
 *  usage (incl. CPU %), and in-guest probes (disk, workdir, tmux). Requests for
 *  the same project that overlap share one round of queries. */
export function projectDetails(id: string) {
  let pending = detailsInFlight.get(id);
  if (!pending) {
    pending = loadDetails(id).finally(() => detailsInFlight.delete(id));
    detailsInFlight.set(id, pending);
  }
  return pending;
}
const detailsInFlight = new Map<string, ReturnType<typeof loadDetails>>();

async function loadDetails(id: string) {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  const ref = refFor(p.name);

  const info = await driver.inspect(ref).catch(() => null);
  const running = info?.state === "running";
  const state = settle(p, info);

  let cpuPercent: number | null = null;
  let stats: ProjectStats | null = null;
  let guest: Record<string, string> = {};
  let toolchain: ToolInfo[] | null = null;
  let partial = false; // some readings are still on their way — ask again shortly
  let unresponsive = false; // up as far as the runtime knows, but not answering
  if (running) {
    // only the guest probe is waited for; see vitals.ts for the other two
    const [g, live, tc] = await Promise.all([
      driver.exec(ref, ["sh", "-c", GUEST_PROBE], { timeoutMs: QUERY_TIMEOUT_MS }).catch(() => null),
      liveStats(ref, info?.cpus),
      liveToolchain(ref),
    ]);
    if (g?.exitCode === 0) guest = kv(g.stdout);
    else unresponsive = true;
    ({ stats, cpuPercent } = live);
    toolchain = tc.tools;
    partial = live.pending || tc.pending;
  }

  const num = (v: string | undefined) => (v ? Number(v) : null);
  return {
    id: p.id,
    name: p.name,
    state,
    image: p.image,
    source_path: p.source_path,
    sync_path: p.sync_path,           // folder connected to a cloned project, if any
    sync_folder: syncFolderOf(p),     // where Sync back delivers ('' = nowhere yet)
    empty: isEmptyProject(p),         // no folder, no remote: repositories are cloned in the terminal
    source_branch: p.source_branch,
    workdir: config.guestWorkdir,
    branch: (guest.git_branch && noteBranch(p.id, guest.git_branch)) || getProject(p.id)?.branch || (isEmptyProject(p) ? null : branchFor(p.name)), // what is checked out now
    base_sha: p.base_sha,
    last_synced_sha: p.last_synced_sha,
    apps: JSON.parse(p.apps),
    git_remote: p.git_remote,
    has_git_token: p.git_token_enc != null,
    net_cutoff: p.net_cutoff === 1,
    error: p.error,
    created_at: p.created_at,
    partial,
    unresponsive,
    live: info,
    resources: {
      cpus: info?.cpus ?? null,
      cpuPercent,
      memoryUsageBytes: stats?.memoryUsageBytes ?? null,
      // the runtime's own record (info) lags behind a memory change made here
      memoryLimitBytes: stats?.memoryLimitBytes ?? (p.memory_mb ? p.memory_mb * MB : info?.memoryLimitBytes) ?? null,
      memoryMB: p.memory_mb ?? (info?.memoryLimitBytes ? Math.round(info.memoryLimitBytes / MB) : null),
      numProcesses: stats?.numProcesses ?? null,
      networkRxBytes: stats?.networkRxBytes ?? null,
      networkTxBytes: stats?.networkTxBytes ?? null,
      diskTotalBytes: num(guest.disk_total),
      diskUsedBytes: num(guest.disk_used),
      workdirBytes: num(guest.workdir_bytes),
      uptimeSec: num(guest.uptime),
    },
    toolchain, // installed agents/tools + versions probed from this VM (null if not running)
    tmux: {
      sessions: num(guest.tmux_sessions),
      windows: num(guest.tmux_windows),
      clients: num(guest.tmux_clients), // attached terminal viewers
    },
    git: {
      dirty: num(guest.git_dirty),
      currentBranch: guest.git_branch || null,
    },
  };
}

/** Connect a local folder to a project that was created from a git URL, so its
 *  work can be synced back there (`path: null` disconnects). The folder must be
 *  a git repository; it does not have to be a clone of the same remote, though
 *  a sync is only a few commits when it is. Nothing in the folder is touched
 *  here — or by a sync, which only adds a ref. A Rebuild still re-clones the
 *  remote: this is where work goes, not where the VM comes from. */
export async function connectSyncFolder(id: string, path: string | null) {
  const p = getProject(id);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  if (p.source_path) throw new Error("this project was created from a local folder and already syncs there");
  if (isEmptyProject(p)) throw new Error("an empty project has no repository of its own to sync — push from the repositories you cloned in it");
  if (path == null || !String(path).trim()) {
    db.query("UPDATE projects SET sync_path = NULL WHERE id = ?").run(id);
    await rm(join(config.dataDir, "sync", `${id}.git`), { recursive: true, force: true });
    logEvent(id, "sync.disconnect", p.sync_path ?? "");
    return { sync_path: null, hasBase: null, isGitRepo: null };
  }
  const given = String(path).trim();
  if (!existsSync(given)) throw new Error(`folder not found: ${given}`);
  if (!statSync(given).isDirectory()) throw new Error(`not a folder: ${given}`);
  // inside a git repository the repository is what gets connected; any other
  // folder is connected as it is and simply receives the files
  const top = await hostGit(given, ["rev-parse", "--show-toplevel"]);
  const isRepo = top.code === 0;
  const repo = isRepo ? top.out : realpathSync(given);
  // does it already have the commit the VM started from? (true for a clone of
  // the same remote that is reasonably up to date; n/a for a plain folder)
  const hasBase = !isRepo ? null : p.base_sha != null &&
    (await hostGit(repo, ["cat-file", "-e", `${p.base_sha}^{commit}`])).code === 0;
  // history kept for a previous plain folder describes that folder's files
  await rm(join(config.dataDir, "sync", `${id}.git`), { recursive: true, force: true });
  // start over from the VM's base for this folder: it has received nothing yet
  db.query("UPDATE projects SET sync_path = ?, last_synced_sha = base_sha WHERE id = ?").run(repo, id);
  logEvent(id, "sync.connect", repo);
  return { sync_path: repo, hasBase, isGitRepo: isRepo };
}

/** Give a project an external git remote (origin) after it was created, or
 *  change it or its token. Without a new token the stored one is kept, for the
 *  same host. It is set in the VM's workdir now, so the VM must be running; a
 *  Rebuild sets it again — and for a project cloned from a URL, re-clones the
 *  new one. */
export async function setGitRemote(id: string, git: { remote?: string; token?: string }) {
  const p = getProject(id);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  const remote = String(git.remote ?? "").trim();
  if (!/^https?:\/\//.test(remote)) throw new Error("git remote must be an http(s) URL");
  // (it would also make a Rebuild clone this remote instead of starting empty)
  if (isEmptyProject(p)) throw new Error("an empty project's workdir is not a repository — set the remote in the repository you cloned, from the terminal");
  const ref = refFor(p.name);
  if ((await driver.inspect(ref)).state !== "running") throw new Error("start the VM first — the remote is set inside it");
  const token = git.token?.trim();
  const sameHost = p.git_remote != null && hostFromUrl(p.git_remote) === hostFromUrl(remote);
  const tokenEnc = token ? encrypt(token) : sameHost ? p.git_token_enc : null;
  await configureGitRemote(ref, { ...p, git_remote: remote, git_token_enc: tokenEnc });
  db.query("UPDATE projects SET git_remote = ?, git_token_enc = ? WHERE id = ?").run(remote, tokenEnc, id);
  logEvent(id, "git.remote", `${p.git_remote ? `${p.git_remote} → ` : ""}${remote}${tokenEnc ? " (with token)" : ""}`);
  return { git_remote: remote, has_git_token: tokenEnc != null };
}

/** A VM created before history was mounted keeps its agents' history on its own
 *  disk: copy it into the project's store before the VM goes (research/13, A3).
 *  A stopped VM is booted for it. Throws if the history is there but could not
 *  be copied; a VM that is gone or will not boot is skipped (and logged). */
async function rescueHistory(p: ProjectRow): Promise<void> {
  if (p.history_mounted) return;
  const ref = refFor(p.name);
  const state = (await driver.inspect(ref)).state;
  if (state === "unknown") return; // no VM left to copy from
  let booted = false;
  if (state !== "running") {
    try { await driver.start(ref); booted = true; } catch (e) {
      logEvent(p.id, "history.copyout", `skipped — the VM would not start: ${e instanceof Error ? e.message : e}`);
      return;
    }
  }
  try {
    const n = await copyOutHistory(p.name, ref);
    logEvent(p.id, "history.copyout", n ? `${n} file(s) of agent history copied out of the VM, kept for ${p.name}` : "the VM had no agent history");
  } catch (e) {
    logEvent(p.id, "history.copyout.error", String(e));
    if (booted) await driver.stop(ref).catch(() => {});
    throw new Error(`could not copy the agent history out of the VM first: ${e instanceof Error ? e.message : e}`);
  }
}

export async function destroyProject(id: string): Promise<void> {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  // best effort here: a destroy must always be possible
  await rescueHistory(p).catch(() => {});
  await driver.destroy(refFor(p.name));
  purgeProjectVault(id);   // its vault access and placeholders go; the items stay
  purgeProjectLogins(id);  // …and its login placeholders; the logins stay
  purgeProjectNet(id);     // per-project net rules die with the VM too
  purgeProjectForwards(id); // …and so do its port forwards (frees the host ports)
  purgeProjectLinks(id);    // …and its links, both ways
  await rm(join(config.dataDir, "sync", `${id}.git`), { recursive: true, force: true });
  closeProjectSocket(id);
  clearProjectApprovals(id);
  clearProjectFeed(id);
  forgetVitals(refFor(getProject(id)?.name ?? ""));
  db.query("UPDATE projects SET state = 'destroyed' WHERE id = ?").run(id);
  logEvent(id, "destroy");
}

/** Redeploy a project: destroy its VM and recreate it from the same source
 *  (local folder re-copied, or git remote re-cloned) with the same settings. The
 *  project row, assigned secrets, and net rules are preserved — only the VM is
 *  rebuilt. A local-mode rebuild picks up the folder's current HEAD; a clone-mode
 *  rebuild re-clones the remote. Unsynced work inside the old VM is lost. */
export async function rebuildProject(id: string): Promise<ProjectRow> {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  if (p.state === "destroyed") throw new Error("project has been destroyed");
  const empty = isEmptyProject(p);
  const cloneMode = !p.source_path && !empty;
  if (empty) {
    // starts empty again: what was cloned into the old VM goes with it
  } else if (cloneMode) {
    if (!p.git_remote) throw new Error("this project has no source to rebuild from");
  } else if (!existsSync(p.source_path)) {
    throw new Error(`source folder no longer exists, cannot rebuild: ${p.source_path}`);
  }

  // Rebuild onto the CURRENT base image (not the stale image the project was
  // first created with), built afresh if its recipe has changed, so tools
  // added to the base after this project — e.g. nvm — land in the fresh VM.
  const image = await resolveImage((m) => logEvent(id, "image", m));
  await rescueHistory(p); // an older VM's agent history, before the VM goes
  logEvent(id, "rebuild.start",
    (empty ? "empty workdir" : cloneMode ? `re-clone ${p.git_remote}` : `re-copy ${p.source_path}`) +
    (image !== p.image ? ` · image ${p.image} → ${image}` : ""));
  db.query("UPDATE projects SET state = 'creating', error = NULL, image = ? WHERE id = ?").run(image, id);
  try {
    await driver.destroy(refFor(p.name)); // tear down the old VM; keep row + secrets + rules
    forgetVitals(refFor(p.name));
    clearProjectApprovals(id);
    clearProjectFeed(id);
    await provisionVM(getProject(id)!); // fresh row (current image) → secrets re-injected inside
    db.query("UPDATE projects SET state = 'running' WHERE id = ?").run(id);
    logEvent(id, "rebuild.done");
  } catch (e) {
    db.query("UPDATE projects SET state = 'error', error = ? WHERE id = ?").run(String(e), id);
    logEvent(id, "rebuild.error", String(e));
    throw e;
  }
  return getProject(id)!;
}

/** Merge live driver state into DB rows for the UI. Degrades to DB-only
 *  rows when the driver is unavailable (e.g. supervisor in a container). */
// ---- stop / start -----------------------------------------------------------
// A project's VM can be shut down and booted again without losing anything on
// its disk (the workdir, installed packages, agent logins); only what was
// running in it — tmux, the agents — ends. A VM also stops on its own account:
// the machine restarts, the container service is restarted, someone runs
// `container stop`. So the recorded state follows what the VM is actually doing.

const changing = new Set<string>(); // projects with a stop/start under way

/** Bring a project's recorded state in line with its VM (given what the driver
 *  reports for it; nothing is changed without a report). Returns the state. */
function settle(p: ProjectRow, info: ProjectInfo | null | undefined): string {
  if (changing.has(p.id) || !info || info.state === "unknown") return p.state;
  // a stop/start that never finished (the supervisor went away) is settled too
  if (!["running", "stopped", "starting", "stopping"].includes(p.state) || p.state === info.state) return p.state;
  logEvent(p.id, info.state === "running" ? "vm.running" : "vm.stopped", "noticed — changed outside sadbox");
  if (info.state === "running" && p.state === "stopped") {
    // booted by hand: it has no proxy relay or tmux yet — finish the start
    startProject(p.id).catch(() => {});
    return "starting";
  }
  db.query("UPDATE projects SET state = ? WHERE id = ?").run(info.state, p.id);
  if (info.state !== "running") forgetVitals(info.ref);
  return info.state;
}

export async function stopProject(id: string): Promise<ProjectRow> {
  const p = getProject(id);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  if (changing.has(id) || p.state === "creating") throw new Error("this project is busy — try again in a moment");
  const ref = refFor(p.name);
  changing.add(id);
  db.query("UPDATE projects SET state = 'stopping' WHERE id = ?").run(id);
  try {
    await driver.stop(ref);
    db.query("UPDATE projects SET state = 'stopped' WHERE id = ?").run(id);
    logEvent(id, "vm.stop");
  } catch (e) {
    db.query("UPDATE projects SET state = ? WHERE id = ?").run(p.state, id);
    logEvent(id, "vm.stop.error", String(e));
    throw e;
  } finally {
    changing.delete(id);
    forgetVitals(ref);
  }
  return getProject(id)!;
}

/** Boot a project's stopped VM and put back what does not survive a shutdown:
 *  the proxy relay (its only way out), current secrets, and the tmux session.
 *  Also safe on a VM that is already up — it just repairs those. */
export async function startProject(id: string): Promise<ProjectRow> {
  const p = getProject(id);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  if (changing.has(id) || p.state === "creating") throw new Error("this project is busy — try again in a moment");
  const ref = refFor(p.name);
  const before = await driver.inspect(ref);
  if (before.state === "unknown") {
    throw new Error("this project's VM no longer exists — use Rebuild to recreate it from its source");
  }
  changing.add(id);
  db.query("UPDATE projects SET state = 'starting', error = NULL WHERE id = ?").run(id);
  try {
    if (before.state !== "running") await driver.start(ref);
    // booted is not yet answering: wait until a command gets through
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      up = (await driver.exec(ref, ["sh", "-c", `test -d ${config.guestWorkdir}`], { timeoutMs: 5_000 })).exitCode === 0;
      if (!up) await Bun.sleep(500);
    }
    if (!up) throw new Error("the VM started but is not responding");

    if ((await driver.inspect(ref)).isolated) {
      openProjectSocket(id);
      await startGuestRelay(ref);
      redialProjectSocket(id); // carriers dialed before the shutdown are dead
    }
    await injectVault(id).catch((e) => logEvent(id, "vault.inject.error", String(e)));
    await applyLoginsQuietly(p);
    const tmux = await driver.exec(ref, ["sh", "-c",
      `tmux has-session -t ${config.tmuxSession} 2>/dev/null || ` +
      `tmux new-session -d -s ${config.tmuxSession} -c ${config.guestWorkdir}`]);
    if (tmux.exitCode !== 0) throw new Error(`tmux start failed: ${tmux.stderr}`);
    db.query("UPDATE projects SET state = 'running' WHERE id = ?").run(id);
    logEvent(id, "vm.start");
  } catch (e) {
    const now = await driver.inspect(ref).catch(() => null);
    db.query("UPDATE projects SET state = ? WHERE id = ?").run(now?.state === "running" ? "running" : "stopped", id);
    logEvent(id, "vm.start.error", String(e));
    throw e;
  } finally {
    changing.delete(id);
    forgetVitals(ref);
  }
  return getProject(id)!;
}

const MB = 1024 * 1024;

/** Give a project's VM a different amount of memory. A VM takes its size when
 *  it boots, so a running one is shut down and started again: what was running
 *  in it (agents, terminals) ends, everything on its disk stays. A stopped VM
 *  just boots with the new size next time. */
export async function setProjectMemory(id: string, memory: unknown) {
  const memoryMB = validMemoryMB(memory);
  const p = getProject(id);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  if (changing.has(id) || !["running", "stopped"].includes(p.state)) throw new Error("this project is busy — try again in a moment");
  const ref = refFor(p.name);
  const before = await driver.inspect(ref);
  if (before.state === "unknown") throw new Error("this project's VM no longer exists — use Rebuild to recreate it from its source");

  const wasRunning = before.state === "running";
  if (wasRunning) await stopProject(id);
  try {
    await driver.setMemory(ref, memoryMB);
    db.query("UPDATE projects SET memory_mb = ? WHERE id = ?").run(memoryMB, id);
  } finally {
    // back up either way — with the new size, or as it was
    if (wasRunning) await startProject(id);
  }

  // ask the VM itself: null when it is stopped or does not say
  let applied: boolean | null = null;
  if (wasRunning) {
    const limit = (await driver.stats(ref, QUERY_TIMEOUT_MS).catch(() => null))?.memoryLimitBytes;
    if (limit != null) applied = limit === memoryMB * MB;
  }
  logEvent(id, "vm.memory", `${memoryMB} MB` + (wasRunning ? " · restarted" : "") + (applied === false ? " · the VM still reports its old size" : ""));
  return { id, state: getProject(id)!.state, memoryMB, restarted: wasRunning, applied };
}

// The branch each VM has checked out, for the projects list. Asking a VM costs
// an exec, so it is asked at most every few seconds; the answer is kept in the
// database, so a stopped VM — or a restarted supervisor — still shows the last one.
const BRANCH_TTL_MS = 5000;
const branchAsked = new Map<string, { at: number; asking?: Promise<void> }>();
/** Record the branch a VM has checked out, whoever found out. Returns it. */
export function noteBranch(id: string, branch: string): string {
  db.query("UPDATE projects SET branch = ? WHERE id = ? AND branch IS NOT ?").run(branch, id, branch);
  const e = branchAsked.get(id);
  if (e) e.at = Date.now(); else branchAsked.set(id, { at: Date.now() });
  return branch;
}
async function liveBranch(p: ProjectRow, running: boolean): Promise<string | null> {
  let e = branchAsked.get(p.id);
  if (running && (!e || Date.now() - e.at > BRANCH_TTL_MS)) {
    const first = !e;
    if (!e) branchAsked.set(p.id, (e = { at: 0 }));
    const entry = e;
    entry.asking ??= driver.exec(refFor(p.name), ["sh", "-c",
      `cd ${config.guestWorkdir} && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ` +
      `{ git symbolic-ref -q --short HEAD || echo "detached at $(git rev-parse --short HEAD)"; }`], { timeoutMs: 4000 })
      .then((r) => { if (r.exitCode === 0 && r.stdout.trim()) noteBranch(p.id, r.stdout.trim()); else entry.at = Date.now(); })
      .catch(() => {})
      .finally(() => { entry.asking = undefined; });
    // with nothing recorded yet the answer is worth a short wait; otherwise the last one serves while it refreshes
    if (first && !p.branch) await Promise.race([entry.asking, new Promise((r) => setTimeout(r, 1500))]);
  }
  return getProject(p.id)?.branch ?? (isEmptyProject(p) ? null : branchFor(p.name));
}

export async function projectsWithLiveState() {
  const rows = listProjects();
  const live = new Map(
    (await driver.list().catch(() => [])).map((w) => [w.ref, w]),
  );
  const current = await Promise.all(rows.map((r) => liveBranch(r, settle(r, live.get(refFor(r.name))) === "running")));
  return rows.map((r, i) => ({
    branch: current[i],
    id: r.id,
    name: r.name,
    image: r.image,
    state: settle(r, live.get(refFor(r.name))),
    source_path: r.source_path,
    sync_folder: syncFolderOf(r),
    empty: isEmptyProject(r),
    source_branch: r.source_branch,
    git_remote: r.git_remote,
    has_git_token: r.git_token_enc != null,
    error: r.error,
    created_at: r.created_at,
    apps: JSON.parse(r.apps),
    live: live.get(refFor(r.name)) ?? null,
  }));
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

function shellArg(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").split("/")[0]; }
}
