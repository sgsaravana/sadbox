// `sadbox service`: run the supervisor in the background, started at boot —
// a systemd user unit on Linux. On macOS this is still a launchd job written
// by hand (README: Deploying).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const UNIT_NAME = "sadbox.service";
export const unitPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT_NAME);

/** How to run this same sadbox: the binary itself, or bun on the checkout. */
export function serveCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return compiled ? [process.execPath, "serve"] : [process.execPath, "run", Bun.main, "serve"];
}

// sadbox's settings, and PATH (a user unit's is minimal, and docker and
// virtiofsd are looked up on it). Not the password: a unit file is world-readable.
const KEEP_ENV = (k: string) => k === "PATH" || (k.startsWith("SADBOX_") && k !== "SADBOX_PASSWORD");

/** A systemd quote: each argument in double quotes, with \ " and % escaped. */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function unitText(cmd: string[], env: Record<string, string | undefined>): string {
  const envLines = Object.entries(env)
    .filter(([k, v]) => KEEP_ENV(k) && v != null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`);
  return [
    "[Unit]",
    "Description=sadbox supervisor (microVM sandboxes for AI agents)",
    "After=network-online.target docker.service",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${cmd.map(q).join(" ")}`,
    ...envLines,
    "Restart=on-failure",
    "RestartSec=3",
    // The VMs (cloud-hypervisor, virtiofsd) are started detached and must
    // outlive a restart or an upgrade of the supervisor, as on macOS: stop only
    // the supervisor's own process, not everything it started.
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

async function systemctl(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: (out + err).trim() };
}

function requireSystemd() {
  if (process.platform !== "linux") throw new Error("`sadbox service` sets up a systemd unit, on Linux; on macOS run `sadbox serve` under a launchd job (README: Deploying)");
  if (!Bun.which("systemctl")) throw new Error("systemctl not found: this system does not run systemd");
}

export async function installService(log: (s: string) => void): Promise<void> {
  requireSystemd();
  const path = unitPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, unitText(serveCommand(), process.env));
  log(`✓ wrote ${path}`);
  for (const args of [["daemon-reload"], ["enable", "--now", UNIT_NAME]]) {
    const r = await systemctl(...args);
    if (r.code !== 0) throw new Error(`systemctl --user ${args.join(" ")}: ${r.out}`);
  }
  log(`✓ ${UNIT_NAME} enabled and started — logs: journalctl --user -u sadbox -f`);
  if (process.env.SADBOX_PASSWORD) log("· SADBOX_PASSWORD was not written into the unit; the service uses the stored password (sadbox passwd)");
  const linger = Bun.spawnSync(["loginctl", "show-user", process.env.USER ?? "", "--property=Linger"], { stdout: "pipe" });
  if (!`${linger.stdout}`.includes("Linger=yes")) {
    log(`· to start it at boot, before you log in:  sudo loginctl enable-linger ${process.env.USER ?? "$USER"}`);
  }
}

export async function uninstallService(log: (s: string) => void): Promise<void> {
  requireSystemd();
  await systemctl("disable", "--now", UNIT_NAME);
  if (existsSync(unitPath())) rmSync(unitPath());
  await systemctl("daemon-reload");
  log(`✓ ${UNIT_NAME} stopped and removed (running VMs keep running; \`sadbox serve\` finds them again)`);
}

export async function serviceStatus(): Promise<string> {
  requireSystemd();
  if (!existsSync(unitPath())) return `not installed (sadbox service install)`;
  return (await systemctl("status", "--no-pager", "--lines=5", UNIT_NAME)).out;
}
