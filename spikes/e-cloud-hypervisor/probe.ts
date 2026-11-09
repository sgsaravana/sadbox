// Spike E probe: drives sadbox-agent in a guest and checks what the driver
// needs (docs/ROADMAP.md L0) — exec, exit codes, users, stdin/stdout streaming,
// PTY + resize, the socket channel, guest loopback, Claude Code's TUI under
// tmux — and times it.
//
//   bun probe.ts --vsock /tmp/sbx-e/ch.vsock     (Cloud Hypervisor's hybrid vsock)
//   bun probe.ts --tcp 192.168.64.5:1024          (agent run with -listen tcp:…)
//   bun probe.ts --relay sbx-e-agent              (local testing: each connection is
//                                                  carried by `container exec` to the
//                                                  agent's tcp:127.0.0.1:1024; timings
//                                                  then include exec's own cost)
//   bun probe.ts --vsock … --wait 30000           (retry the first ping: boot timing)
//   bun probe.ts --vsock … --json results.json    (also write the results as JSON)
//   --since <epoch ms>   also report bootMs: from then (the VMM's launch) to the first answer
//   --ping-only          stop after the first answer (a restart's boot time)
//   --poweroff           power the VM off at the end
//   --vmm-pid <pid>      give up waiting as soon as that process (the VMM) has exited
import net from "node:net";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createHash, randomBytes } from "node:crypto";

const F = { req: 0, stdin: 1, stdinEOF: 2, resize: 3, signal: 4, started: 10, stdout: 11, stderr: 12, exit: 13, error: 14, ok: 15 } as const;
const AGENT_PORT = 1024;

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const vsockPath = arg("--vsock");
const tcp = arg("--tcp");
const relay = arg("--relay");
const waitMs = Number(arg("--wait") ?? 0);
const jsonOut = arg("--json");
const since = Number(arg("--since") ?? 0);
const pingOnly = process.argv.includes("--ping-only");
const powerOff = process.argv.includes("--poweroff");
const vmmPid = Number(arg("--vmm-pid") ?? 0);
if (!vsockPath && !tcp && !relay) { console.error("usage: bun probe.ts --vsock <ch.vsock> | --tcp host:port | --relay <container>"); process.exit(2); }

// ---- transport + framing ----
/** A connection to the agent. Cloud Hypervisor's hybrid vsock is a unix
 *  socket on the host: "CONNECT <port>\n" → "OK <n>\n", then the stream. */
function dial(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (relay) {
      const p = spawn("container", ["exec", "-i", relay, "bun", "-e",
        `const s=require("net").connect(1024,"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("end",()=>process.stdout.end());s.on("error",()=>process.exit(1))`],
        { stdio: ["pipe", "pipe", "ignore"] });
      const d = Duplex.from({ readable: p.stdout!, writable: p.stdin! }) as unknown as net.Socket;
      const destroy = d.destroy.bind(d);
      (d as any).destroy = () => { p.kill(); return destroy(); };
      resolve(d);
      return;
    }
    if (tcp) {
      const [h, p] = tcp.split(":");
      const s = net.connect(Number(p), h, () => resolve(s));
      s.once("error", reject);
      return;
    }
    const s = net.connect(vsockPath!, () => s.write(`CONNECT ${AGENT_PORT}\n`));
    s.once("error", reject);
    let line = "";
    const onData = (d: Buffer) => {
      line += d.toString("latin1");
      const nl = line.indexOf("\n");
      if (nl < 0) return;
      s.off("data", onData);
      if (!line.startsWith("OK")) { s.destroy(); reject(new Error(`vsock: ${line.slice(0, nl)}`)); return; }
      const rest = Buffer.from(line.slice(nl + 1), "latin1");
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on("data", onData);
  });
}

const frame = (t: number, p: Uint8Array = new Uint8Array()) => {
  const h = Buffer.alloc(5); h[0] = t; h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
};
const jframe = (t: number, v: unknown) => frame(t, Buffer.from(JSON.stringify(v)));

type Frame = { t: number; p: Buffer };
/** Frames off a socket, as they arrive. */
function frames(s: net.Socket, on: (f: Frame) => void, onEnd: () => void) {
  let buf = Buffer.alloc(0);
  s.on("data", (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) break;
      on({ t: buf[0], p: buf.subarray(5, 5 + n) });
      buf = buf.subarray(5 + n);
    }
  });
  s.on("close", onEnd);
  s.on("error", () => {});
}

