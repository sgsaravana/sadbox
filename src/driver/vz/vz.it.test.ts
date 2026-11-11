// The vz driver against real Virtualization.framework VMs: boot, the agent, the
// grown disk, shared folders, the proxy's socket, stats, stop / start with the
// disk kept, memory changes, destroy. Needs a Mac and a `sadbox setup` done with
// SADBOX_DRIVER=vz (on an Intel Mac that setup built the amd64 disk and
// downloaded bzImage-x86_64; on Apple silicon, the arm64 pair). Runs only with
// SADBOX_VZ_IT=<that setup's data dir>; skipped otherwise.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { config } from "../../config";
import { vzDriver as driver } from "./index";
import { diskMeta } from "./images";

const it = process.env.SADBOX_VZ_IT;
const IMAGE = config.baseImage;
const ref = "sadbox-vz-it";
const tmp = mkdtempSync("/tmp/sbit-");
const hostSock = join(tmp, "proxy.sock");
const guestSock = "/tmp/sadbox-it.sock";
const hist = join(tmp, "hist");
const timings: Record<string, number> = {};
const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
  const t = performance.now();
  try { return await f(); } finally { timings[name] = Math.round(performance.now() - t); }
};

beforeAll(() => {
  if (!it) return;
  // the setup's vfkit, kernel and disk, in this test's data dir
  mkdirSync(join(config.dataDir, "vz"), { recursive: true });
  for (const d of ["bin", "images"]) {
    if (!existsSync(join(config.dataDir, "vz", d))) symlinkSync(join(it, "vz", d), join(config.dataDir, "vz", d));
  }
  process.env.SADBOX_VZ_RUN = join(tmp, "run");
  mkdirSync(join(hist, "projects"), { recursive: true });
  writeFileSync(join(hist, "projects", "from-host.txt"), "hello from the host\n");
  writeFileSync(join(hist, "history.jsonl"), "{\"line\":1}\n");
});

