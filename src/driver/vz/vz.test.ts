// The vz driver's lifecycle, with test/fake-vfkit.ts standing in for vfkit: it
// runs the real sadbox-agent (built with Go) on this machine instead of a VM,
// behind vfkit's vsock unix sockets and REST API. What only a real VM can show
// (booting a kernel, the disk, virtiofs) is left to vz.it.test.ts on a Mac.
// Skipped where Go is not installed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { config } from "../../config";
import { vzDriver as driver, parseClock, planMounts, vfkitArgs, type VmSpec } from "./index";
import { diskPath, imageDir } from "./images";
import { kernelImageFiles } from "../../assets";

const go = Bun.which("go");
const tmp = mkdtempSync("/tmp/sbv-"); // short: unix socket paths
const IMAGE = "sadbox-test:vz";
const ref = "sadbox-vztest";

beforeAll(async () => {
  if (!go) return;
  const agent = join(tmp, "sadbox-agent");
  const build = Bun.spawn([go, "build", "-o", agent, "."], { cwd: resolve(import.meta.dir, "../../../guest/agent"), stderr: "pipe" });
  if (await build.exited !== 0) throw new Error(`go build: ${await new Response(build.stderr).text()}`);
  const vfkit = join(tmp, "vfkit");
  writeFileSync(vfkit, `#!/bin/sh\nexec ${process.execPath} ${resolve(import.meta.dir, "../../../test/fake-vfkit.ts")} "$@"\n`);
  chmodSync(vfkit, 0o755);
  writeFileSync(join(tmp, "kernel"), "");
  writeFileSync(join(tmp, "initrd"), "");
  Object.assign(process.env, {
    SADBOX_TEST_FAKE_VMM: "1", SADBOX_TEST_AGENT_BIN: agent, SADBOX_VFKIT_BIN: vfkit,
    SADBOX_VZ_KERNEL: join(tmp, "kernel"), SADBOX_VZ_INITRD: join(tmp, "initrd"),
    SADBOX_VZ_RUN: join(tmp, "run"),
  });
  // an image's disk, as diskimages.ts leaves one
  mkdirSync(imageDir(IMAGE), { recursive: true });
  writeFileSync(diskPath(IMAGE), Buffer.alloc(1 << 20));
  writeFileSync(join(imageDir(IMAGE), "meta.json"), JSON.stringify({ image: IMAGE, recipe: "r1", builtAt: "", sizeBytes: 1 << 20, uid: 1000, gid: 1000 }));
}, 180_000);

