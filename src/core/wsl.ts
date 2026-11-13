// Windows (WSL 2) support. sadbox itself stays a Linux program: inside WSL 2
// it is the ordinary Linux/KVM build. This module is the small amount of
// Windows awareness the supervisor needs:
//
//   * recognise WSL 2, for `doctor`/`setup` messages and the folder picker;
//   * translate Windows paths (`C:\Users\me\repo`) to their WSL form
//     (`/mnt/c/Users/me/repo`) and back, so a user can paste either;
//   * tell when a folder is on a Windows drive (DrvFs), where git needs
//     `core.fileMode=false` and `core.autocrlf=false`;
//   * explain the one thing that usually stops WSL VMs: `/dev/kvm`.
//
// The model is in docs/research/16-windows.md and docs/windows-wsl2.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WslInfo {
  /** The distribution name (`WSL_DISTRO_NAME`), or "WSL" when unknown. */
  distro: string;
  /** 2 when the kernel says so; null when it cannot be told. */
  version: 2 | null;
}

/** Pure WSL detection, for tests: WSL is Linux whose kernel says so, or whose
 *  environment carries `WSL_DISTRO_NAME`/`WSL_INTEROP`. */
export function wslFrom(
  platform: string,
  env: Record<string, string | undefined>,
  procVersion: string,
): WslInfo | null {
  if (platform !== "linux") return null;
  const distro = (env.WSL_DISTRO_NAME || "").trim();
  const looksWsl = Boolean(distro) || Boolean(env.WSL_INTEROP) || /microsoft|wsl/i.test(procVersion);
  if (!looksWsl) return null;
  return { distro: distro || "WSL", version: /WSL2/i.test(procVersion) ? 2 : null };
}

let cached: WslInfo | null | undefined;

/** The running WSL distribution, or null on a native Linux/macOS host. */
export function wslInfo(): WslInfo | null {
  if (cached !== undefined) return cached;
  let proc = "";
  try { proc = readFileSync("/proc/version", "utf8"); } catch {}
  return (cached = wslFrom(process.platform, process.env, proc));
}

export const isWsl = () => wslInfo() !== null;

const WIN_DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/;
const UNC = /^\\\\[^\\]+\\/;

/** A Windows drive or UNC path, as pasted from Explorer. */
export function isWindowsPath(path: string): boolean {
  const p = path.trim();
  return WIN_DRIVE.test(p) || UNC.test(p);
}

const trimSlashes = (s: string) => s.replace(/^[\\/]+|[\\/]+$/g, "");

/** `C:\Users\me\repo` → `/mnt/c/Users/me/repo`. UNC paths are not mounted by
 *  WSL by default, so they get null (the caller can explain). */
export function windowsPathToWsl(input: string, mountRoot = "/mnt"): string | null {
  const m = input.trim().match(WIN_DRIVE);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const rest = (m[2] ?? "").replace(/\\/g, "/").replace(/\/+/g, "/");
  const tail = trimSlashes(rest);
  return `${mountRoot}/${drive}${tail ? `/${tail}` : ""}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `/mnt/c/Users/me/repo` → `C:\Users\me\repo`; null for other paths. */
export function wslPathToWindows(input: string, mountRoot = "/mnt"): string | null {
  const m = input.match(new RegExp(`^${escapeRe(mountRoot)}/([A-Za-z])(?:/(.*))?$`));
  if (!m) return null;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/\/+/g, "\\")}`;
}

/** A folder on a Windows drive mounted by WSL (DrvFs/9p). */
export function isDrvFsPath(path: string, mountRoot = "/mnt"): boolean {
  return new RegExp(`^${escapeRe(mountRoot)}/[A-Za-z](?:/|$)`).test(path);
}

/** What the UI should show for a host path: a Windows path on WSL, as typed.
 *  `wsl` is injectable so the translation is testable off Windows. */
export function displayHostPath(path: string, wsl = isWsl()): string {
  return wsl ? wslPathToWindows(path) ?? path : path;
}

/** Accept either form from a user/API and hand git/filesystem code the WSL one. */
export function normalizeHostPath(input: string, wsl = isWsl()): string {
  const p = input.trim();
  if (wsl && isWindowsPath(p)) return windowsPathToWsl(p) ?? p;
  return p;
}

/** Extra `git -c` arguments for a repository on a Windows drive. Windows has no
 *  POSIX mode bits and may rewrite line endings; both make git see every file
 *  as changed, which would drown sync-back in noise. */
