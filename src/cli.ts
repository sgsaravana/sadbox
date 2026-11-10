import { mkdirSync } from "fs";
import { config, VERSION } from "./config";
import { buildBaseImage } from "./core/baseimage";
import { getDriver } from "./driver";
import { installService, serviceStatus, uninstallService } from "./core/service";
import { CH_VERSION, ensureVmm, virtiofsdBin, vmmProblems } from "./driver/kvm/vmm";

/** Whether agent history can be kept on this machine (shared into VMs), and why not. */
function sharingNote(): string {
  if (getDriver().capabilities.sharedMount) return "✓ virtiofsd (agent history is kept on this machine)";
  if (virtiofsdBin()) return "· virtiofsd cannot map the VM user's id (needs 1.11+) and this user is not uid 1000 — agent history stays in each VM";
  return "· virtiofsd not found — agent history stays in each VM (install the virtiofsd package to keep it here)";
}
import { startServer } from "./api/http";
import { startProxy } from "./net/proxy";
import { startLoginLoop } from "./core/logins";
import { startClaudeRefresher } from "./net/claudeoauth";
import { migrateGitTokens } from "./core/gittoken";
import { startForwards } from "./net/forwards";
import { MIN_PASSWORD, authEnabled, ensurePassword, initialPasswordFile, setPassword } from "./core/auth";

const BIN = config.containerBin;

async function sh(cmd: string[], opts: { inherit?: boolean } = {}) {
  const proc = Bun.spawn(cmd, {
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: opts.inherit ? "inherit" : "pipe",
  });
  const out = opts.inherit ? "" : await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out: out.trim() };
}

async function has(bin: string) {
  return (await sh(["sh", "-c", `command -v ${bin}`])).code === 0;
}

/** Linux: KVM, Cloud Hypervisor and its kernel, docker for the image. */
async function setupKvm() {
  const host = vmmProblems().filter((p) => !p.fix?.startsWith("sadbox setup"));
  for (const p of host) console.error(`✗ ${p.error}${p.fix ? `\n    fix: ${p.fix}` : ""}`);
  if (host.length) process.exit(1);
  console.log("✓ /dev/kvm");
  if (!(await has(process.env.SADBOX_DOCKER_BIN || "docker"))) {
    console.error("✗ docker not found — it builds the VM image (https://docs.docker.com/engine/install/)");
    process.exit(1);
  }
  console.log("✓ docker");
  await ensureVmm((msg) => console.log(`→ ${msg}…`));
  console.log(`✓ Cloud Hypervisor ${CH_VERSION} and its guest kernel`);
  console.log(sharingNote());
}

async function setup() {
  console.log(`sadbox setup (v${VERSION})\n`);
  if (getDriver().name === "kvm") {
    await setupKvm();
    mkdirSync(config.dataDir, { recursive: true });
    console.log(`✓ data dir ${config.dataDir}`);
    console.log(`→ building base image ${config.baseImage} and its VM disk (a few minutes)…`);
    await buildBaseImage({ inherit: true });
    console.log("\n✓ setup complete — run 'sadbox serve' and open http://localhost:7070");
    return;
  }

  if (!(await has(BIN))) {
    console.error(`✗ Apple '${BIN}' CLI not found. Install it:  brew install container`);
    process.exit(1);
  }
  console.log(`✓ ${BIN} CLI present`);

  // ensure the container system service is up (idempotent)
  const status = await sh([BIN, "system", "status"]);
  if (status.code !== 0) {
    console.log("→ starting container system…");
    await sh([BIN, "system", "start", "--disable-kernel-install"], { inherit: true });
    await sh([BIN, "system", "kernel", "set", "--recommended"], { inherit: true });
  } else {
    console.log("✓ container system running");
  }

  mkdirSync(config.dataDir, { recursive: true });
  console.log(`✓ data dir ${config.dataDir}`);

  console.log(`→ building base image ${config.baseImage} (a few minutes)…`);
  await buildBaseImage({ inherit: true });
  console.log("\n✓ setup complete — run 'sadbox serve' and open http://localhost:7070");
}

async function doctor() {
  console.log(`sadbox v${VERSION}`);
  console.log(`data dir:      ${config.dataDir}`);
  console.log(`base image:   ${config.baseImage}`);
  const driver = getDriver();
  if (driver.name === "kvm") {
    const problems = vmmProblems();
    for (const p of problems) console.log(`✗ ${p.error}${p.fix ? ` (fix: ${p.fix})` : ""}`);
    if (!problems.length) console.log(`✓ KVM and Cloud Hypervisor ${CH_VERSION}`);
    console.log(`${(await driver.images.recipe(config.baseImage)) !== undefined ? "✓" : "✗"} VM disk built (${config.baseImage})`);
    console.log(`${(await has(process.env.SADBOX_DOCKER_BIN || "docker")) ? "✓" : "✗"} docker (builds the VM image)`);
    console.log(sharingNote());
    console.log(`${(await has("openssl")) ? "✓" : "✗"} openssl (egress proxy TLS interception)`);
    console.log(`proxy port:   ${config.proxyPort}`);
    return;
  }
  const bin = await has(BIN);
  console.log(`${bin ? "✓" : "✗"} ${BIN} CLI`);
  if (bin) {
    const sys = await sh([BIN, "system", "status"]);
    console.log(`${sys.code === 0 ? "✓" : "✗"} container system running`);
    const img = await sh([BIN, "image", "inspect", config.baseImage]);
    console.log(`${img.code === 0 ? "✓" : "✗"} base image built (${config.baseImage})`);
  }
  const ssl = await has("openssl");
  console.log(`${ssl ? "✓" : "✗"} openssl (egress proxy TLS interception)`);
  console.log(`proxy port:   ${config.proxyPort}`);
}

