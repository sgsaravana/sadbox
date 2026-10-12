import { existsSync } from "fs";
import { config } from "../config";
import { encrypt, decrypt } from "../crypto";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import type { ProjectStats } from "../driver/types";
import { injectSecrets, assignSecrets, purgeProjectSecrets } from "./secrets";
import { getSettings } from "./settings";
import { installGuestProxy, openProjectSocket, closeProjectSocket } from "../net/proxy";
import { forgetGuestTools } from "../net/guest";
import { purgeProjectNet } from "../net/rules";
import { clearProjectApprovals } from "../net/approvals";
import { clearProjectFeed } from "../net/events";
import { purgeProjectForwards } from "../net/forwards";
import { duringSetup } from "../net/setup";
import { type ToolInfo } from "./toolchain";
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

async function resolveImage(): Promise<string> {
  for (const img of [config.baseImage, ...config.baseImageFallbacks]) {
    if (await imageExists(img)) return img;
  }
  return config.baseImage; // create() will surface a clear error if it's missing
}

/** Tar up the source folder respecting .gitignore (spike B + C recipes):
 *  tracked + untracked-but-not-ignored files, plus .git for full history.
 *  The name list is materialized first — tar reads it from stdin (-T -)
 *  while the archive streams out on stdout. */
async function tarSource(sourcePath: string): Promise<Uint8Array> {
  const list = Bun.spawn(["git", "-C", sourcePath, "ls-files", "-coz", "--exclude-standard"], {
    stdout: "pipe", stderr: "ignore",
  });
  const listed = await new Response(list.stdout).bytes();
  if ((await list.exited) !== 0) throw new Error("git ls-files failed on source folder");
  // .git rides in the NUL-separated name list — bsdtar stops option parsing
  // at the first positional arg, so everything must stay an option
  const names = new Uint8Array(listed.length + 5);
  names.set(listed);
  names.set(new TextEncoder().encode(".git\0"), listed.length);
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
  return bytes;
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
  const r = await driver.exec(ref, ["sh", "-c", script]);
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
  const cloneMode = !p.source_path; // no local folder → clone the git remote
  const s = getSettings();          // default resource allocation
  // No network interface at all: the VM cannot reach the internet, this
  // machine, the LAN or other VMs — whatever it runs, as whichever user. Its one
  // way out is this project's own socket to the egress proxy.
  const isolated = config.network === "none";
  forgetGuestTools(ref); // a new VM under this name has a fresh filesystem
  await driver.create(ref, p.image, {
    cpus: s.defaultCpus, memoryMB: s.defaultMemoryMB, diskGB: s.defaultDiskGB, network: config.network,
    socket: isolated ? { host: openProjectSocket(p.id), guest: config.guestCarrierSocket } : undefined,
  });

  // a sized workdir volume mounts root-owned — hand it to the agent user
  if (s.defaultDiskGB) {
    await driver.exec(ref, ["chown", "agent:agent", config.guestWorkdir], { user: "root" });
  }

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

  if (cloneMode) {
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
    const tarBytes = await tarSource(p.source_path);
    const cp = await driver.execWithStdin(
      ref,
      `mkdir -p ${config.guestWorkdir} && tar -xf - -C ${config.guestWorkdir}`,
      tarBytes,
    );
    if (cp.exitCode !== 0) throw new Error(`copy-in failed: ${cp.stderr}`);
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
  if (!cloneMode) await configureGitRemote(ref, p);

  // extra apps (best effort — base toolchain is baked into the image). Run as
  // root with the proxy env, inside the provisioning window; the image ships
  // without package lists, so refresh them first.
  const apps = (JSON.parse(p.apps || "[]") as string[])
    .map((a) => a.replace(/[^a-zA-Z0-9._+-]/g, "")).filter(Boolean);
  if (apps.length) {
    const env = `[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}; export DEBIAN_FRONTEND=noninteractive; `;
    await duringSetup(p.id, async () => {
      const up = await driver.exec(ref, ["sh", "-c", env + "apt-get update -qq"], { user: "root" });
      if (up.exitCode !== 0) logEvent(p.id, "app.install", `apt-get update: exit ${up.exitCode}`);
      for (const pkg of apps) {
        const r = await driver.exec(ref, ["sh", "-c",
          env + `command -v ${pkg} >/dev/null 2>&1 || apt-get install -y -qq ${pkg}`], { user: "root" });
        logEvent(p.id, "app.install", `${pkg}: exit ${r.exitCode}`);
      }
    });
  }

  // assign (create only) then (re)write the env file from whatever's assigned
  if (opts.assignSecretIds?.length) assignSecrets(p.id, opts.assignSecretIds);
  await injectSecrets(p.id);

  // tmux starts last so its shells are born with the secrets + proxy env in place
  const tmux = await driver.exec(ref, ["tmux", "new-session", "-d",
    "-s", config.tmuxSession, "-c", config.guestWorkdir]);
  if (tmux.exitCode !== 0) throw new Error(`tmux start failed: ${tmux.stderr}`);
}

export async function createProject(opts: {
  name: string;
  sourcePath?: string;    // omit to create from a git remote (clone-in-VM mode)
  apps?: string[];
  secretIds?: string[];
  git?: GitSetup;
}): Promise<ProjectRow> {
  const name = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("invalid project name");
  const cloneMode = !opts.sourcePath; // no local folder → clone the git remote in the VM
  if (opts.git?.remote && !/^https?:\/\//.test(opts.git.remote)) {
    throw new Error("git remote must be an http(s) URL");
  }
  if (cloneMode) {
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
  const image = await resolveImage();
  const gitRemote = opts.git?.remote ?? null;
  const gitTokenEnc = opts.git?.token ? encrypt(opts.git.token) : null;
  // base_sha/source_branch recorded by provisionVM once the workdir is seeded
  db.query(
    `INSERT INTO projects (id, name, image, state, source_path, source_branch, base_sha, last_synced_sha, apps, git_remote, git_token_enc)
     VALUES (?, ?, ?, 'creating', ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(id, name, image, cloneMode ? "" : opts.sourcePath!,
        JSON.stringify(opts.apps ?? []), gitRemote, gitTokenEnc);
  logEvent(id, "create.start", cloneMode ? `${name} cloning ${gitRemote}` : `${name} from ${opts.sourcePath}`);

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

  let cpuPercent: number | null = null;
  let stats: ProjectStats | null = null;
  let guest: Record<string, string> = {};
  let toolchain: ToolInfo[] | null = null;
  let partial = false; // some readings are still on their way — ask again shortly
  if (running) {
    // only the guest probe is waited for; see vitals.ts for the other two
    const [g, live, tc] = await Promise.all([
      driver.exec(ref, ["sh", "-c", GUEST_PROBE], { timeoutMs: QUERY_TIMEOUT_MS }).catch(() => null),
      liveStats(ref, info?.cpus),
      liveToolchain(ref),
    ]);
    if (g?.exitCode === 0) guest = kv(g.stdout);
    ({ stats, cpuPercent } = live);
    toolchain = tc.tools;
    partial = live.pending || tc.pending;
  }

  const num = (v: string | undefined) => (v ? Number(v) : null);
  return {
    id: p.id,
    name: p.name,
    state: p.state,
    image: p.image,
    source_path: p.source_path,
    sync_path: p.sync_path,           // folder connected to a cloned project, if any
    sync_folder: syncFolderOf(p),     // where Sync back delivers ('' = nowhere yet)
    source_branch: p.source_branch,
    workdir: config.guestWorkdir,
    branch: branchFor(p.name),
    base_sha: p.base_sha,
    last_synced_sha: p.last_synced_sha,
    apps: JSON.parse(p.apps),
    git_remote: p.git_remote,
    has_git_token: p.git_token_enc != null,
    error: p.error,
    created_at: p.created_at,
    partial,
    live: info,
    resources: {
      cpus: info?.cpus ?? null,
      cpuPercent,
      memoryUsageBytes: stats?.memoryUsageBytes ?? null,
      memoryLimitBytes: stats?.memoryLimitBytes ?? info?.memoryLimitBytes ?? null,
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
  if (path == null || !String(path).trim()) {
    db.query("UPDATE projects SET sync_path = NULL WHERE id = ?").run(id);
    logEvent(id, "sync.disconnect", p.sync_path ?? "");
    return { sync_path: null, hasBase: null };
  }
  const given = String(path).trim();
  if (!existsSync(given)) throw new Error(`folder not found: ${given}`);
  const top = await hostGit(given, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("that folder is not a git repository — run `git init` in it (or clone the repo there) first");
  const repo = top.out;
  // does it already have the commit the VM started from? (true for a clone of
  // the same remote that is reasonably up to date)
  const hasBase = p.base_sha != null &&
    (await hostGit(repo, ["cat-file", "-e", `${p.base_sha}^{commit}`])).code === 0;
  // start over from the VM's base for this folder: it has received nothing yet
  db.query("UPDATE projects SET sync_path = ?, last_synced_sha = base_sha WHERE id = ?").run(repo, id);
  logEvent(id, "sync.connect", repo);
  return { sync_path: repo, hasBase };
}

export async function destroyProject(id: string): Promise<void> {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  await driver.destroy(refFor(p.name));
  purgeProjectSecrets(id); // project-specific secrets die with the VM
  purgeProjectNet(id);     // per-project net rules die with the VM too
  purgeProjectForwards(id); // …and so do its port forwards (frees the host ports)
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
  const cloneMode = !p.source_path;
  if (cloneMode) {
    if (!p.git_remote) throw new Error("this project has no source to rebuild from");
  } else if (!existsSync(p.source_path)) {
    throw new Error(`source folder no longer exists, cannot rebuild: ${p.source_path}`);
  }

  // Rebuild onto the CURRENT base image (not the stale image the project was
  // first created with) so newly-baked tools — e.g. opencode added to the base
  // after this project — land in the fresh VM.
  const image = await resolveImage();
  logEvent(id, "rebuild.start",
    (cloneMode ? `re-clone ${p.git_remote}` : `re-copy ${p.source_path}`) +
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
export async function projectsWithLiveState() {
  const rows = listProjects();
  const live = new Map(
    (await driver.list().catch(() => [])).map((w) => [w.ref, w]),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    image: r.image,
    state: r.state,
    source_path: r.source_path,
    sync_folder: syncFolderOf(r),
    source_branch: r.source_branch,
    git_remote: r.git_remote,
    has_git_token: r.git_token_enc != null,
    error: r.error,
    created_at: r.created_at,
    apps: JSON.parse(r.apps),
    live: live.get(refFor(r.name)) ?? null,
  }));
}

function shellArg(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").split("/")[0]; }
}