export function gitConfigFor(folder: string): string[] {
  if (!isDrvFsPath(folder)) return [];
  return [
    // DrvFs maps ownership from Windows; git's dubious-ownership guard would
    // otherwise refuse the very folder the user picked.
    "-c", `safe.directory=${folder}`,
    "-c", "core.fileMode=false",
    "-c", "core.autocrlf=false",
    "-c", "core.symlinks=false",
  ];
}

let home: string | null | undefined;

/** The Windows user's home, as a WSL path (`/mnt/c/Users/me`). Uses interop
 *  once; falls back to `C:\Users\<USER>`. Null when neither is available. */
export function windowsHome(): string | null {
  if (home !== undefined) return home;
  if (!isWsl()) return (home = null);
  try {
    const r = Bun.spawnSync(["cmd.exe", "/c", "echo %USERPROFILE%"], { stdout: "pipe", stderr: "ignore" });
    const out = r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
    if (isWindowsPath(out)) {
      const w = windowsPathToWsl(out);
      if (w) return (home = w);
    }
  } catch {}
  for (const user of [process.env.USERNAME, process.env.USER]) {
    if (user && existsSync(`/mnt/c/Users/${user}`)) return (home = `/mnt/c/Users/${user}`);
  }
  return (home = null);
}

/** The quick locations the folder picker starts from on Windows. */
export function wslRoots(): { label: string; path: string }[] {
  if (!isWsl()) return [];
  const roots: { label: string; path: string }[] = [{ label: "WSL home", path: homedir() }];
  try {
    for (const drive of readdirSync("/mnt").filter((d) => /^[a-z]$/i.test(d)).sort()) {
      roots.push({ label: `Windows (${drive.toUpperCase()}:)`, path: `/mnt/${drive.toLowerCase()}` });
    }
  } catch {}
  if (roots.length === 1 && existsSync("/mnt/c")) roots.push({ label: "Windows (C:)", path: "/mnt/c" });
  return roots;
}

/** `%UserProfile%\.wslconfig`, as a WSL path, when it can be found. */
export function wslConfigPath(): string | null {
  const h = windowsHome();
  return h ? join(h, ".wslconfig") : null;
}

/** Parse `[wsl2] nestedVirtualization=` out of a .wslconfig. */
export function parseNestedVirtualization(text: string): boolean | undefined {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }
    if (section !== "wsl2") continue;
    const m = line.match(/^nestedvirtualization\s*=\s*(true|false)\s*$/i);
    if (m) return m[1].toLowerCase() === "true";
  }
  return undefined;
}

/** The WSL-specific lines of `sadbox doctor`; empty off WSL. */
export function wslDoctorLines(info: WslInfo, kvm: boolean, dataDir: string): string[] {
  const out = [`Windows: ${info.version === 2 ? "WSL 2" : "WSL"}, ${info.distro}`];
  if (kvm) out.push("✓ /dev/kvm (nested virtualization is on)");
  else {
    out.push("✗ /dev/kvm — nested virtualization is off or unavailable");
    out.push("    fix: in Windows, add to %UserProfile%\\.wslconfig:");
    out.push("           [wsl2]");
    out.push("           nestedVirtualization=true");
    out.push("         then run `wsl --shutdown` in PowerShell and reopen the distro");
    out.push("         (Windows 11 x64 only; Windows 10 and ARM64 have no nested KVM)");
  }
  if (isDrvFsPath(dataDir)) {
    out.push(`✗ data dir is on a Windows drive (${dataDir})`);
    out.push("    fix: set SADBOX_DATA to a path inside the distro (e.g. ~/.sadbox) — sockets, modes and sparse disks need ext4");
  }
  const cfg = wslConfigPath();
  if (cfg && existsSync(cfg)) {
    try {
      const setting = parseNestedVirtualization(readFileSync(cfg, "utf8"));
      if (setting === false) out.push(`✗ ${cfg} sets nestedVirtualization=false`);
      else if (setting === true) out.push(`✓ ${cfg} sets nestedVirtualization=true`);
    } catch {}
  } else if (!kvm) {
    out.push("· no %UserProfile%\\.wslconfig found — create it with the [wsl2] block above");
  }
  return out;
}

/** The note `sadbox setup` prints first on WSL. */
export function wslSetupNote(info: WslInfo): string {
  return `Windows (WSL 2, ${info.distro}) — the Linux/KVM backend runs inside WSL; Windows 11 x64 only`;
}
