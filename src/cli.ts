import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config, VERSION } from "./config";
import { baseImageFiles } from "./assets";
import { startServer } from "./api/http";
import { startProxy } from "./net/proxy";
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

/** Build the base image from the embedded Dockerfile + tmux.conf. */
async function buildBaseImage() {
  const ctx = mkdtempSync(join(tmpdir(), "sadbox-img-"));
  for (const [name, embeddedPath] of Object.entries(baseImageFiles)) {
    await Bun.write(join(ctx, name), Bun.file(embeddedPath));
  }
  console.log("→ building base image sadbox-base:latest (~1 min)…");
  const r = await sh([BIN, "build", "-t", "sadbox-base:latest", ctx], { inherit: true });
  if (r.code !== 0) throw new Error("base image build failed");
}

async function setup() {
  console.log(`sadbox setup (v${VERSION})\n`);

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

  await buildBaseImage();
  console.log("\n✓ setup complete — run 'sadbox serve' and open http://localhost:7070");
}

async function doctor() {
  console.log(`sadbox v${VERSION}`);
  console.log(`data dir:      ${config.dataDir}`);
  console.log(`base image:   ${config.baseImage}`);
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
  setup      Check deps, start container system, build the base image
  doctor     Report environment health
  passwd     Set the sign-in password (signs every browser out)
  version    Print version
  help       Show this help

Env: SADBOX_PORT, SADBOX_HOST, SADBOX_PASSWORD, SADBOX_AUTH=off, SADBOX_NETWORK, SADBOX_PROXY_PORT, SADBOX_PROXY_HOST,
     SADBOX_FORWARD_HOST, SADBOX_DATA, SADBOX_BASE_IMAGE`;

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
      break;
    case "setup": await setup(); break;
    case "doctor": await doctor(); break;
    case "passwd": await passwd(); break;
    case "version": case "--version": case "-v": console.log(VERSION); break;
    case "help": case "--help": case "-h": console.log(HELP); break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
