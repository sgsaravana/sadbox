// `sadbox update` — replace this installation with the latest release.
//
// Only the install-script/downloaded-binary path is self-updatable: it
// downloads the matching GitHub asset, verifies the release's SHA256SUMS, and
// atomically renames it over the running binary. Homebrew, docker and source
// checkouts keep their own update commands (below), so the command points at
// the right one instead of fighting the package manager.
import { chmodSync, existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { VERSION } from "../config";
import { restartService } from "./service";

const DEFAULT_REPO = "sgsaravana/sadbox";
const USER_AGENT = `sadbox/${VERSION}`;
const SUM_ASSET = "SHA256SUMS";

export interface UpdateOptions {
  /** Only report what is available. */
  check?: boolean;
  /** Reinstall even when the version is already current. */
  force?: boolean;
  /** Follow pre-releases (default: on when this build is itself a pre-release). */
  prerelease?: boolean;
  /** Restart an installed systemd/launchd service after replacing the binary. */
  restart?: boolean;
  /** Rebuild the base image (and VM disk) so new VMs get the latest agents. */
  refreshImage?: boolean;
  /** Install an exact tag, e.g. v0.6.0. */
  version?: string;
}

export type UpdateMethod = "binary" | "homebrew" | "source" | "docker" | "unsupported";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface Release {
  tag_name: string;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

export function parseUpdateArgs(args: string[]): UpdateOptions {
  const out: UpdateOptions = { restart: true, refreshImage: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--check": case "-n": out.check = true; break;
      case "--force": case "-f": out.force = true; break;
      case "--prerelease": case "--beta": out.prerelease = true; break;
      case "--no-restart": out.restart = false; break;
      case "--restart": out.restart = true; break;
      case "--no-image": out.refreshImage = false; break;
      case "--image": out.refreshImage = true; break;
      case "--version": {
        const v = args[++i];
        if (!v) throw new Error("--version needs a tag, e.g. --version v0.6.0");
        out.version = v;
        break;
      }
      default:
        if (a.startsWith("--version=")) out.version = a.slice("--version=".length);
        else throw new Error(`unknown update option: ${a}`);
    }
  }
  if (process.env.SADBOX_UPDATE_PRERELEASE === "1") out.prerelease = true;
  return out;
}

/** How this copy of sadbox was installed, which decides who updates it. */
export function updateMethod(): UpdateMethod {
  if (process.platform === "win32") return "unsupported";
  if (existsSync("/.dockerenv")) return "docker";
  // service.ts uses the same test for a compiled binary vs `bun run src/index.ts`
  if (!Bun.main.startsWith("/$bunfs/")) return "source";
  try {
    if (/[/\\]Cellar[/\\]sadbox[/\\]/i.test(realpathSync(process.execPath))) return "homebrew";
  } catch {}
  return "binary";
}

export function parseVersion(input: string): { major: number; minor: number; patch: number; pre: string[] } | null {
  const m = input.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver order: >0 when a is newer than b. A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`cannot compare versions "${a}" and "${b}"`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn) return -1;
    if (qn) return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

/** The release asset this host runs: sadbox-<os>-<arch>. */
export function assetFor(platform: NodeJS.Platform | string = process.platform, arch: string = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : "";
  if (!os) throw new Error(`sadbox update supports macOS and Linux, not ${platform}`);
  if (!cpu) throw new Error(`sadbox update supports arm64 and x64, not ${arch}`);
  return `sadbox-${os}-${cpu}`;
}

/** `shasum -a 256` output → filename → hash. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

function repo(): string {
  const r = (process.env.SADBOX_REPO || DEFAULT_REPO).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`SADBOX_REPO must be owner/repo, not "${r}"`);
  return r;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": USER_AGENT };
  if (process.env.SADBOX_GITHUB_TOKEN) h.authorization = `Bearer ${process.env.SADBOX_GITHUB_TOKEN}`;
  return h;
}

async function gh(path: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com/repos/${repo()}${path}`, { headers: ghHeaders() });
  if (res.ok) return res.json();
  if (res.status === 403) {
    throw new Error("GitHub API rate limit reached — set SADBOX_GITHUB_TOKEN or try again later");
  }
  if (res.status === 404) throw new Error(`release not found (${path})`);
  throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function releaseFor(opts: UpdateOptions): Promise<Release> {
  if (opts.version) {
    const tag = opts.version.startsWith("v") ? opts.version : `v${opts.version}`;
    return await gh(`/releases/tags/${encodeURIComponent(tag)}`) as Release;
  }
  const prerelease = opts.prerelease || VERSION.includes("-");
  if (!prerelease) return await gh("/releases/latest") as Release;
  const list = await gh("/releases?per_page=30") as Release[];
  const pre = list.filter((r) => r.prerelease && r.tag_name.includes("-") && parseVersion(r.tag_name))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  if (!pre.length) throw new Error("there is no pre-release to update to");
  return pre[0];
}

/** Replace a binary atomically: write beside it, then rename over it. */
export function installBinary(bytes: Uint8Array, target = process.execPath): void {
  const real = realpathSync(target);
  const dir = dirname(real);
  const tmp = join(dir, `.${basename(real)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, real);
  } catch (e) {
    throw new Error(`cannot replace ${real}: ${e instanceof Error ? e.message : e}. Re-run the installer or fix the file's permissions.`);
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Check for or install the latest release. Throws a user-facing error; the CLI
 * prints it and exits non-zero.
 */
export async function runUpdate(opts: UpdateOptions, log = (s: string) => console.log(s)): Promise<void> {
  const method = updateMethod();
  if (method === "docker") {
    throw new Error("this is a container install. On the host:\n  git pull && docker compose build && docker compose up -d\n  docker compose run --rm sadbox sadbox setup   # rebuild the base image + agents\n(or `docker compose pull` if you use a published image)");
  }
  if (method === "source") {
    throw new Error("this is a source checkout, not an installed binary. Update it with:\n  git pull && bun install && bun run setup");
  }
  if (method === "unsupported") {
    throw new Error("sadbox update runs inside macOS or Linux. On Windows it runs inside WSL; update the Windows launcher by reinstalling the release.");
  }

  const rel = await releaseFor(opts);
  const latest = rel.tag_name.replace(/^v/i, "");
  const cmp = compareVersions(latest, VERSION);
  const tag = rel.tag_name;

  if (opts.check) {
    if (opts.version) log(`sadbox ${VERSION}; ${tag} ${cmp === 0 ? "is the current version" : "is available"}`);
    else if (cmp > 0) log(`sadbox ${VERSION} → ${tag} is available`);
    else if (cmp < 0) log(`sadbox ${VERSION} is newer than the latest release (${tag})`);
    else log(`sadbox ${VERSION} is up to date (latest ${tag})`);
    return;
  }
  const current = !opts.force && cmp === 0;
  if (!opts.force && !opts.version && cmp < 0) {
    log(`sadbox ${VERSION} is newer than the latest release (${tag}); use --force to install it anyway`);
    return;
  }

  if (current) {
    log(`sadbox ${VERSION} is already current (${tag})`);
    if (!opts.refreshImage) return;
    log("· refreshing the base image so new VMs get the current agents");
  } else if (method === "homebrew") {
    if (opts.version || opts.prerelease) {
      throw new Error("Homebrew installs follow the formula, not an exact or pre-release tag. Use the install script for --version/--prerelease, or `brew upgrade sadbox` for the latest formula.");
    }
    log(`→ Homebrew install; running brew upgrade sadbox (${VERSION} → ${latest})`);
    const r = Bun.spawn(["brew", "upgrade", "sadbox"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (await r.exited !== 0) {
      throw new Error("brew upgrade sadbox failed. If it came from a tap: brew upgrade sgsaravana/tap/sadbox");
    }
  } else {
    const assetName = assetFor();
    const asset = rel.assets.find((a) => a.name === assetName);
    if (!asset) {
      throw new Error(`${tag} has no ${assetName} asset (found: ${rel.assets.map((a) => a.name).join(", ") || "none"})`);
    }
    const sums = rel.assets.find((a) => a.name === SUM_ASSET);
    if (!sums) throw new Error(`${tag} has no ${SUM_ASSET}; refusing an unverified download`);
    log(`→ downloading ${assetName} (${tag}${asset.size ? `, ${Math.round(asset.size / 1_000_000)} MB` : ""})…`);
    const [bytes, sumText] = await Promise.all([
      download(asset.browser_download_url),
      download(sums.browser_download_url).then((b) => new TextDecoder().decode(b)),
    ]);
    const want = parseChecksums(sumText).get(assetName);
    if (!want) throw new Error(`${SUM_ASSET} has no entry for ${assetName}`);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`checksum mismatch for ${assetName}: expected ${want}, got ${got}`);
    installBinary(bytes);
    log(`✓ replaced ${realpathSync(process.execPath)} (${VERSION} → ${latest})`);
  }

  // Agents come from the base image, not from an update inside each VM. Build
  // it with the new binary so the next create or rebuild starts with the
  // current Claude Code, omp and opencode.
  if (opts.refreshImage) {
    const exe = method === "homebrew" ? (Bun.which("sadbox") ?? process.execPath) : process.execPath;
    log("→ rebuilding the base image and VM disk so new VMs get the current agents (a few minutes)…");
    let ok = false;
    try {
      const r = Bun.spawn([exe, "setup"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      ok = (await r.exited) === 0;
    } catch {}
    if (ok) log("✓ base image rebuilt — Rebuild a project to pick it up");
    else log("⚠ the base image was not rebuilt — run `sadbox setup` when Docker is available. Existing VMs keep their agents.");
  }

  if (opts.restart && !current) {
    try {
      const how = await restartService();
      if (how) log(`✓ restarted the supervisor (${how})`);
      else log(`· not running as a service — restart \`sadbox serve\` to use the new version${method === "homebrew" ? " (or `brew services restart sadbox`)" : ""}`);
    } catch (e) {
      log(`⚠ updated, but could not restart the service: ${e instanceof Error ? e.message : e}`);
      log("  restart it yourself when convenient.");
    }
  }
}
