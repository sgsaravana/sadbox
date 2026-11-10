// The KVM driver's lifecycle, with test/fake-ch.ts standing in for Cloud
// Hypervisor: it runs the real sadbox-agent (built with Go) on this machine
// instead of a VM, behind CH's API and hybrid vsock. What only a real VM can
// show (booting, the disk, virtiofs) is left to kvm.yml on a KVM runner.
// Skipped where Go is not installed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { config } from "../../config";
import { kvmDriver as driver, chArgs, planMounts, type VmSpec } from "./index";
import { diskPath, imageDir } from "./images";
import { CH_VERSION, KERNEL_TAG } from "./vmm";
import { diskImageFiles } from "../../assets";

const go = Bun.which("go");
const tmp = mkdtempSync("/tmp/sbk-"); // short: unix socket paths
const IMAGE = "sadbox-test:kvm";
const ref = "sadbox-kvmtest";

beforeAll(async () => {
  if (!go) return;
  const agent = join(tmp, "sadbox-agent");
  const build = Bun.spawn([go, "build", "-o", agent, "."], { cwd: resolve(import.meta.dir, "../../../guest/agent"), stderr: "pipe" });
  if (await build.exited !== 0) throw new Error(`go build: ${await new Response(build.stderr).text()}`);
  const ch = join(tmp, "cloud-hypervisor");
  writeFileSync(ch, `#!/bin/sh\nexec ${process.execPath} ${resolve(import.meta.dir, "../../../test/fake-ch.ts")} "$@"\n`);
  chmodSync(ch, 0o755);
  writeFileSync(join(tmp, "kernel"), "");
  Object.assign(process.env, {
    SADBOX_TEST_FAKE_VMM: "1", SADBOX_TEST_AGENT_BIN: agent, SADBOX_CH_BIN: ch,
    SADBOX_KVM_KERNEL: join(tmp, "kernel"), SADBOX_KVM_RUN: join(tmp, "run"),
  });
  // an image's disk, as images.ts leaves one
  mkdirSync(imageDir(IMAGE), { recursive: true });
  writeFileSync(diskPath(IMAGE), Buffer.alloc(1 << 20));
  writeFileSync(join(imageDir(IMAGE), "meta.json"), JSON.stringify({ image: IMAGE, recipe: "r1", builtAt: "", sizeBytes: 1 << 20, uid: 1000, gid: 1000 }));
}, 180_000);

