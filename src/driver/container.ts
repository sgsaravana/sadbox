// Apple `container` CLI driver (macOS). Every recipe here was proven in
// spikes/a-terminal and spikes/b-image — see their READMEs for the gotchas.
import { readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { config } from "../config";
import type { ByteStream, ExecResult, TerminalHandle, ProjectDriver, ProjectInfo, ProjectStats } from "./types";

const BIN = config.containerBin;
const volname = (ref: string) => `${ref}-workdir`;

// No call into a VM or the container service waits forever: a stuck VM hangs
// commands rather than failing them, and every hung command is a process (and
// a request) that never goes away. Each call gets one of these unless the
// caller knows better.
/** Status queries and short guest commands. */
const QUICK_MS = 30_000;
/** Booting a VM (may pull the image) and tearing one down. */
const LIFECYCLE_MS = 5 * 60_000;

const TIMED_OUT = 124; // exit code reported for a call that was given up on
const timedOutMsg = (ms: number) => `the VM did not respond within ${Math.round(ms / 1000)} s`;

/** Resolve with `done`, or — if it has not settled within `ms` — kill the
 *  process and resolve with `late`. The pipes are not waited for after the
 *  kill: a child of the command may still hold them open. */
function orTimeout<T>(proc: { kill(signal?: number | NodeJS.Signals): void }, done: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: Timer | undefined;
  const gaveUp = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done.catch(() => {});
      resolve(late);
    }, ms);
  });
  return Promise.race([done, gaveUp]).finally(() => clearTimeout(timer));
}

async function run(args: string[], stdin?: Blob | Uint8Array, timeoutMs = QUICK_MS): Promise<ExecResult> {
  const proc = Bun.spawn([BIN, ...args], {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr }));
  return orTimeout(proc, done, timeoutMs, { exitCode: TIMED_OUT, stdout: "", stderr: timedOutMsg(timeoutMs) });
}

/** Last resort for a VM that neither stops nor dies: each VM runs under its
 *  own launchd service, and removing that takes the VM down with it. Verified
 *  on container 1.4.1 with a frozen runtime: the VM then reads as stopped and
 *  starts again normally, disk intact. */
