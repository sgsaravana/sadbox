// The vz driver: each project is a microVM on Apple's
// Virtualization.framework, run by vfkit, with no network interface, booted
// from its own clone of an image's disk (images.ts), and reached only through
// sadbox-agent over vsock (../agent.ts).
//
// This is the backend for Intel Macs: Apple's `container` CLI is Apple silicon
// only, but Virtualization.framework itself runs Linux x86_64 guests on an
// Intel host, and vfkit drives it. The same driver also works on Apple
// silicon (SADBOX_DRIVER=vz), where vfkit boots an arm64 guest.
//
// A VM is a folder, so it outlives the supervisor — exactly as in
// ../kvm/index.ts (which this driver is modelled on):
//
//   ~/.sadbox/vz/vms/<ref>/vm.json         what it is (image, size, socket, mounts)
//                        /disk.ext4        its disk
//                        /vfkit.pid, *.log, console.log
//   ~/.sadbox/run/vz/<id>/agent.sock       host → guest (vsock 1024, `connect`)
//                        /announce.sock    guest → host (vsock 1025, `listen`)
//                        /api.sock         vfkit's REST API — answers while the VM is up
//
// vfkit runs detached: a supervisor restart leaves VMs running, and finds them
// again by their API sockets. Each VM's host-dials-in socket (the proxy's
// carriers) is served here, a connection at a time, onto the agent's
// `connect` to the guest socket.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runDir } from "../../config";
import { AGENT_PORT, agentClient, awaitAnnouncement, unixSocket, waitForAgent, type AgentClient } from "../agent";
import type { ProjectDriver, ProjectInfo, ProjectStats, ServiceStatus } from "../types";
import {
  MAX_SOCK_PATH, cloneDisk, detached, exitedWithin, pidAlive, pidOf as pidOfAt, planMounts, readSpec as readSpecAt,
  socketBridges, tail, writeSpec as writeSpecAt, type Share, type VmSpec,
} from "../vm";
import { diskMeta, diskPath, vzImages } from "./images";
import { VFKIT_VERSION, initrdPath, kernelPath, vfkitBin, vmmProblems, vzDir } from "./vmm";

export { planMounts };
export type { VmSpec };

const ANNOUNCE_PORT = 1025;
const BOOT_MS = 60_000;
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;
/** Room a project's disk gets beyond the image, when no size is asked for:
 *  sparse, so only what is written takes space. */
const DEFAULT_FREE_GB = 32;
const GiB = 1024 ** 3;

const vmsDir = () => join(vzDir(), "vms");
const vmDir = (ref: string) => join(vmsDir(), ref);
const file = (ref: string, name: string) => join(vmDir(ref), name);
const sockRoot = () => process.env.SADBOX_VZ_RUN || join(runDir(), "vz");
const sockDir = (ref: string) => join(sockRoot(), createHash("sha256").update(ref).digest("hex").slice(0, 12));
const sock = (ref: string, name: string) => join(sockDir(ref), name);

const readSpec = (ref: string) => readSpecAt(file(ref, "vm.json"));
const writeSpec = (ref: string, spec: VmSpec) => writeSpecAt(file(ref, "vm.json"), spec);
const pidOf = (ref: string) => pidOfAt(file(ref, "vfkit.pid"));

const clients = new Map<string, AgentClient>();
const client = (ref: string) => {
  let c = clients.get(ref);
  if (!c) clients.set(ref, (c = agentClient(unixSocket(sock(ref, "agent.sock")))));
  return c;
};