interface Session {
  write(d: Uint8Array | string): void;
  end(): void;
  resize(cols: number, rows: number): void;
  signal(n: number): void;
  close(): void;
  onData(cb: (d: Buffer, stream: "stdout" | "stderr") => void): void;
  done: Promise<{ code: number; signal: number; error?: string }>;
}

async function open(req: Record<string, unknown>): Promise<Session> {
  const s = await dial();
  const listeners: ((d: Buffer, stream: "stdout" | "stderr") => void)[] = [];
  let finish!: (v: { code: number; signal: number; error?: string }) => void;
  const done = new Promise<{ code: number; signal: number; error?: string }>((r) => (finish = r));
  frames(s, (f) => {
    if (f.t === F.stdout || f.t === F.stderr) for (const l of listeners) l(f.p, f.t === F.stdout ? "stdout" : "stderr");
    else if (f.t === F.exit) finish(JSON.parse(f.p.toString()));
    else if (f.t === F.error) finish({ code: -1, signal: 0, error: JSON.parse(f.p.toString()).message });
  }, () => finish({ code: -1, signal: 0, error: "connection closed" }));
  s.write(jframe(F.req, req));
  return {
    write: (d) => s.write(frame(F.stdin, typeof d === "string" ? Buffer.from(d) : d)),
    end: () => s.write(frame(F.stdinEOF)),
    resize: (cols, rows) => s.write(jframe(F.resize, { cols, rows })),
    signal: (n) => s.write(frame(F.signal, Uint8Array.of(n))),
    close: () => s.destroy(),
    onData: (cb) => { listeners.push(cb); },
    done,
  };
}