/** Read a line from the terminal without echoing it (falls back to a plain
 *  read when stdin is not a TTY, e.g. `echo pw | sadbox passwd`). */
async function readSecret(label: string): Promise<string> {
  const tty = process.stdin.isTTY;
  process.stdout.write(label);
  if (tty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    if (tty) { Bun.spawnSync(["stty", "echo"], { stdin: "inherit" }); process.stdout.write("\n"); }
  }
}

async function passwd() {
  const pw = await readSecret("New password: ");
  if (pw.length < MIN_PASSWORD) { console.error(`✗ password must be at least ${MIN_PASSWORD} characters`); process.exit(1); }
  if (process.stdin.isTTY && (await readSecret("Again: ")) !== pw) { console.error("✗ passwords do not match"); process.exit(1); }
  await setPassword(pw);
  console.log("✓ password set — every browser has been signed out");
  if (process.env.SADBOX_PASSWORD) console.log("⚠ SADBOX_PASSWORD is set in this environment and takes precedence over the stored password");
}

const HELP = `sadbox v${VERSION} — supervisor for microVM AI-agent sandboxes

Usage: sadbox <command>

  serve      Start the web supervisor (default)   http://localhost:${config.port}
  setup      Check deps, start the VM backend, build the base image
  doctor     Report environment health
  service    install | uninstall | status — run the supervisor at boot (Linux, systemd)
  passwd     Set the sign-in password (signs every browser out)
  version    Print version
  help       Show this help

Env: SADBOX_PORT, SADBOX_HOST, SADBOX_PASSWORD, SADBOX_AUTH=off, SADBOX_NETWORK, SADBOX_PROXY_PORT, SADBOX_PROXY_HOST,
     SADBOX_FORWARD_HOST, SADBOX_DATA, SADBOX_BASE_IMAGE, SADBOX_NET_LOG_DAYS (network log retention, ≥ 7)
Linux: SADBOX_DRIVER (kvm | container), SADBOX_CH_BIN, SADBOX_KVM_KERNEL, SADBOX_VIRTIOFSD, SADBOX_DOCKER_BIN, SADBOX_KVM_RUN`;

export async function main(argv: string[]) {
  const cmd = argv[2] ?? "serve";
  switch (cmd) {
    case "serve":
      if (authEnabled()) {
        const generated = await ensurePassword();
        if (generated) {
          console.log(`sadbox sign-in password (generated): ${generated}`);
          console.log(`  also saved in ${initialPasswordFile()} — change it with 'sadbox passwd'`);
        }
      } else {
        console.log("⚠ sign-in is OFF (SADBOX_AUTH=off): anyone who can reach this port controls every VM");
      }
      startServer();
      // egress proxy for the VMs; runs alongside the API. Non-fatal if it can't
      // start (e.g. openssl missing) — the UI/API still work, egress just isn't
      // filtered until it's available.
      startProxy().catch((e) => console.error(`⚠ proxy not started: ${e instanceof Error ? e.message : e}`));
      startForwards().catch((e) => console.error(`⚠ port forwards not started: ${e instanceof Error ? e.message : e}`));
      // agent logins: capture from running VMs, and Claude's refresh, owned by sadbox
      startLoginLoop();
      startClaudeRefresher();
      // git remote tokens stored the old way (real, in the VM) move to the vault
      migrateGitTokens().catch((e) => console.error(`⚠ git token migration: ${e instanceof Error ? e.message : e}`));
      break;
    case "setup": await setup(); break;
    case "doctor": await doctor(); break;
    case "service": {
      const sub = argv[3] ?? "status";
      try {
        if (sub === "install") await installService(console.log);
        else if (sub === "uninstall") await uninstallService(console.log);
        else if (sub === "status") console.log(await serviceStatus());
        else { console.error("usage: sadbox service install | uninstall | status"); process.exit(1); }
      } catch (e) {
        console.error(`✗ ${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
      break;
    }
    case "passwd": await passwd(); break;
    case "version": case "--version": case "-v": console.log(VERSION); break;
    case "help": case "--help": case "-h": console.log(HELP); break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