async function unloadRuntime(ref: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid == null) return;
  const label = `com.apple.container.container-runtime-linux.${ref}`;
  for (const domain of [`user/${uid}`, `gui/${uid}`]) {
    const p = Bun.spawn(["launchctl", "bootout", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" });
    if (await orTimeout(p, p.exited, 10_000, 1) === 0) return;
  }
}

async function settledOff(d: Pick<ProjectDriver, "inspect">, ref: string, withinMs: number): Promise<boolean> {
  for (const until = Date.now() + withinMs; ;) {
    if ((await d.inspect(ref)).state !== "running") return true;
    if (Date.now() >= until) return false;
    await Bun.sleep(400);
  }
}

// inspect/list element shape (verified against container CLI 1.4.1):
// { configuration: { id, resources: { cpus, memoryInBytes } },
//   status: { state, networks: [{ ipv4Address }] } }
function parseInfo(c: any): ProjectInfo | null {
  const ref = c?.configuration?.id;
  if (!ref) return null;
  const res = c?.configuration?.resources;
  // status.networks is live; a stopped VM only has the configured attachment
  const net = c?.status?.networks?.[0];
  const configured = c?.configuration?.networks ?? [];
  return {
    ref,
    state: c?.status?.state === "running" ? "running" : "stopped",
    address: (net?.ipv4Address as string | undefined)?.split("/")[0],
    gateway: net?.ipv4Gateway,
    network: net?.network ?? configured[0]?.network,
    isolated: !net && configured.length === 0,
    cpus: res?.cpus,
    memoryLimitBytes: res?.memoryInBytes,
  };
}

export const containerDriver: ProjectDriver = {
  name: "container",
  capabilities: { snapshot: false, sharedMount: true, routableIp: true },

  async create(ref, image, opts) {
    const res: string[] = [];
    if (opts?.cpus) res.push("--cpus", String(opts.cpus));
    if (opts?.memoryMB) res.push("--memory", `${opts.memoryMB}M`);
    if (opts?.diskGB) {
      // sized volume mounted at the workdir caps the project's disk usage
      // (the rootfs itself is thin-provisioned and can't be capped)
      const vol = volname(ref);
      await run(["volume", "delete", vol]); // clear any stale volume, ignore error
      const v = await run(["volume", "create", "-s", `${opts.diskGB}G`, vol]);
      if (v.exitCode !== 0) throw new Error(`volume create failed: ${v.stderr.trim()}`);
      res.push("--mount", `type=volume,source=${vol},target=${config.guestWorkdir}`);
    }
    if (opts?.network) res.push("--network", opts.network);
    if (opts?.socket) {
      // verified on container 1.4.1: the host side survives failed dials, the
      // guest listener restarting, and the VM being stopped and started
      await rm(opts.socket.host, { force: true }); // the runtime creates it
      res.push("--publish-socket", `${opts.socket.host}:${opts.socket.guest}`);
    }
    const r = await run(["run", "--name", ref, "--detach", ...res, image], undefined, LIFECYCLE_MS);
    if (r.exitCode !== 0) throw new Error(`container run failed: ${r.stderr.trim()}`);
  },

  async destroy(ref) {
    await this.stop(ref).catch(() => {}); // also gets a hung VM out of the way
    const r = await run(["rm", "--force", ref], undefined, LIFECYCLE_MS);
    if (r.exitCode !== 0 && !/no such|not found/i.test(r.stderr)) {
      throw new Error(`container rm failed: ${r.stderr.trim()}`);
    }
    await run(["volume", "delete", volname(ref)]); // best effort; ignore if none
  },

  async start(ref) {
    const r = await run(["start", ref], undefined, 60_000);
    if (r.exitCode !== 0) throw new Error(`container start failed: ${r.stderr.trim()}`);
  },

  async stop(ref) {
    // A hung VM ignores a polite stop, and its commands (this one included)
    // hang with it — so escalate, each step with its own limit.
    const r = await run(["stop", "--time", "5", ref], undefined, 12_000);
    if (r.exitCode === 0 && (await this.inspect(ref)).state !== "running") return;
    await run(["kill", ref], undefined, 5_000);
    if (await settledOff(this, ref, 2_000)) return;
    await unloadRuntime(ref);
    if (await settledOff(this, ref, 8_000)) return;
    throw new Error(`could not stop the VM${r.stderr.trim() ? `: ${r.stderr.trim()}` : " (it is not responding)"}`);
  },

  // The CLI has no way to resize an existing container, and recreating one
  // loses everything outside the workdir volume (agent logins, installed
  // packages). The runtime reads the VM's size from its stored configuration
  // each time it boots, though, so that is edited in place. Verified on
  // container 1.4.1: the guest boots with the new size and the disk as it was.
  // `inspect`/`list` keep reporting the old size until the container service
  // restarts; `stats` and the guest itself report the new one.
  async setMemory(ref, memoryMB) {
    if ((await this.inspect(ref)).state === "running") throw new Error("the VM must be stopped to change its memory");
    const dir = join(config.containerDataDir, "containers", ref);
    const field = /("memoryInBytes"\s*:\s*)\d+/g;
    const edits: { path: string; text: string }[] = [];
    for (const name of ["config.json", "runtime-configuration.json"]) {
      const path = join(dir, name);
      const text = await readFile(path, "utf8").catch(() => null);
      // a textual edit, so nothing else in the file is reformatted
      if (text == null || !text.match(field)) throw new Error(`cannot change this VM's memory in place (${name} is not as expected) — Rebuild applies it instead`);
      edits.push({ path, text: text.replace(field, `$1${memoryMB * 1024 * 1024}`) });
    }
    for (const { path, text } of edits) {
      await writeFile(`${path}.sadbox-tmp`, text);
      await rename(`${path}.sadbox-tmp`, path);
    }
  },

  async inspect(ref) {
    const r = await run(["inspect", ref]);
    if (r.exitCode !== 0) return { ref, state: "unknown" };
    try {
      const j = JSON.parse(r.stdout);
      const c = Array.isArray(j) ? j[0] : j;
      return parseInfo(c) ?? { ref, state: "unknown" as const };
    } catch {
      return { ref, state: "unknown" };
    }
  },

  async list() {
    const r = await run(["list", "--all", "--format", "json"]);
    if (r.exitCode !== 0) return [];
    try {
      const j = JSON.parse(r.stdout) as any[];
      return j
        .map(parseInfo)
        .filter((w): w is ProjectInfo => w !== null && w.ref !== "buildkit");
    } catch {
      return [];
    }
  },

  async stats(ref, timeoutMs): Promise<ProjectStats | null> {
    const r = await run(["stats", "--no-stream", "--format", "json", ref], undefined, timeoutMs);
    if (r.exitCode !== 0) return null;
    try {
      const j = JSON.parse(r.stdout);
      const s = Array.isArray(j) ? j[0] : j;
      if (!s) return null;
      return {
        cpuUsageUsec: s.cpuUsageUsec,
        memoryUsageBytes: s.memoryUsageBytes,
        memoryLimitBytes: s.memoryLimitBytes,
        numProcesses: s.numProcesses,
        networkRxBytes: s.networkRxBytes,
        networkTxBytes: s.networkTxBytes,
        blockReadBytes: s.blockReadBytes,
        blockWriteBytes: s.blockWriteBytes,
      };
    } catch {
      return null;
    }
  },

  async exec(ref, cmd, opts) {
    const user = opts?.user ? ["-u", opts.user] : [];
    return run(["exec", ...user, ref, ...cmd], undefined, opts?.timeoutMs);
  },

  async execWithStdin(ref, shellCmd, stdin, opts) {
    const user = opts?.user ? ["-u", opts.user] : [];
    return run(["exec", "-i", ...user, ref, "sh", "-c", shellCmd], stdin, opts?.timeoutMs);
  },

  stream(ref, shellCmd): ByteStream {
    let dataCb: (chunk: Uint8Array) => void = () => {};
    let closeCb: () => void = () => {};
    const proc = Bun.spawn([BIN, "exec", "-i", ref, "sh", "-c", shellCmd], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    (async () => {
      try { for await (const chunk of proc.stdout) dataCb(chunk); } catch {}
      await proc.exited.catch(() => {});
      closeCb();
    })();
    return {
      write(chunk) { try { proc.stdin.write(chunk); proc.stdin.flush(); } catch {} },
      end() { try { proc.stdin.end(); } catch {} },
      kill() { try { proc.kill(); } catch {} },
      onData(cb) { dataCb = cb; },
      onClose(cb) { closeCb = cb; },
    };
  },

  async execCaptureBytes(ref, shellCmd, opts) {
    const proc = Bun.spawn([BIN, "exec", ref, "sh", "-c", shellCmd], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // via arrayBuffer(): Response.bytes() does not reliably hand back a
    // Uint8Array for multi-megabyte output under Bun 1.3
    const done = Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]).then(([buf, exitCode]) => ({ exitCode, stdout: new Uint8Array(buf) }));
    return orTimeout(proc, done, opts?.timeoutMs ?? QUICK_MS, { exitCode: TIMED_OUT, stdout: new Uint8Array() });
  },

  terminal(ref, cmd, size) {
    let dataCb: (chunk: Uint8Array) => void = () => {};
    let exitCb: () => void = () => {};
    const proc = Bun.spawn(
      [BIN, "exec", "-it", "--env", "COLORTERM", ref, ...cmd],
      {
        // Pin TERM: Bun.Terminal's `name` does not override an inherited TERM,
        // and the guest has no terminfo for exotic host terminals (spike A).
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal: {
          cols: size.cols,
          rows: size.rows,
          name: "xterm-256color",
          data(_t: unknown, chunk: Uint8Array) { dataCb(chunk); },
          exit() { exitCb(); },
        },
      },
    );
    proc.exited.then(() => exitCb());
    return {
      write(data) { proc.terminal?.write(data as any); },
      resize(cols, rows) { proc.terminal?.resize(cols, rows); },
      kill() {
        proc.kill();
        proc.terminal?.close(); // else the PTY refs the event loop forever (spike A)
      },
      onData(cb) { dataCb = cb; },
      onExit(cb) { exitCb = cb; },
    };
  },
};
