// The Windows entry point: a small .exe that finds the WSL 2 distribution and
// runs the real (Linux) sadbox inside it. It is deliberately not the
// supervisor: all state, VMs and sockets live in WSL. `sadbox.exe` exists so a
// Windows user does not have to learn `wsl.exe` first.
//
// Build:  bun run compile:windows-x64
// Use:    sadbox.exe [serve|setup|doctor|open|version|help]
//
// The distro is chosen by SADBOX_WSL_DISTRO, else "sadbox" if installed, else
// the first distro WSL lists. The supervisor command inside it is `sadbox`
// (override with SADBOX_WSL_BIN).
import { VERSION } from "../config";

const PORT = Number(process.env.SADBOX_PORT ?? 7070) || 7070;
const URL = `http://localhost:${PORT}`;

const HELP = `sadbox for Windows (v${VERSION}) — runs the Linux supervisor inside WSL 2

Usage: sadbox.exe <command>

  serve      Start sadbox in WSL and open ${URL}   (default)
  setup      Build the VM image inside WSL (a few minutes, once)
  doctor     Report environment health inside WSL
  open       Open ${URL} in the default browser
  version    Print version
  help       Show this help

Env: SADBOX_WSL_DISTRO (default: sadbox, else the first WSL distro)
     SADBOX_WSL_BIN    (default: sadbox)
     SADBOX_PORT       (default: 7070; forwarded to WSL)
     SADBOX_DATA       (optional Linux data dir; forwarded to WSL)

First time? In an elevated PowerShell:
  wsl --install
  # add [wsl2] nestedVirtualization=true to %UserProfile%\\.wslconfig
  # then install sadbox inside your distro (see docs/windows-wsl2.md)
`;

function say(msg: string) { console.log(msg); }
function fail(msg: string): never { console.error(msg); process.exit(1); }

function decodeWsl(bytes: Uint8Array): string {
  // wsl.exe -l -q is UTF-16LE (often with a BOM); some commands answer UTF-8.
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16 = bom || (bytes.length > 1 && bytes[1] === 0);
  const text = new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bom ? bytes.subarray(2) : bytes);
  return text.replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\r/g, "").trim();
}

function wslExe(): string {
  return Bun.which("wsl.exe") || Bun.which("wsl") || "";
}

function listDistros(): string[] {
  const exe = wslExe();
  if (!exe) return [];
  const r = Bun.spawnSync([exe, "-l", "-q"], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return [];
  return decodeWsl(r.stdout).split("\n").map((s) => s.trim()).filter(Boolean);
}

function pickDistro(): string {
  const wanted = (process.env.SADBOX_WSL_DISTRO || "").trim();
  const distros = listDistros();
  if (wanted) {
    if (!distros.includes(wanted)) {
      fail(`✗ WSL distro "${wanted}" was not found. Installed: ${distros.join(", ") || "none"}`);
    }
    return wanted;
  }
  if (distros.includes("sadbox")) return "sadbox";
  const first = distros.find((d) => !/^docker-desktop/.test(d));
  if (first) return first;
  fail(
    "✗ no WSL 2 distribution found.\n" +
    "  Install one first (elevated PowerShell):  wsl --install\n" +
    "  Then follow docs/windows-wsl2.md, or set SADBOX_WSL_DISTRO.",
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function wslArgs(distro: string, command: string[]): string[] {
  const bin = process.env.SADBOX_WSL_BIN || "sadbox";
  // A login shell, with ~/.local/bin explicitly first: `wsl.exe -- sadbox`
  // does not read the interactive profile, so a binary installed by install.sh
  // would otherwise be "command not found".
  // SADBOX_DATA / SADBOX_PORT are safe to forward (Linux paths/numbers); the
  // password is deliberately not put on a command line.
  const env: string[] = [];
  for (const name of ["SADBOX_DATA", "SADBOX_PORT"] as const) {
    const value = process.env[name];
    if (value) env.push(`${name}=${shellQuote(value)}`);
  }
  const prefix = env.length ? `${env.join(" ")} ` : "";
  const line = `PATH="$HOME/.local/bin:$PATH" ${prefix}exec ${[bin, ...command].map(shellQuote).join(" ")}`;
  return [wslExe(), "-d", distro, "--", "sh", "-lc", line];
}

async function run(distro: string, command: string[]): Promise<number> {
  const proc = Bun.spawn(wslArgs(distro, command), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

function openBrowser(): void {
  if (process.platform !== "win32") {
    say(`Open ${URL} in your browser.`);
    return;
  }
  Bun.spawn(["cmd.exe", "/c", "start", "", URL], { stdout: "ignore", stderr: "ignore", windowsHide: true });
}

async function waitForServer(ms = 45_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

async function serve(): Promise<never> {
  const distro = pickDistro();
  say(`→ sadbox in WSL 2 (${distro})`);
  const child = Bun.spawn(wslArgs(distro, ["serve"]), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  // open the UI once it answers, without blocking the supervisor
  void (async () => {
    if (await waitForServer()) openBrowser();
    else say(`· still starting — open ${URL} when it is ready`);
  })();
  process.exit(await child.exited);
}

async function main() {
  const cmd = (process.argv[2] || "serve").toLowerCase();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") { say(HELP); return; }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") { say(VERSION); return; }
  if (!wslExe()) {
    fail(
      "✗ Windows Subsystem for Linux is not installed.\n" +
      "  In an elevated PowerShell:  wsl --install\n" +
      "  Then reboot, set up a distro, and follow docs/windows-wsl2.md.",
    );
  }
  if (cmd === "open") { openBrowser(); return; }
  const distro = pickDistro();
  if (cmd === "serve") { await serve(); return; }
  if (cmd === "setup") { process.exit(await run(distro, ["setup"])); }
  if (cmd === "doctor") { process.exit(await run(distro, ["doctor"])); }
  fail(`unknown command: ${cmd}\n\n${HELP}`);
}

await main();
