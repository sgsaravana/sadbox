// The agent client against the real sadbox-agent (guest/agent), built with Go
// and run on this machine as a plain server (no init, a unix socket instead of
// vsock). Skipped where Go is not installed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { agentClient, awaitAnnouncement, hybridVsock, PROTOCOL, unixSocket, waitForAgent, type Hello } from "./agent";

const go = Bun.which("go");
const dir = mkdtempSync("/tmp/sba-"); // short: unix socket paths are limited to ~104 bytes
const sock = join(dir, "agent.sock");
const bin = join(dir, "sadbox-agent");
let agent: ReturnType<typeof Bun.spawn> | undefined;
let announced: Promise<Hello> | undefined;
const client = agentClient(unixSocket(sock));

beforeAll(async () => {
  if (!go) return;
  const build = Bun.spawn([go, "build", "-o", bin, "."], { cwd: resolve(import.meta.dir, "../../guest/agent"), stderr: "pipe" });
  if (await build.exited !== 0) throw new Error(`go build: ${await new Response(build.stderr).text()}`);
  const ann = awaitAnnouncement(join(dir, "ready.sock"));
  announced = ann.ready.finally(() => ann.close());
  agent = Bun.spawn([bin, "-init", "off", "-listen", `unix:${sock}`, "-announce", `unix:${join(dir, "ready.sock")}`], { stderr: "ignore" });
  await waitForAgent(unixSocket(sock), { timeoutMs: 10_000 });
}, 180_000); // the first build may fetch the Go toolchain and modules