// ---- vfkit's REST API ----
async function api(ref: string, method: string, path: string, timeoutMs = 2000, body?: unknown): Promise<any> {
  const res = await fetch(`http://localhost/${path}`, {
    method, unix: sock(ref, "api.sock"), signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  } as RequestInit);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Up: vfkit answers, and says the VM is running. */
async function isRunning(ref: string): Promise<boolean> {
  if (!existsSync(sock(ref, "api.sock"))) return false;
  try { return (await api(ref, "GET", "vm/state", 1500))?.state === "VirtualMachineStateRunning"; } catch { return false; }
}

// ---- boot ----
/** vfkit's arguments. Exported for tests: the shape is the whole contract with
 *  the VMM. No virtio-net: a project VM has no network interface. */
export function vfkitArgs(ref: string, spec: VmSpec, shares: Share[]): string[] {
  const cmdline = `console=hvc0 root=/dev/vda rw init=/sbin/sadbox-agent sadbox.hostname=${ref} sadbox.announce=${ANNOUNCE_PORT} quiet`;
  const args = [
    "--cpus", String(spec.cpus),
    "--memory", String(spec.memoryMB),
    "--bootloader", `linux,kernel=${kernelPath()},initrd=${initrdPath()},cmdline=${cmdline}`,
    "--device", `virtio-blk,path=${file(ref, "disk.ext4")}`,
    // host → guest: the host dials the unix socket, vfkit opens a fresh guest
    // vsock connection for each one (the agent's one-connection-per-op model)
    "--device", `virtio-vsock,port=${AGENT_PORT},socketURL=${sock(ref, "agent.sock")},connect`,
    // guest → host: the agent dials CID 2:1025, vfkit hands it to the listener
    // the supervisor already has on this unix socket (the ready announcement)
    "--device", `virtio-vsock,port=${ANNOUNCE_PORT},socketURL=${sock(ref, "announce.sock")},listen`,
    "--device", `virtio-serial,logFilePath=${file(ref, "console.log")}`,
    "--device", "virtio-rng",
    "--restful-uri", `unix://${sock(ref, "api.sock")}`,
    "--log-level", "info",
  ];
  for (const s of shares) args.push("--device", `virtio-fs,sharedDir=${s.dir},mountTag=${s.tag}`);
  return args;
}

async function boot(ref: string): Promise<void> {
  const spec = readSpec(ref);
  if (!spec) throw new Error(`no VM ${ref}`);
  const problems = vmmProblems();
  if (problems.length) throw new Error(problems.map((p) => p.fix ? `${p.error} — ${p.fix}` : p.error).join("; "));
  rmSync(sockDir(ref), { recursive: true, force: true });
  mkdirSync(sockDir(ref), { recursive: true, mode: 0o700 });

  const plan = planMounts(spec.mounts.filter((m) => existsSync(m.host)));

  const announced = awaitAnnouncement(sock(ref, "announce.sock"));
  rmSync(file(ref, "console.log"), { force: true });
  const pid = detached(vfkitBin(), vfkitArgs(ref, spec, plan.shares), file(ref, "vfkit.log"));
  writeFileSync(file(ref, "vfkit.pid"), `${pid}\n`);
  let done = false;
  let timer: Timer | undefined;
  try {
    // the agent says when it is up; polling is the fallback should it not
    const polled = waitForAgent(unixSocket(sock(ref, "agent.sock")), {
      timeoutMs: BOOT_MS, attemptMs: 1000, gone: () => done || !pidAlive(pid),
    });
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the VM did not come up within ${BOOT_MS / 1000} s`)), BOOT_MS);
    });
    await Promise.race([announced.ready, polled, limit]);
    polled.catch(() => {}); // it gives up once `done` is set
  } catch (e) {
    done = true;
    try { process.kill(pid, "SIGKILL"); } catch {}
    const console = tail(file(ref, "console.log"), 15);
    const log = tail(file(ref, "vfkit.log"));
    throw new Error(`${(e as Error).message}${log ? `\n${log}` : ""}${console ? `\n--- console\n${console}` : ""}`);
  } finally {
    done = true;
    clearTimeout(timer);
    announced.close();
  }
  for (const m of plan.mounts) {
    await client(ref).mount({ tag: m.tag, sub: m.sub, guestPath: m.guest, file: m.file });
  }
}

// ---- the host-dials-in socket ----
const bridges = socketBridges((ref) => client(ref));

function openBridge(ref: string, socket: { host: string; guest: string }) {
  bridges.open(ref, socket);
}

function closeBridge(ref: string) {
  const spec = readSpec(ref);
  bridges.close(ref, spec?.socket);
}

let restored = false;
/** After a supervisor restart: serve the sockets of the VMs already there. */
function restore() {
  if (restored) return;
  restored = true;
  let refs: string[] = [];
  try { refs = readdirSync(vmsDir()); } catch {}
  bridges.restore(refs.map(readSpec).filter((s): s is VmSpec => !!s));
}

/** `ps`'s cumulative CPU time for a pid: [dd-]hh:mm:ss[.cc] → microseconds. */
export function parseClock(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const [, d = "0", h = "0", mi = "0", sec = "0", frac = "0"] = m;
  const whole = Number(d) * 86_400 + Number(h) * 3_600 + Number(mi) * 60 + Number(sec);
  return whole * 1_000_000 + Number((frac + "000000").slice(0, 6));
}

function cpuUsec(pid: number | null): number | undefined {
  if (!pid) return undefined;
  const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "time="], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return undefined;
  return parseClock(new TextDecoder().decode(r.stdout)) ?? undefined;
}

export const vzDriver: ProjectDriver = {
  name: "vz",
  capabilities: { snapshot: false, sharedMount: true, routableIp: false },
  images: vzImages,

  async serviceStatus(): Promise<ServiceStatus> {
    restore();
    const problems = vmmProblems();
    if (problems.length) return { running: false, error: problems[0].error, fix: problems[0].fix };
    const all = await this.list();
    return {
      running: true, version: `vfkit ${VFKIT_VERSION}`,
      containersRunning: all.filter((v) => v.state === "running").length, containersTotal: all.length,
    };
  },

  async create(ref, image, opts) {
    restore();
    if (readSpec(ref)) throw new Error(`a VM named ${ref} already exists`);
    if (opts?.network && opts.network !== "none") throw new Error(`the vz driver has no VM networks (asked for "${opts.network}"); VMs reach out only through the proxy`);
    const meta = diskMeta(image);
    if (!meta) throw new Error(`there is no disk for ${image} — run \`sadbox setup\` to build it`);
    const longest = sock(ref, "announce.sock");
    if (longest.length > MAX_SOCK_PATH) throw new Error(`the VM's socket paths are too long for a unix socket (${longest}) — set SADBOX_VZ_RUN to a shorter folder`);
    rmSync(vmDir(ref), { recursive: true, force: true });
    mkdirSync(vmDir(ref), { recursive: true, mode: 0o700 });
    const spec: VmSpec = {
      ref, image,
      cpus: opts?.cpus ?? DEFAULT_CPUS,
      memoryMB: opts?.memoryMB ?? DEFAULT_MEMORY_MB,
      socket: opts?.socket,
      mounts: opts?.mounts ?? [],
      uid: meta.uid, gid: meta.gid,
      createdAt: new Date().toISOString(),
    };
    try {
      await cloneDisk(diskPath(image), file(ref, "disk.ext4"), meta.sizeBytes + (opts?.diskGB ?? DEFAULT_FREE_GB) * GiB);
      writeSpec(ref, spec);
      if (spec.socket) openBridge(ref, spec.socket);
      await boot(ref);
    } catch (e) {
      closeBridge(ref);
      const pid = pidOf(ref);
      if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
      rmSync(vmDir(ref), { recursive: true, force: true });
      throw e;
    }
  },

  async destroy(ref) {
    restore();
    if (!existsSync(vmDir(ref))) return;
    await this.stop(ref).catch(() => {});
    closeBridge(ref);
    clients.delete(ref);
    rmSync(vmDir(ref), { recursive: true, force: true });
    rmSync(sockDir(ref), { recursive: true, force: true });
  },

  async start(ref) {
    restore();
    if (!readSpec(ref)) throw new Error(`no VM ${ref}`);
    if (await isRunning(ref)) return;
    const spec = readSpec(ref)!;
    if (spec.socket && !bridges.has(ref)) openBridge(ref, spec.socket);
    await boot(ref);
  },

  async stop(ref) {
    restore();
    const pid = pidOf(ref);
    if (!(await isRunning(ref)) && !pidAlive(pid)) return;
    // politely: the agent shuts everything down and syncs the disk
    await client(ref).poweroff(5_000).catch(() => {});
    if (await exitedWithin(pid, 15_000)) return;
    // the guest did not: ask the VMM, then make it
    await api(ref, "POST", "vm/state", 5_000, { state: "HardStop" }).catch(() => {});
    if (await exitedWithin(pid, 5_000)) return;
    try { if (pid) process.kill(pid, "SIGKILL"); } catch {}
    if (await exitedWithin(pid, 3_000)) return;
    throw new Error("could not stop the VM (it is not responding)");
  },

  async setMemory(ref, memoryMB) {
    const spec = readSpec(ref);
    if (!spec) throw new Error(`no VM ${ref}`);
    if (await isRunning(ref)) throw new Error("the VM must be stopped to change its memory");
    writeSpec(ref, { ...spec, memoryMB });
  },

  async inspect(ref): Promise<ProjectInfo> {
    restore();
    const spec = readSpec(ref);
    if (!spec) return { ref, state: "unknown" };
    return {
      ref, state: (await isRunning(ref)) ? "running" : "stopped",
      network: "none", isolated: true,
      cpus: spec.cpus, memoryLimitBytes: spec.memoryMB * 1024 * 1024,
    };
  },

  async list() {
    let refs: string[] = [];
    try { refs = readdirSync(vmsDir()).filter((r) => !r.startsWith(".")); } catch {}
    const out = await Promise.all(refs.map((r) => this.inspect(r)));
    return out.filter((i) => i.state !== "unknown");
  },

  async stats(ref, timeoutMs = 5_000): Promise<ProjectStats | null> {
    if (!(await isRunning(ref))) return null;
    const spec = readSpec(ref)!;
    const guest = await client(ref).exec(["sh", "-c",
      "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; " +
      "awk '$3==\"vda\"{print \"disk\", $6, $10}' /proc/diskstats 2>/dev/null; " +
      "echo procs $(ls -d /proc/[0-9]* | wc -l)",
    ], { user: "root", timeoutMs });
    const s: ProjectStats = { memoryLimitBytes: spec.memoryMB * 1024 * 1024 };
    if (guest.exitCode === 0) {
      let total = 0, available = 0;
      for (const line of guest.stdout.split("\n")) {
        const mem = line.match(/^(MemTotal|MemAvailable):\s+(\d+)/);
        if (mem) {
          if (mem[1] === "MemTotal") total = Number(mem[2]) * 1024;
          else available = Number(mem[2]) * 1024;
          continue;
        }
        const disk = line.match(/^disk\s+(\d+)\s+(\d+)/);
        if (disk) { s.blockReadBytes = Number(disk[1]) * 512; s.blockWriteBytes = Number(disk[2]) * 512; }
        const procs = line.match(/^procs\s+(\d+)/);
        if (procs) s.numProcesses = Number(procs[1]);
      }
      if (total && available) s.memoryUsageBytes = total - available;
    }
    s.cpuUsageUsec = cpuUsec(pidOf(ref));
    if (!Number.isFinite(s.cpuUsageUsec)) delete s.cpuUsageUsec;
    return s;
  },

  exec(ref, cmd, opts) { return client(ref).exec(cmd, opts); },
  execWithStdin(ref, shellCmd, stdin, opts) { return client(ref).execWithStdin(shellCmd, stdin, opts); },
  stream(ref, shellCmd) { return client(ref).stream(shellCmd); },
  execCaptureBytes(ref, shellCmd, opts) { return client(ref).execCaptureBytes(shellCmd, opts); },
  terminal(ref, cmd, size) { return client(ref).terminal(cmd, size); },
};