afterAll(async () => {
  if (it) {
    await driver.destroy(ref).catch(() => {});
    console.log(`vz timings: ${JSON.stringify(timings)}`);
    if (process.env.SADBOX_VZ_IT_TIMINGS) writeFileSync(process.env.SADBOX_VZ_IT_TIMINGS, JSON.stringify(timings, null, 2));
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!it)("the vz driver on real VMs", () => {
  test("the host is ready", async () => {
    expect(await driver.serviceStatus()).toMatchObject({ running: true });
    expect(diskMeta(IMAGE)).toBeTruthy();
  });

  test("create: boots its own disk, isolated, with its socket and mounts", async () => {
    const mounts = driver.capabilities.sharedMount
      ? [{ host: join(hist, "projects"), guest: "/home/agent/.claude/projects" }, { host: join(hist, "history.jsonl"), guest: "/home/agent/.claude/history.jsonl" }]
      : [];
    await timed("createMs", () => driver.create(ref, IMAGE, { cpus: 2, memoryMB: 2048, diskGB: 8, network: "none", socket: { host: hostSock, guest: guestSock }, mounts }));
    expect(await driver.inspect(ref)).toMatchObject({ state: "running", isolated: true });
  }, 120_000);

  test("commands run as the image's user, in its workdir, with its PATH", async () => {
    const r = await driver.exec(ref, ["sh", "-c", "id -un; pwd; for b in bun node claude tmux; do command -v $b; done"]);
    expect(r.exitCode).toBe(0);
    const [user, cwd, ...bins] = r.stdout.trim().split("\n");
    expect(user).toBe("agent");
    expect(cwd).toBe("/home/agent");
    expect(bins.length).toBe(4);
    expect((await driver.exec(ref, ["id", "-u"], { user: "root" })).stdout.trim()).toBe("0");
    expect((await driver.exec(ref, ["hostname"])).stdout.trim()).toBe(ref);
  });

  test("no network interface but loopback", async () => {
    const r = await driver.exec(ref, ["sh", "-c", "ls /sys/class/net"]);
    expect(r.stdout.trim()).toBe("lo");
  });

  test("the disk was grown to its size, and the filesystem with it", async () => {
    const r = await driver.exec(ref, ["sh", "-c", "df -k / | tail -1"]);
    const sizeKB = Number(r.stdout.trim().split(/\s+/)[1]);
    expect(sizeKB * 1024).toBeGreaterThan(diskMeta(IMAGE)!.sizeBytes + 6 * 1024 ** 3);
  });

  test("sudo works, and the agent's user can use it", async () => {
    expect((await driver.exec(ref, ["sudo", "-n", "id", "-u"])).stdout.trim()).toBe("0");
  });

  test.skipIf(!driver.capabilities.sharedMount)("shared folders: both ways, owned by the guest user", async () => {
    const r = await driver.exec(ref, ["sh", "-c",
      "cat ~/.claude/projects/from-host.txt ~/.claude/history.jsonl && echo from-guest > ~/.claude/projects/from-guest.txt && " +
      "echo '{\"line\":2}' >> ~/.claude/history.jsonl && stat -c %U ~/.claude/projects/from-guest.txt"]);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("hello from the host\n{\"line\":1}\nagent\n");
    expect(readFileSync(join(hist, "projects", "from-guest.txt"), "utf8")).toBe("from-guest\n");
    expect(readFileSync(join(hist, "history.jsonl"), "utf8")).toBe("{\"line\":1}\n{\"line\":2}\n");
  });

  test("the host-dials-in socket reaches a listener in the guest", async () => {
    const server = driver.stream(ref, `exec bun -e 'require("net").createServer(c=>c.pipe(c)).listen("${guestSock}")'`);
    try {
      let got = "";
      for (let i = 0; i < 50 && got !== "ping"; i++) {
        got = await new Promise<string>((res) => {
          const c = net.connect(hostSock, () => c.write("ping"));
          c.on("data", (d) => { res(d.toString()); c.destroy(); });
          c.on("close", () => res(""));
          c.on("error", () => res(""));
        });
        if (got !== "ping") await Bun.sleep(200);
      }
      expect(got).toBe("ping");
    } finally {
      server.kill();
    }
  }, 30_000);

  test("a terminal: a tty with its size", async () => {
    const t = driver.terminal(ref, ["sh", "-c", "tty; stty size"], { cols: 120, rows: 40 });
    let out = "";
    t.onData((c) => { out += Buffer.from(c).toString(); });
    await new Promise<void>((r) => t.onExit(r));
    expect(out).toMatch(/\/dev\/pts\/\d+/);
    expect(out).toContain("40 120");
  });

  test("stats: memory, processes, disk, CPU", async () => {
    const s = await driver.stats(ref);
    expect(s?.memoryUsageBytes).toBeGreaterThan(0);
    expect(s?.numProcesses).toBeGreaterThan(0);
    expect(s?.blockReadBytes).toBeGreaterThan(0);
    expect(s?.cpuUsageUsec).toBeGreaterThan(0);
  });

  test("stop / start keeps the disk; memory changes while stopped", async () => {
    expect((await driver.exec(ref, ["sh", "-c", "echo kept > ~/marker && sync"])).exitCode).toBe(0);
    await timed("stopMs", () => driver.stop(ref));
    expect((await driver.inspect(ref)).state).toBe("stopped");
    await driver.setMemory(ref, 3072);
    await timed("startMs", () => driver.start(ref));
    expect((await driver.exec(ref, ["cat", "/home/agent/marker"])).stdout).toBe("kept\n");
    const mem = await driver.exec(ref, ["sh", "-c", "grep MemTotal /proc/meminfo"]);
    const kb = Number(mem.stdout.match(/\d+/)?.[0]);
    expect(kb).toBeGreaterThan(2.8 * 1024 * 1024);
  }, 120_000);

  test("destroy", async () => {
    await timed("destroyMs", () => driver.destroy(ref));
    expect((await driver.inspect(ref)).state).toBe("unknown");
  }, 60_000);
});
