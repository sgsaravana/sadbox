// Apple `container` CLI driver (macOS). Every recipe here was proven in
// spikes/a-terminal and spikes/b-image — see their READMEs for the gotchas.
import { config } from "../config";
import type { ExecResult, TerminalHandle, WorkerDriver, WorkerInfo } from "./types";

const BIN = config.containerBin;

async function run(args: string[], stdin?: Blob | Uint8Array): Promise<ExecResult> {
  const proc = Bun.spawn([BIN, ...args], {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// inspect/list element shape (verified against container CLI 1.4.1):
// { configuration: { id }, status: { state, networks: [{ ipv4Address }] } }
function parseInfo(c: any): WorkerInfo | null {
  const ref = c?.configuration?.id;
  if (!ref) return null;
  return {
    ref,
    state: c?.status?.state === "running" ? "running" : "stopped",
    address: (c?.status?.networks?.[0]?.ipv4Address as string | undefined)?.split("/")[0],
  };
}

export const containerDriver: WorkerDriver = {
  name: "container",
  capabilities: { snapshot: false, sharedMount: true, routableIp: true },

  async create(ref, image) {
    const r = await run(["run", "--name", ref, "--detach", image]);
    if (r.exitCode !== 0) throw new Error(`container run failed: ${r.stderr.trim()}`);
  },

  async destroy(ref) {
    await run(["stop", ref]);
    const r = await run(["rm", ref]);
    if (r.exitCode !== 0 && !/no such|not found/i.test(r.stderr)) {
      throw new Error(`container rm failed: ${r.stderr.trim()}`);
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
        .filter((w): w is WorkerInfo => w !== null && w.ref !== "buildkit");
    } catch {
      return [];
    }
  },

  async exec(ref, cmd, opts) {
    const user = opts?.user ? ["-u", opts.user] : [];
    return run(["exec", ...user, ref, ...cmd]);
  },

  async execWithStdin(ref, shellCmd, stdin) {
    return run(["exec", "-i", ref, "sh", "-c", shellCmd], stdin);
  },

  async execCaptureBytes(ref, shellCmd) {
    const proc = Bun.spawn([BIN, "exec", ref, "sh", "-c", shellCmd], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      proc.exited,
    ]);
    return { exitCode, stdout };
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
