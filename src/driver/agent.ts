// The host's side of sadbox-agent (guest/agent), the guest agent in Linux
// (Cloud Hypervisor) VMs: what driver/kvm runs guest commands, terminals and
// the proxy's socket through. The protocol is in guest/agent/README.md; it was
// proven in spikes/e-cloud-hypervisor.
//
// One operation per connection. How a connection is made is the caller's
// (`Dial`): CH's hybrid vsock in a VM, a plain unix socket in tests.
import net from "node:net";
import type { ByteStream, ExecResult, TerminalHandle } from "./types";

/** The vsock port the agent serves on. */
export const AGENT_PORT = 1024;
/** The protocol this client speaks; the agent reports its own in ping. */
export const PROTOCOL = 1;

const F = { req: 0, stdin: 1, stdinEOF: 2, resize: 3, signal: 4, started: 10, stdout: 11, stderr: 12, exit: 13, error: 14, ok: 15 } as const;
/** Largest stdin frame sent; the agent accepts up to 16 MB. */
const CHUNK = 1 << 20;
const QUICK_MS = 30_000;
const TIMED_OUT = 124; // as the macOS driver reports a call that was given up on
const UNREACHABLE = 255; // no answer at all: the agent could not be reached, or hung up
const timedOutMsg = (ms: number) => `the VM did not respond within ${Math.round(ms / 1000)} s`;

/** What ping and the ready announcement say about the agent. */
export interface Hello {
  agent: string;    // its version
  protocol: number;
  pid1: boolean;    // running as the VM's init
  uptimeMs: number;
  kernel: string;
  machine: string;
}

/** Opens a connection to the agent, ready for frames. */
export type Dial = () => Promise<net.Socket>;

/** Cloud Hypervisor's hybrid vsock: the guest's vsock is a unix socket on the
 *  host, and each connection starts with "CONNECT <port>\n" → "OK <n>\n". */
export function hybridVsock(path: string, port = AGENT_PORT, handshakeMs = 2000): Dial {
  return () => new Promise((resolve, reject) => {
    const s = net.connect(path, () => s.write(`CONNECT ${port}\n`));
    // CH can take the CONNECT before anything in the guest listens, and then
    // never answers it (spike E): give up on this attempt
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`vsock: no answer to CONNECT in ${handshakeMs} ms`)); }, handshakeMs);
    const onError = (e: Error) => { clearTimeout(timer); reject(e); };
    const onClose = () => { clearTimeout(timer); reject(new Error("vsock: closed during CONNECT")); };
    s.once("error", onError);
    s.once("close", onClose);
    s.on("error", () => {}); // later errors: "close" follows, and the user of the socket sees that
    let line = "";
    const onData = (d: Buffer) => {
      line += d.toString("latin1");
      const nl = line.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      s.off("data", onData);
      s.off("close", onClose);
      s.off("error", onError);
      s.pause();
      if (!line.startsWith("OK ")) { s.destroy(); reject(new Error(`vsock: ${line.slice(0, nl)}`)); return; }
      const rest = Buffer.from(line.slice(nl + 1), "latin1");
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on("data", onData);
  });
}

/** A unix socket the agent listens on directly (`-listen unix:PATH`). */
export function unixSocket(path: string): Dial {
  return () => new Promise((resolve, reject) => {
    const s = net.connect(path, () => { s.off("error", reject); resolve(s); });
    s.once("error", reject);
    s.on("error", () => {}); // later errors: "close" follows
  });
}

// ---- framing ----
function frame(t: number, p: Uint8Array = new Uint8Array()): Buffer {
  const h = Buffer.alloc(5);
  h[0] = t;
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
}
const jframe = (t: number, v: unknown) => frame(t, Buffer.from(JSON.stringify(v)));

/** Frames off a socket as they arrive; `onEnd` once it closes. */
function readFrames(s: net.Socket, on: (t: number, p: Buffer) => void, onEnd: () => void) {
  let buf: Buffer = Buffer.alloc(0);
  s.on("data", (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) break;
      const t = buf[0], p = buf.subarray(5, 5 + n);
      buf = buf.subarray(5 + n);
      on(t, p);
    }
  });
  s.on("close", onEnd);
  s.on("error", () => {}); // "close" follows
  s.resume();
}