afterAll(async () => {
  await driver.destroy(ref).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

describe("planning a VM", () => {
  test("vfkit's arguments: a raw disk, two vsock sockets, no network", () => {
    const spec: VmSpec = { ref: "r", image: IMAGE, cpus: 3, memoryMB: 1536, mounts: [], uid: 1000, gid: 1000, createdAt: "" };
    const plain = vfkitArgs("r", spec, []).join(" ");
    expect(plain).toContain("--cpus 3 --memory 1536");
    expect(plain).toMatch(/--bootloader linux,kernel=\S+,initrd=\S+,cmdline=.*init=\/sbin\/sadbox-agent/);
    expect(plain).toContain("sadbox.announce=1025");
    expect(plain).toMatch(/virtio-blk,path=\S+disk\.ext4/);
    expect(plain).toMatch(/virtio-vsock,port=1024,socketURL=\S+agent\.sock,connect/);
    expect(plain).toMatch(/virtio-vsock,port=1025,socketURL=\S+announce\.sock,listen/);
    expect(plain).toMatch(/virtio-serial,logFilePath=\S+console\.log/);
    expect(plain).toMatch(/--restful-uri unix:\/\/\S+api\.sock/);
    expect(plain).not.toContain("virtio-net");
    const shared = vfkitArgs("r", spec, [{ tag: "sbx0", dir: "/tmp/x" }]).join(" ");
    expect(shared).toContain("--device virtio-fs,sharedDir=/tmp/x,mountTag=sbx0");
  });

  test("mounts: one share per folder, a file shared through its folder", () => {
    const d = join(tmp, "hist");
    mkdirSync(join(d, "projects"), { recursive: true });
    writeFileSync(join(d, "history.jsonl"), "");
    const p = planMounts([
      { host: join(d, "projects"), guest: "/home/agent/.claude/projects" },
      { host: join(d, "history.jsonl"), guest: "/home/agent/.claude/history.jsonl" },
    ]);
    expect(p.shares).toEqual([{ tag: "sbx0", dir: join(d, "projects") }, { tag: "sbx1", dir: d }]);
    expect(p.mounts).toEqual([
      { tag: "sbx0", sub: "", guest: "/home/agent/.claude/projects", file: false },
      { tag: "sbx1", sub: "history.jsonl", guest: "/home/agent/.claude/history.jsonl", file: true },
    ]);
  });

  test("the kernel recipe builds a VZ-bootable kernel with virtio and vsock in the initramfs", () => {
    const recipe = readFileSync(kernelImageFiles.Dockerfile, "utf8");
    expect(recipe).toContain("linux-image-$arch");
    expect(recipe).toContain("vmw_vsock_virtio_transport");
    expect(recipe).toContain("virtio_fs");
    expect(recipe).toContain("initramfs-tools");
  });

  test("ps's cumulative CPU time is parsed", () => {
    expect(parseClock("0:03.45")).toBe(3_450_000);
    expect(parseClock("1:02:03")).toBe(3_723_000_000);
    expect(parseClock("1-00:00:01")).toBe(86_401_000_000);
    expect(parseClock("nonsense")).toBeNull();
  });
});

describe.skipIf(!go)("the vz driver, with a stand-in VMM", () => {
  const hostSock = () => join(tmp, "proxy.sock");
  const guestSock = () => join(tmp, "carrier.sock");

  test("an image without a disk, and a VM network, are refused", async () => {
    await expect(driver.create("sadbox-nodisk", "no-such:image")).rejects.toThrow(/no disk for no-such:image/);
    await expect(driver.create("sadbox-net", IMAGE, { network: "default" })).rejects.toThrow(/no VM networks/);
  });

  test("create boots it, and it reads as running and isolated", async () => {
    await driver.create(ref, IMAGE, { cpus: 2, memoryMB: 1024, diskGB: 4, network: "none", socket: { host: hostSock(), guest: guestSock() } });
    expect(await driver.inspect(ref)).toMatchObject({ ref, state: "running", isolated: true, network: "none", cpus: 2, memoryLimitBytes: 1024 * 1024 * 1024 });
    expect(statSync(join(config.dataDir, "vz", "vms", ref, "disk.ext4")).size).toBe((1 << 20) + 4 * 1024 ** 3);
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

  test("stats: the size and the VMM's CPU time", async () => {
    const s = await driver.stats(ref);
    expect(s).toMatchObject({ memoryLimitBytes: 1024 * 1024 * 1024 });
    expect(s?.cpuUsageUsec).toBeGreaterThanOrEqual(0);
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
    const args = readFileSync(join(config.dataDir, "vz", "vms", ref, "console.log"), "utf8");
    expect(args).toContain("--memory 3072");
    expect((await driver.exec(ref, ["echo", "back"])).stdout).toBe("back\n");
    await driver.start(ref); // already up: nothing to do
  }, 30_000);

  test("destroy removes it all", async () => {
    await driver.destroy(ref);
    expect((await driver.inspect(ref)).state).toBe("unknown");
    expect(existsSync(join(config.dataDir, "vz", "vms", ref))).toBe(false);
    expect(existsSync(hostSock())).toBe(false);
    await driver.destroy(ref); // gone already: fine
  }, 30_000);

  test("a VMM that fails to start: create says why and leaves nothing behind", async () => {
    process.env.SADBOX_TEST_FAKE_VFKIT_FAIL = "1";
    try {
      await expect(driver.create("sadbox-broken", IMAGE)).rejects.toThrow(/fake vfkit told to fail/);
      expect(existsSync(join(config.dataDir, "vz", "vms", "sadbox-broken"))).toBe(false);
    } finally {
      delete process.env.SADBOX_TEST_FAKE_VFKIT_FAIL;
    }
  }, 30_000);

  test("serviceStatus counts the VMs", async () => {
    expect(await driver.serviceStatus()).toMatchObject({ running: true, containersRunning: 0 });
  });
});
