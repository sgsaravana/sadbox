// Git-native sync-back (spike C): guest commits → incremental bundle over
// exec stdout → host fetch into refs/remotes/sadbox/<name> → preview text.
import { join } from "path";
import { config } from "../config";
import { db, logEvent } from "../db";
import { getDriver } from "../driver";
import { branchFor, getWorker, refFor } from "./workers";

const driver = getDriver();

async function hostGit(repo: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

export async function syncWorker(id: string, opts?: { autocommit?: boolean }) {
  const w = getWorker(id);
  if (!w) throw new Error("worker not found");
  const ref = refFor(w.name);
  const branch = branchFor(w.name);
  const autocommit = opts?.autocommit ?? true;

  if (autocommit) {
    const c = await driver.exec(ref, ["sh", "-c",
      `cd ${config.guestWorkdir} && ` +
      `if [ -n "$(git status --porcelain)" ]; then git add -A && git commit -qm "sadbox: autocommit before sync"; fi`,
    ]);
    if (c.exitCode !== 0) throw new Error(`autocommit failed: ${c.stderr}`);
  }

  const tip = await driver.exec(ref, ["sh", "-c",
    `cd ${config.guestWorkdir} && git rev-parse ${branch}`]);
  if (tip.exitCode !== 0) throw new Error(`cannot resolve ${branch} in guest: ${tip.stderr}`);
  const tipSha = tip.stdout.trim();

  const basis = w.last_synced_sha ?? w.base_sha;
  if (tipSha === basis) {
    return { upToDate: true, tip: tipSha, commits: "", diffstat: "" };
  }

  const bundle = await driver.execCaptureBytes(ref,
    `cd ${config.guestWorkdir} && git bundle create - ${basis}..${branch}`);
  if (bundle.exitCode !== 0 || bundle.stdout.length === 0) {
    throw new Error("bundle creation failed in guest");
  }

  const bundlePath = join(config.dataDir, `${ref}-${Date.now()}.bundle`);
  await Bun.write(bundlePath, bundle.stdout);
  try {
    // + allows non-fast-forward updates if the agent rebased its branch
    const fetch = await hostGit(w.source_path,
      ["fetch", bundlePath, `+${branch}:refs/remotes/${branch}`]);
    if (fetch.code !== 0) throw new Error(`host fetch failed: ${fetch.err}`);
  } finally {
    await Bun.file(bundlePath).delete().catch(() => {});
  }

  db.query("UPDATE workers SET last_synced_sha = ? WHERE id = ?").run(tipSha, id);
  logEvent(id, "sync", `${basis?.slice(0, 7)}..${tipSha.slice(0, 7)} (${bundle.stdout.length} bytes)`);

  const base = w.base_sha!;
  const commits = await hostGit(w.source_path,
    ["log", "--oneline", `${base}..refs/remotes/${branch}`]);
  const diffstat = await hostGit(w.source_path,
    ["diff", "--stat", `${base}...refs/remotes/${branch}`]);
  return {
    upToDate: false,
    tip: tipSha,
    bundleBytes: bundle.stdout.length,
    ref: `refs/remotes/${branch}`,
    commits: commits.out,
    diffstat: diffstat.out,
  };
}

/** Preview without syncing: what has the worker committed since last sync? */
export async function syncStatus(id: string) {
  const w = getWorker(id);
  if (!w) throw new Error("worker not found");
  const r = await driver.exec(refFor(w.name), ["sh", "-c",
    `cd ${config.guestWorkdir} && ` +
    `echo "dirty=$(git status --porcelain | wc -l)" && ` +
    `echo "ahead=$(git rev-list --count ${w.last_synced_sha ?? w.base_sha}..${branchFor(w.name)})"`,
  ]);
  const dirty = Number(/dirty=\s*(\d+)/.exec(r.stdout)?.[1] ?? 0);
  const ahead = Number(/ahead=\s*(\d+)/.exec(r.stdout)?.[1] ?? 0);
  return { dirty, ahead };
}