/** Write, waiting while the socket's buffer is full: a large stdin must not
 *  pile up in memory faster than the guest takes it. */
function writeFlowing(s: net.Socket, b: Uint8Array): Promise<void> {
  if (s.write(b)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { s.off("drain", done); s.off("close", done); resolve(); };
    s.on("drain", done);
    s.on("close", done);
  });
}

// ---- a running exec ----
interface ExecEnd { code: number; signal: number; error?: string }

interface ExecRequest {
  argv: string[];
  user?: string;
  env?: string[];
  cwd?: string;
  tty?: { cols: number; rows: number };
}

/** One exec over one connection. Input sent before the connection is up is
 *  queued; `done` settles once, with the exit, an error from the agent, or
 *  the connection's loss. */
class Exec {
  private sock: net.Socket | null = null;
  private queue: Buffer[] = [];
  private closed = false;
  private settle!: (e: ExecEnd) => void;
  readonly done = new Promise<ExecEnd>((r) => (this.settle = r));
  /** The connection once the request is sent, or null if there will be none. */
  private readonly connected: Promise<net.Socket | null>;

  constructor(dial: Dial, req: ExecRequest, onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => void) {
    this.connected = dial().then((s) => {
      if (this.closed) { s.destroy(); return null; }
      this.sock = s;
      readFrames(s, (t, p) => {
        if (t === F.stdout) onOutput(p, "stdout");
        else if (t === F.stderr) onOutput(p, "stderr");
        else if (t === F.exit) this.settle(JSON.parse(p.toString()));
        else if (t === F.error) this.settle({ code: -1, signal: 0, error: JSON.parse(p.toString()).message });
      }, () => this.settle({ code: -1, signal: 0, error: "the agent hung up" }));
      s.write(jframe(F.req, { op: "exec", ...req }));
      for (const b of this.queue) s.write(b);
      this.queue = [];
      return s;
    }, (e: Error) => { this.settle({ code: -1, signal: 0, error: `cannot reach the agent: ${e.message}` }); return null; });
  }

  private send(b: Buffer) {
    if (this.closed) return;
    if (this.sock) this.sock.write(b); else this.queue.push(b);
  }

  write(d: Uint8Array | string) {
    const b = typeof d === "string" ? Buffer.from(d) : d;
    for (let i = 0; i < b.length; i += CHUNK) this.send(frame(F.stdin, b.subarray(i, i + CHUNK)));
  }

  /** Stream a large input, holding back while the guest catches up. */
  async pipe(src: Blob | Uint8Array) {
    const sock = await this.connected;
    if (!sock) return;
    if (src instanceof Uint8Array) {
      for (let i = 0; i < src.length && !this.closed; i += CHUNK) await writeFlowing(sock, frame(F.stdin, src.subarray(i, i + CHUNK)));
    } else {
      const reader = src.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
        for (let i = 0; i < value.length; i += CHUNK) await writeFlowing(sock, frame(F.stdin, value.subarray(i, i + CHUNK)));
      }
    }
    this.end();
  }

  end() { this.send(frame(F.stdinEOF)); }
  resize(cols: number, rows: number) { this.send(jframe(F.resize, { cols, rows })); }
  /** Hang up; the agent kills the process group. */
  close() {
    this.closed = true;
    this.sock?.destroy();
    this.settle({ code: -1, signal: 0, error: "closed" });
  }
}

/** Run `ms` against `done`; past it, hang up (the agent then kills the
 *  process) and report a timeout. */
async function limited<T>(x: Exec, done: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: Timer | undefined;
  const gaveUp = new Promise<T>((resolve) => { timer = setTimeout(() => { resolve(late); x.close(); }, ms); });
  try { return await Promise.race([done, gaveUp]); }
  finally { clearTimeout(timer); }
}

/** An exec's end as an ExecResult's exit code and a message for stderr. */
function outcome(e: ExecEnd): { exitCode: number; message: string } {
  if (e.error == null) return { exitCode: e.code, message: "" };
  // the agent could not start it: as a shell would say
  if (e.code === -1 && /: not found$/.test(e.error)) return { exitCode: 127, message: e.error };
  if (/^(cannot reach the agent|the agent hung up)/.test(e.error)) return { exitCode: UNREACHABLE, message: e.error };
  return { exitCode: 126, message: e.error };
}

