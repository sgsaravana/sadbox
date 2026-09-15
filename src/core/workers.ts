import { existsSync } from "fs";
import { config } from "../config";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { injectSecrets, assignSecrets, purgeWorkerSecrets } from "./secrets";

const driver = getDriver();

export interface WorkerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  source_path: string;
  source_branch: string | null;
  base_sha: string | null;
  last_synced_sha: string | null;
  apps: string;
  error: string | null;
  created_at: string;
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

async function resolveImage(): Promise<string> {
  const r = await Bun.spawn([config.containerBin, "image", "inspect", config.workerImage], {
    stdout: "ignore", stderr: "ignore",
  }).exited;
  return r === 0 ? config.workerImage : config.workerImageFallback;
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

export function listWorkers(): WorkerRow[] {
  return db.query<WorkerRow, []>(
    "SELECT * FROM workers WHERE state != 'destroyed' ORDER BY created_at DESC",
  ).all();
}

export function getWorker(id: string): WorkerRow | null {
  return db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE id = ?").get(id);
}

export async function createWorker(opts: {
  name: string;
  sourcePath: string;
  apps?: string[];
  secretIds?: string[];
}): Promise<WorkerRow> {
  const name = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("invalid worker name");
  if (!existsSync(opts.sourcePath)) throw new Error(`source folder not found: ${opts.sourcePath}`);

  const branch = await hostGit(opts.sourcePath, ["branch", "--show-current"]);
  const head = await hostGit(opts.sourcePath, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    throw new Error("source folder must be a git repository with at least one commit (v0 limitation)");
  }

  const id = crypto.randomUUID().slice(0, 8);
  const image = await resolveImage();
  db.query(
    `INSERT INTO workers (id, name, image, state, source_path, source_branch, base_sha, last_synced_sha, apps)
     VALUES (?, ?, ?, 'creating', ?, ?, ?, ?, ?)`,
  ).run(id, name, image, opts.sourcePath, branch.out || "HEAD", head.out, head.out,
        JSON.stringify(opts.apps ?? []));
  logEvent(id, "create.start", `${name} from ${opts.sourcePath}`);

  try {
    const ref = refFor(name);
    await driver.create(ref, image);

    // copy-in
    const tarBytes = await tarSource(opts.sourcePath);
    const cp = await driver.execWithStdin(
      ref,
      `mkdir -p ${config.guestWorkdir} && tar -xf - -C ${config.guestWorkdir}`,
      tarBytes,
    );
    if (cp.exitCode !== 0) throw new Error(`copy-in failed: ${cp.stderr}`);

    // git identity + worker branch + tmux session rooted in workdir
    const setup = await driver.exec(ref, ["sh", "-c",
      `cd ${config.guestWorkdir} && ` +
      `git config user.name "sadbox worker ${name}" && ` +
      `git config user.email "worker@sadbox.local" && ` +
      `git checkout -q -b ${branchFor(name)} && ` +
      // .bashrc for interactive (tmux) shells, .profile for login/non-interactive —
      // Debian's stock .bashrc returns early when non-interactive
      `for f in ~/.bashrc ~/.profile; do grep -q sadbox/env $f 2>/dev/null || printf 'set -a; [ -f ~/.sadbox/env ] && . ~/.sadbox/env; set +a\\n' >> $f; done`,
    ]);
    if (setup.exitCode !== 0) throw new Error(`guest setup failed: ${setup.stderr}`);

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

    db.query("UPDATE workers SET state = 'running' WHERE id = ?").run(id);
    logEvent(id, "create.done");
  } catch (e) {
    db.query("UPDATE workers SET state = 'error', error = ? WHERE id = ?").run(String(e), id);
    logEvent(id, "create.error", String(e));
    throw e;
  }
  return getWorker(id)!;
}

export async function destroyWorker(id: string): Promise<void> {
  const w = getWorker(id);
  if (!w) throw new Error("worker not found");
  await driver.destroy(refFor(w.name));
  purgeWorkerSecrets(id); // VM-specific secrets die with the VM
  db.query("UPDATE workers SET state = 'destroyed' WHERE id = ?").run(id);
  logEvent(id, "destroy");
}

/** Merge live driver state into DB rows for the UI. Degrades to DB-only
 *  rows when the driver is unavailable (e.g. supervisor in a container). */
export async function workersWithLiveState() {
  const rows = listWorkers();
  const live = new Map(
    (await driver.list().catch(() => [])).map((w) => [w.ref, w]),
  );
  return rows.map((r) => ({
    ...r,
    apps: JSON.parse(r.apps),
    live: live.get(refFor(r.name)) ?? null,
  }));
}
