import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config, VERSION } from "./config";
import { baseImageFiles } from "./assets";
import { startServer } from "./api/http";

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
}

const HELP = `sadbox v${VERSION} — supervisor for microVM AI-agent sandboxes

Usage: sadbox <command>

  serve      Start the web supervisor (default)   http://localhost:${config.port}
  setup      Check deps, start container system, build the base image
  doctor     Report environment health
  version    Print version
  help       Show this help

Env: SADBOX_PORT, SADBOX_HOST, SADBOX_DATA, SADBOX_BASE_IMAGE`;

export async function main(argv: string[]) {
  const cmd = argv[2] ?? "serve";
  switch (cmd) {
    case "serve": startServer(); break;
    case "setup": await setup(); break;
    case "doctor": await doctor(); break;
    case "version": case "--version": case "-v": console.log(VERSION); break;
    case "help": case "--help": case "-h": console.log(HELP); break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