// ---- the client ----
export interface AgentClient {
  ping(timeoutMs?: number): Promise<Hello>;
  /** Ask the guest to shut down; resolves once it has said yes. */
  poweroff(timeoutMs?: number): Promise<void>;
  exec(argv: string[], opts?: { user?: string; env?: string[]; cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  execWithStdin(shellCmd: string, stdin: Blob | Uint8Array, opts?: { user?: string; timeoutMs?: number }): Promise<ExecResult>;
  execCaptureBytes(shellCmd: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: Uint8Array }>;
  stream(shellCmd: string): ByteStream;
  terminal(argv: string[], size: { cols: number; rows: number }): TerminalHandle;
  /** Put a virtiofs share (or the file or folder `sub` in it) at `guestPath`. */
  mount(m: { tag: string; sub?: string; guestPath: string; file?: boolean }, timeoutMs?: number): Promise<void>;
  /** A raw byte connection to a unix socket in the guest (the proxy's
   *  carriers). It comes back paused, so nothing is lost before it is used:
   *  pipe() it, or resume() it after adding a "data" listener. */
  connect(guestPath: string, timeoutMs?: number): Promise<net.Socket>;
}

export function agentClient(dial: Dial): AgentClient {
  /** A request answered by one ok (or error) frame. */
  async function request(req: Record<string, unknown>, timeoutMs: number): Promise<any> {
    let s: net.Socket | undefined;
    const attempt = (async () => {
      s = await dial();
      return new Promise((resolve, reject) => {
        readFrames(s!, (t, p) => {
          if (t === F.ok) resolve(JSON.parse(p.toString()));
          else if (t === F.error) reject(new Error(JSON.parse(p.toString()).message));
        }, () => reject(new Error("the agent hung up")));
        s!.write(jframe(F.req, req));
      });
    })();
    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(timedOutMsg(timeoutMs))), timeoutMs); });
    try { return await Promise.race([attempt, timeout]); }
    finally { clearTimeout(timer); s?.destroy(); }
  }

  async function run(req: ExecRequest, stdin: Blob | Uint8Array | null, timeoutMs: number): Promise<ExecResult> {
    const out: Buffer[] = [], err: Buffer[] = [];
    const x = new Exec(dial, req, (d, st) => (st === "stdout" ? out : err).push(Buffer.from(d)));
    if (stdin) x.pipe(stdin); else x.end();
    const end = await limited(x, x.done, timeoutMs, null);
    x.close();
    if (!end) return { exitCode: TIMED_OUT, stdout: "", stderr: timedOutMsg(timeoutMs) };
    const { exitCode, message } = outcome(end);
    const stderr = Buffer.concat(err).toString();
    return { exitCode, stdout: Buffer.concat(out).toString(), stderr: message ? stderr + message + "\n" : stderr };
  }

  return {
    async ping(timeoutMs = QUICK_MS) {
      return request({ op: "ping" }, timeoutMs);
    },

    async poweroff(timeoutMs = 5_000) {
      await request({ op: "poweroff" }, timeoutMs);
    },

    async mount(m, timeoutMs = QUICK_MS) {
      await request({ op: "mount", tag: m.tag, sub: m.sub ?? "", path: m.guestPath, file: !!m.file }, timeoutMs);
    },

    exec(argv, opts) {
      return run({ argv, user: opts?.user, env: opts?.env, cwd: opts?.cwd }, null, opts?.timeoutMs ?? QUICK_MS);
    },

    execWithStdin(shellCmd, stdin, opts) {
      return run({ argv: ["sh", "-c", shellCmd], user: opts?.user }, stdin, opts?.timeoutMs ?? QUICK_MS);
    },

    async execCaptureBytes(shellCmd, opts) {
      const ms = opts?.timeoutMs ?? QUICK_MS;
      const out: Buffer[] = [];
      const x = new Exec(dial, { argv: ["sh", "-c", shellCmd] }, (d, st) => { if (st === "stdout") out.push(Buffer.from(d)); });
      x.end();
      const end = await limited(x, x.done, ms, null);
      x.close();
      if (!end) return { exitCode: TIMED_OUT, stdout: new Uint8Array() };
      return { exitCode: outcome(end).exitCode, stdout: new Uint8Array(Buffer.concat(out)) };
    },

    stream(shellCmd): ByteStream {
      let dataCb: (chunk: Uint8Array) => void = () => {};
      let closeCb: () => void = () => {};
      const x = new Exec(dial, { argv: ["sh", "-c", shellCmd] }, (d, st) => { if (st === "stdout") dataCb(d); });
      x.done.then(() => closeCb());
      return {
        write(chunk) { x.write(chunk); },
        end() { x.end(); },
        kill() { x.close(); },
        onData(cb) { dataCb = cb; },
        onClose(cb) { closeCb = cb; },
      };
    },

    terminal(argv, size): TerminalHandle {
      let dataCb: (chunk: Uint8Array) => void = () => {};
      let exitCb: () => void = () => {};
      const x = new Exec(dial, { argv, tty: size, env: ["COLORTERM=truecolor"] }, (d) => dataCb(d));
      x.done.then(() => exitCb());
      return {
        write(data) { x.write(data); },
        resize(cols, rows) { x.resize(cols, rows); },
        kill() { x.close(); },
        onData(cb) { dataCb = cb; },
        onExit(cb) { exitCb = cb; },
      };
    },

    async connect(guestPath, timeoutMs = QUICK_MS) {
      const s = await dial();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { s.destroy(); reject(new Error(timedOutMsg(timeoutMs))); }, timeoutMs);
        let buf: Buffer = Buffer.alloc(0);
        const fail = (e: Error) => { clearTimeout(timer); s.destroy(); reject(e); };
        const onClose = () => fail(new Error("the agent hung up"));
        const onData = (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          if (buf.length < 5) return;
          const n = buf.readUInt32BE(1);
          if (buf.length < 5 + n) return;
          clearTimeout(timer);
          s.off("data", onData);
          s.off("close", onClose);
          s.pause();
          const t = buf[0], p = buf.subarray(5, 5 + n), rest = buf.subarray(5 + n);
          if (t !== F.ok) { fail(new Error(t === F.error ? JSON.parse(p.toString()).message : `unexpected frame ${t}`)); return; }
          if (rest.length) s.unshift(rest);
          resolve(s);
        };
        s.on("data", onData);
        s.on("close", onClose);
        s.on("error", () => {});
        s.resume();
        s.write(jframe(F.req, { op: "connect", path: guestPath }));
      });
    },
  };
}