afterAll(() => {
  agent?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!go)("sadbox-agent client", () => {
  test("the agent announces itself when ready", async () => {
    const h = await announced!;
    expect(h.protocol).toBe(PROTOCOL);
    expect(h.pid1).toBe(false);
  });

  test("ping", async () => {
    const h = await client.ping();
    expect(h.protocol).toBe(PROTOCOL);
    expect(h.kernel.length).toBeGreaterThan(0);
  });

  test("exec: output, stderr apart, exit code", async () => {
    expect(await client.exec(["sh", "-c", "echo out; echo err >&2; exit 7"]))
      .toEqual({ exitCode: 7, stdout: "out\n", stderr: "err\n" });
  });

  test("exec: cwd and env", async () => {
    const r = await client.exec(["sh", "-c", "pwd; echo $GREETING"], { cwd: "/", env: ["GREETING=hi"] });
    expect(r.stdout).toBe("/\nhi\n");
  });

  test("exec: a missing binary is 127, as a shell says", async () => {
    const r = await client.exec(["no-such-binary"]);
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/no-such-binary: not found/);
  });

  test("exec: an unknown user fails without running anything", async () => {
    const r = await client.exec(["true"], { user: "no-such-user-xyz" });
    expect(r.exitCode).toBe(126);
    expect(r.stderr).toMatch(/user no-such-user-xyz/);
  });

  test("exec: given up on past its limit, and the process is killed", async () => {
    const pidFile = join(dir, "slow.pid");
    const t = Date.now();
    const r = await client.exec(["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`], { timeoutMs: 500 });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toMatch(/did not respond/);
    expect(Date.now() - t).toBeLessThan(3000);
    await Bun.sleep(300);
    const pid = (await Bun.file(pidFile).text()).trim();
    expect((await client.exec(["sh", "-c", `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`])).stdout).toBe("gone\n");
  });

  test("exec: a background child holding stdout does not hang it", async () => {
    const t = Date.now();
    const r = await client.exec(["sh", "-c", "sleep 30 & echo started"]);
    expect(r.stdout).toBe("started\n");
    expect(Date.now() - t).toBeLessThan(5000);
  });

  test("execWithStdin: a large Blob and bytes arrive whole", async () => {
    const data = crypto.getRandomValues(new Uint8Array(1 << 20));
    const big = new Blob(Array.from({ length: 24 }, () => data)); // 24 MB
    const want = createHash("sha256").update(Buffer.from(await big.arrayBuffer())).digest("hex");
    const r = await client.execWithStdin("shasum -a 256 2>/dev/null || sha256sum", big);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split(" ")[0]).toBe(want);
    expect((await client.execWithStdin("wc -c", data)).stdout.trim()).toBe(String(1 << 20));
  });

  test("execCaptureBytes: binary output, untouched", async () => {
    const r = await client.execCaptureBytes("printf '\\000\\377\\001abc'");
    expect(r.exitCode).toBe(0);
    expect(Array.from(r.stdout)).toEqual([0, 255, 1, 97, 98, 99]);
    const big = await client.execCaptureBytes("head -c 50000000 /dev/zero");
    expect(big.stdout.length).toBe(50_000_000);
  });

  test("stream: bytes both ways, closed once the guest side ends", async () => {
    const s = client.stream("cat");
    const got: Uint8Array[] = [];
    s.onData((c) => got.push(c));
    const closed = new Promise<void>((r) => s.onClose(r));
    s.write(new TextEncoder().encode("hello "));
    s.write(new TextEncoder().encode("world"));
    s.end();
    await closed;
    expect(Buffer.concat(got).toString()).toBe("hello world");
  });

  test("terminal: a tty with its size, resize, input, exit", async () => {
    const t = client.terminal(["sh", "-c", "tty; stty size; read x; stty size; echo got-$x"], { cols: 100, rows: 30 });
    let out = "";
    t.onData((c) => { out += Buffer.from(c).toString(); });
    const exited = new Promise<void>((r) => t.onExit(r));
    for (let i = 0; i < 100 && !out.includes("30 100"); i++) await Bun.sleep(20);
    expect(out).toMatch(/\/dev\/(pts\/|ttys)\d+/);
    t.resize(132, 43);
    await Bun.sleep(100);
    t.write("hi\n");
    await exited;
    expect(out).toContain("43 132");
    expect(out).toContain("got-hi");
  });

  test("terminal: kill ends it", async () => {
    const t = client.terminal(["sleep", "30"], { cols: 80, rows: 24 });
    const exited = new Promise<void>((r) => t.onExit(r));
    await Bun.sleep(200);
    t.kill();
    await exited;
  });

  test("connect: a raw byte channel to a unix socket in the guest", async () => {
    const echo = join(dir, "echo.sock");
    const server = net.createServer((c) => c.pipe(c)).listen(echo);
    try {
      const s = await client.connect(echo);
      const data = crypto.getRandomValues(new Uint8Array(1 << 20));
      const got: Buffer[] = [];
      let n = 0;
      const done = new Promise<void>((r) => s.on("data", (d: Buffer) => { got.push(d); n += d.length; if (n >= data.length) r(); }));
      s.resume();
      s.write(data);
      await done;
      expect(Buffer.concat(got).equals(Buffer.from(data))).toBe(true);
      s.destroy();
      await expect(client.connect(join(dir, "nothing.sock"))).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  test("an agent that cannot be reached: 255, said so", async () => {
    const r = await agentClient(unixSocket(join(dir, "nothing.sock"))).exec(["true"]);
    expect(r.exitCode).toBe(255);
    expect(r.stderr).toMatch(/cannot reach the agent/);
  });

  test("hybrid vsock: the CONNECT handshake, and a CONNECT nobody answers", async () => {
    // stands in for CH: "CONNECT 1024\n" → "OK 1\n", then the agent's socket
    const ch = join(dir, "ch.vsock");
    const server = net.createServer((c) => {
      c.once("data", (d) => {
        if (d.toString() !== "CONNECT 1024\n") { c.end("ERR\n"); return; }
        const up = net.connect(sock, () => { c.write("OK 1\n"); c.pipe(up).pipe(c); });
      });
    }).listen(ch);
    // CH before the guest listens: takes the CONNECT and never answers
    const mute = join(dir, "mute.vsock");
    const silent = net.createServer(() => {}).listen(mute);
    try {
      const vs = agentClient(hybridVsock(ch));
      expect((await vs.ping()).protocol).toBe(PROTOCOL);
      expect((await vs.exec(["echo", "via vsock"])).stdout).toBe("via vsock\n");
      const t = Date.now();
      await expect(waitForAgent(hybridVsock(mute, 1024, 200), { timeoutMs: 800, attemptMs: 300 })).rejects.toThrow(/did not answer/);
      expect(Date.now() - t).toBeLessThan(2000);
    } finally {
      server.close();
      silent.close();
    }
  });

  test("poweroff: the agent says yes, then goes", async () => {
    await client.poweroff();
    await agent!.exited; // outside PID 1 that is the agent exiting
    expect(existsSync(bin)).toBe(true);
  });
});