async function exec(argv: string[], opts: { user?: string; stdin?: Uint8Array } = {}) {
  const sess = await open({ op: "exec", argv, user: opts.user });
  const out: Buffer[] = [], err: Buffer[] = [];
  sess.onData((d, st) => (st === "stdout" ? out : err).push(Buffer.from(d)));
  if (opts.stdin) {
    for (let i = 0; i < opts.stdin.length; i += 1 << 20) sess.write(opts.stdin.subarray(i, i + (1 << 20)));
  }
  sess.end();
  const r = await sess.done;
  sess.close();
  return { ...r, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

async function request(req: Record<string, unknown>): Promise<any> {
  const s = await dial();
  return new Promise((resolve, reject) => {
    frames(s, (f) => {
      if (f.t === F.ok) { resolve(JSON.parse(f.p.toString())); s.destroy(); }
      else if (f.t === F.error) { reject(new Error(JSON.parse(f.p.toString()).message)); s.destroy(); }
    }, () => reject(new Error("connection closed")));
    s.write(jframe(F.req, req));
  });
}

// ---- checks ----
type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const timings: Record<string, number> = {};
async function check(name: string, fn: () => Promise<string>) {
  try { results.push({ name, ok: true, detail: await fn() }); }
  catch (e) { results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  const r = results.at(-1)!;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${name} — ${r.detail}`);
}
function expect(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const sh = (s: string, user?: string) => exec(["sh", "-c", s], { user });
const ms = (t0: number) => Math.round(performance.now() - t0);
const ESC = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b\([B0]/g;

/** Wait until `get()` matches, or fail after `limit` ms. */
async function until(get: () => string, re: RegExp, limit: number, what: string) {
  const t0 = Date.now();
  while (!re.test(get())) {
    if (Date.now() - t0 > limit) throw new Error(`${what}: not seen in ${limit} ms`);
    await Bun.sleep(50);
  }
}

/** Running, not gone or a zombie (an exited child stays one until its parent waits). */
function alive(pid: number): boolean {
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch { return false; }
}

// first contact (with --wait: the boot measurement, from now until the agent answers)
const t0 = performance.now();
let hello: any;
for (;;) {
  try { hello = await request({ op: "ping" }); break; }
  catch (e) {
    if (vmmPid && !alive(vmmPid)) { console.error(`the VMM (pid ${vmmPid}) exited before the agent answered`); process.exit(1); }
    if (performance.now() - t0 > waitMs) { console.error(`agent not reachable: ${(e as Error).message}`); process.exit(1); }
    await Bun.sleep(20);
  }
}
timings.firstPingMs = ms(t0);
if (since) timings.bootMs = Date.now() - since;
console.log(`agent: ${JSON.stringify(hello)} (first answer after ${timings.firstPingMs} ms${since ? `, ${timings.bootMs} ms after launch` : ""})`);

async function finish(failed: number): Promise<never> {
  if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ agent: hello, results, timings }, null, 2));
  if (powerOff) await request({ op: "poweroff" }).catch(() => {});
  process.exit(failed ? 1 : 0);
}
if (pingOnly) await finish(0);

await check("ping round trip", async () => {
  const n = 50, t = performance.now();
  for (let i = 0; i < n; i++) await request({ op: "ping" });
  timings.pingMs = +((performance.now() - t) / n).toFixed(2);
  return `${timings.pingMs} ms avg over ${n}`;
});

await check("exec as the image user, in its workdir", async () => {
  const r = await sh("id -un; pwd; echo $HOME; echo $PATH");
  expect(r.code === 0, `exit ${r.code} ${r.error ?? r.stderr}`);
  const [who, pwd, home, path] = r.stdout.toString().trim().split("\n");
  expect(who === "agent", `user ${who}`);
  expect(path.includes(".bun/bin"), `image PATH missing: ${path}`);
  return `${who} in ${pwd}, HOME=${home}`;
});

await check("exec as root", async () => {
  const r = await exec(["id", "-u"], { user: "root" });
  expect(r.stdout.toString().trim() === "0", r.stdout.toString() + r.stderr);
  return "uid 0";
});

await check("exit codes, stderr kept apart, signals", async () => {
  const r = await sh("echo out; echo err >&2; exit 7");
  expect(r.code === 7 && r.stdout.toString() === "out\n" && r.stderr.toString() === "err\n", JSON.stringify({ ...r, stdout: r.stdout.toString(), stderr: r.stderr.toString() }));
  const k = await sh("kill -TERM $$");
  expect(k.signal === 15 && k.code === 143, `kill: ${JSON.stringify(k)}`);
  const missing = await exec(["no-such-binary"]);
  expect(missing.error?.includes("not found"), `missing binary: ${JSON.stringify(missing)}`);
  return "7, err on stderr, SIGTERM → 143, missing binary → error";
});

await check("exec latency (`true`)", async () => {
  const n = 30, xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await exec(["true"]); xs.push(performance.now() - t); }
  xs.sort((a, b) => a - b);
  timings.execP50Ms = +xs[n >> 1].toFixed(1);
  timings.execP95Ms = +xs[Math.floor(n * 0.95)].toFixed(1);
  return `p50 ${timings.execP50Ms} ms, p95 ${timings.execP95Ms} ms`;
});

await check("stdin streaming (64 MB through sha256sum)", async () => {
  const data = randomBytes(64 << 20);
  const t = performance.now();
  const r = await exec(["sha256sum"], { stdin: data });
  const secs = (performance.now() - t) / 1000;
  const want = createHash("sha256").update(data).digest("hex");
  expect(r.stdout.toString().startsWith(want), `digest ${r.stdout.toString().slice(0, 64)} ≠ ${want}`);
  timings.stdinMBps = Math.round(64 / secs);
  return `${timings.stdinMBps} MB/s, digest matches`;
});

await check("stdout streaming (256 MB)", async () => {
  const t = performance.now();
  const r = await sh("head -c 268435456 /dev/zero");
  const secs = (performance.now() - t) / 1000;
  expect(r.stdout.length === 256 << 20, `got ${r.stdout.length} bytes (exit ${r.code}${r.error ? `, ${r.error}` : ""})`);
  timings.stdoutMBps = Math.round(256 / secs);
  return `${timings.stdoutMBps} MB/s`;
});

await check("output written just before exit is all delivered", async () => {
  const r = await sh("for i in $(seq 1 2000); do echo line-$i; done");
  const lines = r.stdout.toString().trim().split("\n");
  expect(lines.length === 2000 && lines.at(-1) === "line-2000", `${lines.length} lines`);
  return "2000/2000 lines";
});

await check("a background child holding stdout does not hang exec", async () => {
  const t = performance.now();
  const r = await sh("sleep 30 & echo started");
  expect(r.stdout.toString() === "started\n", r.stdout.toString());
  const took = ms(t);
  expect(took < 5000, `took ${took} ms`);
  return `returned after ${took} ms`;
});

await check("closing the connection kills the process", async () => {
  const sess = await open({ op: "exec", argv: ["sh", "-c", "echo $$; exec sleep 300"] });
  let pid = "";
  sess.onData((d) => (pid += d.toString()));
  await until(() => pid, /\d+\n/, 5000, "pid");
  sess.close();
  await Bun.sleep(300);
  const r = await sh(`kill -0 ${pid.trim()} 2>/dev/null && echo alive || echo gone`);
  expect(r.stdout.toString().trim() === "gone", r.stdout.toString());
  return `pid ${pid.trim()} gone`;
});

await check("PTY: a tty, its size, input, resize", async () => {
  const sess = await open({ op: "exec", argv: ["bash", "--norc", "-i"], tty: { cols: 100, rows: 30 } });
  let out = "";
  sess.onData((d) => (out += d.toString()));
  sess.write("tty; stty size\r");
  await until(() => out, /\/dev\/pts\/\d+[\s\S]*30 100/, 5000, "tty + size");
  sess.resize(132, 43);
  sess.write("stty size\r");
  await until(() => out, /43 132/, 5000, "resized size");
  sess.write("read x; echo got:$x\r");
  await Bun.sleep(300); // bash runs `read` before the answer is typed
  sess.write("hello\r");
  await until(() => out, /got:hello/, 5000, "input");
  sess.write("exit 3\r");
  const r = await sess.done;
  sess.close();
  expect(r.code === 3, `exit ${JSON.stringify(r)}`);
  return "/dev/pts/N, 30x100 → 43x132, input echoed, exit 3";
});

await check("connect: the host dials a unix socket in the guest", async () => {
  const path = "/run/sadbox-spike-echo.sock";
  const server = await open({
    op: "exec", user: "root",
    argv: ["bun", "-e", `require("fs").rmSync("${path}",{force:true});require("net").createServer(s=>s.pipe(s)).listen("${path}",()=>console.log("listening"))`],
  });
  let srvOut = "";
  server.onData((d) => (srvOut += d.toString()));
  await until(() => srvOut, /listening/, 10000, "echo server");
  const s = await dial();
  const got: Buffer[] = [];
  let ok = false;
  const payload = randomBytes(1 << 20);
  await new Promise<void>((resolve, reject) => {
    let header = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      if (!ok) {
        header = Buffer.concat([header, d]);
        if (header.length < 5) return;
        const n = header.readUInt32BE(1);
        if (header.length < 5 + n) return;
        if (header[0] !== F.ok) return reject(new Error(header.subarray(5, 5 + n).toString()));
        ok = true;
        const rest = header.subarray(5 + n);
        if (rest.length) got.push(rest);
        s.write(payload);
      } else got.push(d);
      if (Buffer.concat(got).length >= payload.length) resolve();
    });
    s.on("error", reject);
    s.write(jframe(F.req, { op: "connect", path }));
    setTimeout(() => reject(new Error("echo timed out")), 10000);
  });
  s.destroy();
  server.close();
  expect(Buffer.concat(got).equals(payload), "echo differs");
  return "1 MB echoed through a guest unix socket";
});

await check("guest loopback (apps on 127.0.0.1)", async () => {
  const r = await exec(["bun", "-e", `const s=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response("hi")});console.log(await (await fetch("http://127.0.0.1:"+s.port)).text());s.stop()`]);
  expect(r.stdout.toString().trim() === "hi", r.stdout.toString() + r.stderr.toString());
  return "listen + fetch on 127.0.0.1";
});

await check("sudo works for the agent user", async () => {
  const r = await sh("sudo -n id -u");
  expect(r.stdout.toString().trim() === "0", r.stdout.toString() + r.stderr.toString());
  return "sudo -n → uid 0";
});

await check("Claude Code's TUI under tmux, through the PTY", async () => {
  const sess = await open({ op: "exec", argv: ["tmux", "new-session", "-A", "-s", "spike"], tty: { cols: 120, rows: 35 } });
  let out = "";
  sess.onData((d) => (out += d.toString("latin1")));
  await until(() => out, /\x1b\[\?1049h|\x1b\[H/, 10000, "tmux screen");
  sess.write("claude\r");
  await until(() => out.replace(ESC, ""), /Claude Code|Welcome|theme|Anthropic/i, 20000, "Claude Code text");
  const truecolor = /\x1b\[38;2;\d+;\d+;\d+m/.test(out);
  sess.write("\x03"); await Bun.sleep(300); sess.write("\x03"); await Bun.sleep(300);
  sess.close();
  await sh("tmux kill-server 2>/dev/null; true");
  return `TUI drawn (${out.length} bytes${truecolor ? ", truecolor" : ""})`;
});

// ---- report ----
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
console.log(`timings: ${JSON.stringify(timings)}`);
await finish(failed);