/** Ping until the agent answers — for when no announcement is coming (an
 *  attempt that hangs is given up on after `attemptMs` and retried). */
export async function waitForAgent(dial: Dial, opts: { timeoutMs: number; attemptMs?: number; gone?: () => boolean }): Promise<Hello> {
  const client = agentClient(dial);
  const until = Date.now() + opts.timeoutMs;
  for (;;) {
    try { return await client.ping(opts.attemptMs ?? 250); }
    catch (e) {
      if (opts.gone?.()) throw new Error("the VM exited before its agent answered");
      if (Date.now() >= until) throw new Error(`the agent did not answer within ${Math.round(opts.timeoutMs / 1000)} s: ${(e as Error).message}`);
      await Bun.sleep(20);
    }
  }
}

/** Listen for the agent's ready announcement (`sadbox.announce=PORT`; under
 *  CH a guest's dial to the host's port P arrives at `<vsock path>_P`). Start
 *  it before booting the VM. */
export function awaitAnnouncement(path: string): { ready: Promise<Hello>; close(): void } {
  let resolve!: (h: Hello) => void;
  const ready = new Promise<Hello>((r) => (resolve = r));
  const server = net.createServer((s) => {
    readFrames(s, (t, p) => {
      if (t !== F.ok) return;
      try { resolve(JSON.parse(p.toString())); } catch {}
      s.destroy();
    }, () => {});
  });
  server.listen(path);
  return { ready, close: () => server.close() };
}