afterAll(async () => {
  await driver.destroy(ref).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

test("the binary carries all of the agent's source, for the disk build", () => {
  const src = readdirSync(resolve(import.meta.dir, "../../../guest/agent"))
    .filter((f) => f === "go.mod" || f === "go.sum" || (f.endsWith(".go") && !f.endsWith("_test.go")));
  expect(Object.keys(diskImageFiles).filter((k) => k.startsWith("agent/")).map((k) => k.slice(6)).sort()).toEqual(src.sort());
  expect(diskImageFiles.Dockerfile).toBeTruthy();
});

test("the container image pins the same Cloud Hypervisor and kernel", () => {
  const dockerfile = readFileSync(resolve(import.meta.dir, "../../../Dockerfile"), "utf8");
  expect(dockerfile).toContain(`ARG CH_VERSION=${CH_VERSION}\n`);
  expect(dockerfile).toContain(`ARG KERNEL_TAG=${KERNEL_TAG}\n`);
});

describe("planning a VM", () => {
  test("CH's arguments: a raw disk, vsock, no network; shared memory only with shares", () => {
    const spec: VmSpec = { ref: "r", image: IMAGE, cpus: 3, memoryMB: 1536, mounts: [], uid: 1000, gid: 1000, createdAt: "" };
    const plain = chArgs("r", spec, []).join(" ");
    expect(plain).toMatch(/--disk path=\S+disk\.ext4,image_type=raw/);
    expect(plain).toMatch(/--cpus boot=3 --memory size=1536M --vsock cid=3,socket=\S+vsock\.sock/);
    expect(plain).toContain("init=/sbin/sadbox-agent");
    expect(plain).toContain("sadbox.announce=1025");
    expect(plain).not.toContain("--net");
    expect(plain).not.toContain("shared=on");
    const shared = chArgs("r", spec, [{ tag: "sbx0", sock: "/x/sbx0.sock" }]).join(" ");
    expect(shared).toContain("size=1536M,shared=on");
    expect(shared).toContain("--fs tag=sbx0,socket=/x/sbx0.sock");
  });

  test("mounts: one share per folder, a file shared through its folder", () => {
    const d = join(tmp, "hist");
    mkdirSync(join(d, "projects"), { recursive: true });
    writeFileSync(join(d, "history.jsonl"), "");
    writeFileSync(join(d, "settings.json"), "");
    const p = planMounts([
      { host: join(d, "projects"), guest: "/home/agent/.claude/projects" },
      { host: join(d, "history.jsonl"), guest: "/home/agent/.claude/history.jsonl" },
      { host: join(d, "settings.json"), guest: "/home/agent/.claude/settings.json" },
    ]);
    expect(p.shares).toEqual([{ tag: "sbx0", dir: join(d, "projects") }, { tag: "sbx1", dir: d }]);
    expect(p.mounts).toEqual([
      { tag: "sbx0", sub: "", guest: "/home/agent/.claude/projects", file: false },
      { tag: "sbx1", sub: "history.jsonl", guest: "/home/agent/.claude/history.jsonl", file: true },
      { tag: "sbx1", sub: "settings.json", guest: "/home/agent/.claude/settings.json", file: true },
    ]);
  });
});

describe.skipIf(!go)("the KVM driver, with a stand-in VMM", () => {
  const hostSock = () => join(tmp, "proxy.sock");
  const guestSock = () => join(tmp, "carrier.sock");

  test("an image without a disk, and a VM network, are refused", async () => {
    await expect(driver.create("sadbox-nodisk", "no-such:image")).rejects.toThrow(/no disk for no-such:image/);
    await expect(driver.create("sadbox-net", IMAGE, { network: "default" })).rejects.toThrow(/no VM networks/);
  });

  test("create boots it, and it reads as running and isolated", async () => {
    await driver.create(ref, IMAGE, { cpus: 2, memoryMB: 1024, diskGB: 4, network: "none", socket: { host: hostSock(), guest: guestSock() } });
    expect(await driver.inspect(ref)).toMatchObject({ ref, state: "running", isolated: true, network: "none", cpus: 2, memoryLimitBytes: 1024 * 1024 * 1024 });
    // its own disk, grown sparsely by the size asked for
    expect(statSync(join(config.dataDir, "kvm", "vms", ref, "disk.ext4")).size).toBe((1 << 20) + 4 * 1024 ** 3);
    expect((await driver.list()).map((v) => v.ref)).toContain(ref);
    await expect(driver.create(ref, IMAGE)).rejects.toThrow(/already exists/);
  }, 30_000);

  test("guest commands go through the agent", async () => {
    expect(await driver.exec(ref, ["sh", "-c", "echo hi; exit 3"])).toMatchObject({ exitCode: 3, stdout: "hi\n" });
    expect((await driver.execWithStdin(ref, "wc -c", new TextEncoder().encode("12345"))).stdout.trim()).toBe("5");
    const b = await driver.execCaptureBytes(ref, "printf ab");
    expect(Buffer.from(b.stdout).toString()).toBe("ab");
  });

  test("the host-dials-in socket reaches a socket in the guest", async () => {
    const echo = net.createServer((c) => c.pipe(c)).listen(guestSock());
    try {
      const got = await new Promise<string>((res, rej) => {
        const c = net.connect(hostSock(), () => c.write("ping"));
        c.on("data", (d) => { res(d.toString()); c.destroy(); });
        c.on("error", rej);
      });
      expect(got).toBe("ping");
    } finally {
      echo.close();
    }
  });

  test("stats: the VMM's disk counters and the size", async () => {
    const s = await driver.stats(ref);
    expect(s).toMatchObject({ blockReadBytes: 10, blockWriteBytes: 20, memoryLimitBytes: 1024 * 1024 * 1024 });
  });

  test("memory can change only while stopped", async () => {
    await expect(driver.setMemory(ref, 3072)).rejects.toThrow(/must be stopped/);
  });

  test("stop powers it off through the agent; commands then say it cannot be reached", async () => {
    const t = Date.now();
    await driver.stop(ref);
    expect(Date.now() - t).toBeLessThan(10_000);
    expect((await driver.inspect(ref)).state).toBe("stopped");
    expect((await driver.exec(ref, ["true"])).exitCode).toBe(255);
    expect(await driver.stats(ref)).toBeNull();
    // the socket still answers, and hangs up: the proxy redials until the VM is back
    const closed = await new Promise<boolean>((res) => {
      const c = net.connect(hostSock());
      c.on("close", () => res(true));
      c.on("error", () => {});
    });
    expect(closed).toBe(true);
    await driver.stop(ref); // already off: nothing to do
  }, 30_000);

  test("setMemory while stopped; start boots it again with it", async () => {
    await driver.setMemory(ref, 3072);
    await driver.start(ref);
    expect(await driver.inspect(ref)).toMatchObject({ state: "running", memoryLimitBytes: 3072 * 1024 * 1024 });
    const args = readFileSync(join(config.dataDir, "kvm", "vms", ref, "console.log"), "utf8");
    expect(args).toContain("size=3072M");
    expect((await driver.exec(ref, ["echo", "back"])).stdout).toBe("back\n");
    await driver.start(ref); // already up: nothing to do
  }, 30_000);

  test("destroy removes it all", async () => {
    await driver.destroy(ref);
    expect((await driver.inspect(ref)).state).toBe("unknown");
    expect(existsSync(join(config.dataDir, "kvm", "vms", ref))).toBe(false);
    expect(existsSync(hostSock())).toBe(false);
    await driver.destroy(ref); // gone already: fine
  }, 30_000);

  test("a VMM that fails to start: create says why and leaves nothing behind", async () => {
    process.env.SADBOX_TEST_FAKE_CH_FAIL = "1";
    try {
      await expect(driver.create("sadbox-broken", IMAGE)).rejects.toThrow(/fake CH told to fail/);
      expect(existsSync(join(config.dataDir, "kvm", "vms", "sadbox-broken"))).toBe(false);
    } finally {
      delete process.env.SADBOX_TEST_FAKE_CH_FAIL;
    }
  }, 30_000);

  test("serviceStatus counts the VMs", async () => {
    expect(await driver.serviceStatus()).toMatchObject({ running: true, containersRunning: 0 });
  });
});
