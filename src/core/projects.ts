import { existsSync } from "fs";
import { config } from "../config";
import { encrypt, decrypt } from "../crypto";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { injectSecrets, assignSecrets, purgeProjectSecrets } from "./secrets";
import { getSettings } from "./settings";

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
  error: string | null;
  created_at: string;
}

export interface GitSetup {
  remote: string;
  token?: string;
}

export const refFor = (name: string) => `sadbox-${name}`;
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

/** Point the workdir's `origin` at an external remote and, if a token was
 *  given, store it via git's credential helper so pushes/pulls authenticate.
 *  The token lives at ~/.git-credentials (0600) inside the VM — reliable for
 *  agent-driven git regardless of shell env — and encrypted on the host. */
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

  if (project.git_token_enc) {
    const token = decrypt(project.git_token_enc);
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
}

export async function createProject(opts: {
  name: string;
  sourcePath: string;
  apps?: string[];
  secretIds?: string[];
  git?: GitSetup;
}): Promise<ProjectRow> {
  const name = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("invalid project name");
  if (!existsSync(opts.sourcePath)) throw new Error(`source folder not found: ${opts.sourcePath}`);
  if (opts.git?.remote && !/^https?:\/\//.test(opts.git.remote)) {
    throw new Error("git remote must be an http(s) URL");
  }

  const branch = await hostGit(opts.sourcePath, ["branch", "--show-current"]);
  const head = await hostGit(opts.sourcePath, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    throw new Error("source folder must be a git repository with at least one commit (v0 limitation)");
  }

  const id = crypto.randomUUID().slice(0, 8);
  const image = await resolveImage();
  const gitRemote = opts.git?.remote ?? null;
  const gitTokenEnc = opts.git?.token ? encrypt(opts.git.token) : null;
  db.query(
    `INSERT INTO projects (id, name, image, state, source_path, source_branch, base_sha, last_synced_sha, apps, git_remote, git_token_enc)
     VALUES (?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, image, opts.sourcePath, branch.out || "HEAD", head.out, head.out,
        JSON.stringify(opts.apps ?? []), gitRemote, gitTokenEnc);
  logEvent(id, "create.start", `${name} from ${opts.sourcePath}`);

  try {
    const ref = refFor(name);
    const s = getSettings(); // default resource allocation for new VMs
    await driver.create(ref, image, {
      cpus: s.defaultCpus, memoryMB: s.defaultMemoryMB, diskGB: s.defaultDiskGB,
    });

    // a sized workdir volume mounts root-owned — hand it to the agent user
    if (s.defaultDiskGB) {
      await driver.exec(ref, ["chown", "agent:agent", config.guestWorkdir], { user: "root" });
    }

    // copy-in
    const tarBytes = await tarSource(opts.sourcePath);
    const cp = await driver.execWithStdin(
      ref,
      `mkdir -p ${config.guestWorkdir} && tar -xf - -C ${config.guestWorkdir}`,
      tarBytes,
    );
    if (cp.exitCode !== 0) throw new Error(`copy-in failed: ${cp.stderr}`);

    // git identity + project branch + shell env hooks
    const setup = await driver.exec(ref, ["sh", "-c",
      `cd ${config.guestWorkdir} && ` +
      `git config user.name "sadbox project ${name}" && ` +
      `git config user.email "project@sadbox.local" && ` +
      `git checkout -q -b ${branchFor(name)} && ` +
      // .bashrc for interactive (tmux) shells, .profile for login/non-interactive —
      // Debian's stock .bashrc returns early when non-interactive
      `for f in ~/.bashrc ~/.profile; do grep -q sadbox/env $f 2>/dev/null || printf 'set -a; [ -f ~/.sadbox/env ] && . ~/.sadbox/env; set +a\\n' >> $f; done`,
    ]);
    if (setup.exitCode !== 0) throw new Error(`guest setup failed: ${setup.stderr}`);

    // external git remote + credentials (optional)
    await configureGitRemote(ref, getProject(id)!);

    // extra apps (best effort — base toolchain is baked into the image)
    for (const app of opts.apps ?? []) {
      const pkg = app.replace(/[^a-zA-Z0-9._+-]/g, "");
      if (!pkg) continue;
      const r = await driver.exec(ref, ["sh", "-c",
        `command -v ${pkg} >/dev/null 2>&1 || sudo apt-get install -y -qq ${pkg}`]);
      logEvent(id, "app.install", `${pkg}: exit ${r.exitCode}`);
    }

    if (opts.secretIds?.length) {
      assignSecrets(id, opts.secretIds);
      await injectSecrets(id);
    }

    // tmux starts last so its shells are born with the secrets env in place
    const tmux = await driver.exec(ref, ["tmux", "new-session", "-d",
      "-s", config.tmuxSession, "-c", config.guestWorkdir]);
    if (tmux.exitCode !== 0) throw new Error(`tmux start failed: ${tmux.stderr}`);

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
 *  usage (incl. sampled CPU %), and in-guest probes (disk, workdir, tmux). */
export async function projectDetails(id: string) {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  const ref = refFor(p.name);

  const info = await driver.inspect(ref).catch(() => null);
  const running = info?.state === "running";

  let cpuPercent: number | null = null;
  let stats = running ? await driver.stats(ref).catch(() => null) : null;
  let guest: Record<string, string> = {};
  if (running) {
    const s0 = stats;
    await Bun.sleep(700);
    const s1 = await driver.stats(ref).catch(() => null);
    if (s0?.cpuUsageUsec != null && s1?.cpuUsageUsec != null && info?.cpus) {
      const delta = s1.cpuUsageUsec - s0.cpuUsageUsec; // usec of CPU time
      cpuPercent = Math.max(0, Math.min(100, (delta / (700_000 * info.cpus)) * 100));
    }
    stats = s1 ?? s0;
    const g = await driver.exec(ref, ["sh", "-c", GUEST_PROBE]).catch(() => null);
    if (g?.exitCode === 0) guest = kv(g.stdout);
  }

  const num = (v: string | undefined) => (v ? Number(v) : null);
  return {
    id: p.id,
    name: p.name,
    state: p.state,
    image: p.image,
    source_path: p.source_path,
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

export async function destroyProject(id: string): Promise<void> {
  const p = getProject(id);
  if (!p) throw new Error("project not found");
  await driver.destroy(refFor(p.name));
  purgeProjectSecrets(id); // project-specific secrets die with the VM
  db.query("UPDATE projects SET state = 'destroyed' WHERE id = ?").run(id);
  logEvent(id, "destroy");
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
