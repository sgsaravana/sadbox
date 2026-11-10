// The Linux driver (ROADMAP L3): each project is a Cloud Hypervisor microVM on
// KVM, with no network interface, booted from its own clone of an image's disk
// (images.ts), and reached only through sadbox-agent over vsock (../agent.ts).
// Proven in spikes/e-cloud-hypervisor.
//
// A VM is a folder, so it outlives the supervisor:
//
//   ~/.sadbox/kvm/vms/<ref>/vm.json         what it is (image, size, socket, mounts)
//                         /disk.ext4        its disk
//                         /ch.pid, *.log, console.log
//   ~/.sadbox/run/kvm/<id>/api.sock         CH's REST API — answers while the VM is up
//                         /vsock.sock       the guest's vsock; _1025 gets the agent's "ready"
//
// (sockets apart, under a short name: a unix socket's path must fit in ~104 bytes)
//
// CH runs detached: a supervisor restart leaves VMs running, and finds them
// again by their API sockets. Each VM's host-dials-in socket (the proxy's
// carriers) is served here, a connection at a time, onto the agent's
// `connect` to the guest socket.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants as fsc, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "fs";
import net from "node:net";
import { basename, dirname, join } from "path";
import { createHash } from "crypto";
import { runDir } from "../../config";
import { agentClient, awaitAnnouncement, hybridVsock, waitForAgent, type AgentClient } from "../agent";
import type { ProjectDriver, ProjectInfo, ProjectStats, ServiceStatus } from "../types";
import { diskMeta, diskPath, kvmImages } from "./images";
import { CH_VERSION, chBin, kernelPath, kvmDir, virtiofsdBin, vmmProblems } from "./vmm";

const ANNOUNCE_PORT = 1025;
const BOOT_MS = 60_000;
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;
/** Room a project's disk gets beyond the image, when no size is asked for:
 *  sparse, so only what is written takes space. */
const DEFAULT_FREE_GB = 32;
const GiB = 1024 ** 3;

export interface VmSpec {
  ref: string;
  image: string;
  cpus: number;
  memoryMB: number;
  socket?: { host: string; guest: string };
  mounts: { host: string; guest: string }[];
  /** the image USER's uid/gid, which shared folders are mapped to */
  uid: number;
  gid: number;
  createdAt: string;
}

const vmsDir = () => join(kvmDir(), "vms");
const vmDir = (ref: string) => join(vmsDir(), ref);
const file = (ref: string, name: string) => join(vmDir(ref), name);
const sockRoot = () => process.env.SADBOX_KVM_RUN || join(runDir(), "kvm");
const sockDir = (ref: string) => join(sockRoot(), createHash("sha256").update(ref).digest("hex").slice(0, 12));
/** A VM's sockets: CH's API, its vsock (+ _PORT for the guest's dials), virtiofsd's. */
const sock = (ref: string, name: string) => join(sockDir(ref), name);
const MAX_SOCK_PATH = 100; // sun_path is 104 bytes on macOS, 108 on Linux

function readSpec(ref: string): VmSpec | null {
  try { return JSON.parse(readFileSync(file(ref, "vm.json"), "utf8")); } catch { return null; }
}
function writeSpec(spec: VmSpec) {
  writeFileSync(file(spec.ref, "vm.json.tmp"), JSON.stringify(spec, null, 2));
  // rename, so a crash never leaves half a file
  renameSync(file(spec.ref, "vm.json.tmp"), file(spec.ref, "vm.json"));
}

const clients = new Map<string, AgentClient>();
const client = (ref: string) => {
  let c = clients.get(ref);
  if (!c) clients.set(ref, (c = agentClient(hybridVsock(sock(ref, "vsock.sock")))));
  return c;
};

// ---- CH's REST API ----
async function api(ref: string, method: string, path: string, timeoutMs = 2000): Promise<any> {
  const res = await fetch(`http://localhost/api/v1/${path}`, {
    method, unix: sock(ref, "api.sock"), signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Up: its VMM answers, and says the VM is running. */
async function isRunning(ref: string): Promise<boolean> {
  if (!existsSync(sock(ref, "api.sock"))) return false;
  try { return (await api(ref, "GET", "vm.info", 1500))?.state === "Running"; } catch { return false; }
}

function pidOf(ref: string): number | null {
  try { return Number(readFileSync(file(ref, "ch.pid"), "utf8").trim()) || null; } catch { return null; }
}
function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  // on Linux, a zombie or a recycled pid is not our VMM
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) [ZX]/.test(stat);
  } catch { return true; }
}

async function settledOff(ref: string, withinMs: number): Promise<boolean> {
  for (const until = Date.now() + withinMs; ;) {
    if (!pidAlive(pidOf(ref)) && !(await isRunning(ref))) return true;
    if (Date.now() >= until) return false;
    await Bun.sleep(100);
  }
}

// ---- shared folders (virtiofs) ----
interface Share { tag: string; dir: string }
interface MountPlan { tag: string; sub: string; guest: string; file: boolean }

/** One share per host folder (a file is shared through its folder), and where
 *  each mount comes from in them. */
export function planMounts(mounts: VmSpec["mounts"]): { shares: Share[]; mounts: MountPlan[] } {
  const shares: Share[] = [];
  const plan: MountPlan[] = [];
  for (const m of mounts) {
    const isFile = statSync(m.host).isFile();
    const dir = isFile ? dirname(m.host) : m.host;
    let share = shares.find((s) => s.dir === dir);
    if (!share) shares.push((share = { tag: `sbx${shares.length}`, dir }));
    plan.push({ tag: share.tag, sub: isFile ? basename(m.host) : "", guest: m.guest, file: isFile });
  }
  return { shares, mounts: plan };
}

let translateIds: boolean | null = null;
/** virtiofsd ≥ 1.11 can map ids, so the guest user owns what the host user owns. */
function canTranslateIds(bin: string): boolean {
  if (translateIds == null) {
    const r = Bun.spawnSync([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    translateIds = `${r.stdout}${r.stderr}`.includes("translate-uid");
  }
  return translateIds;
}

function startVirtiofsd(ref: string, spec: VmSpec, s: Share): string {
  const bin = virtiofsdBin();
  if (!bin) throw new Error("this VM shares folders, but virtiofsd is not installed");
  const path = sock(ref, `${s.tag}.sock`);
  rmSync(path, { force: true });
  const args = [`--socket-path=${path}`, `--shared-dir=${s.dir}`, "--sandbox=none", "--cache=auto"];
  const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
  if (canTranslateIds(bin)) args.push(`--translate-uid=map:${spec.uid}:${uid}:1`, `--translate-gid=map:${spec.gid}:${gid}:1`);
  detached(bin, args, file(ref, `${s.tag}.log`));
  return path;
}

/** Start a process that is not the supervisor's to wait for: it outlives a restart. */
function detached(bin: string, args: string[], log: string): number {
  const fd = openSync(log, "a");
  try {
    const child = spawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    if (!child.pid) throw new Error(`could not start ${bin}`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

async function waitFor(path: string, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(20)) if (existsSync(path)) return true;
  return existsSync(path);
}

// ---- boot ----
export function chArgs(ref: string, spec: VmSpec, fsSockets: { tag: string; sock: string }[]): string[] {
  const args = [
    "--api-socket", `path=${sock(ref, "api.sock")}`,
    "--kernel", kernelPath(),
    "--cmdline", `console=hvc0 root=/dev/vda rw init=/sbin/sadbox-agent sadbox.hostname=${ref} sadbox.announce=${ANNOUNCE_PORT} quiet`,
    "--disk", `path=${file(ref, "disk.ext4")},image_type=raw`,
    "--cpus", `boot=${spec.cpus}`,
    // shared memory: virtiofsd reads the guest's buffers directly
    "--memory", `size=${spec.memoryMB}M${fsSockets.length ? ",shared=on" : ""}`,
    "--vsock", `cid=3,socket=${sock(ref, "vsock.sock")}`,
    "--console", `file=${file(ref, "console.log")}`,
    "--serial", "off",
  ];
  for (const f of fsSockets) args.push("--fs", `tag=${f.tag},socket=${f.sock}`);
  return args; // and no --net: the VM has no network interface at all
}

function consoleTail(ref: string, lines = 15): string {
  try { return readFileSync(file(ref, "console.log"), "utf8").trimEnd().split("\n").slice(-lines).join("\n"); } catch { return ""; }
}

async function boot(ref: string): Promise<void> {
  const spec = readSpec(ref);
  if (!spec) throw new Error(`no VM ${ref}`);
  const problems = vmmProblems();
  if (problems.length) throw new Error(problems.map((p) => p.fix ? `${p.error} — ${p.fix}` : p.error).join("; "));
  rmSync(sockDir(ref), { recursive: true, force: true });
  mkdirSync(sockDir(ref), { recursive: true, mode: 0o700 });

  const plan = planMounts(spec.mounts.filter((m) => existsSync(m.host)));
  const fsSockets = plan.shares.map((s) => ({ tag: s.tag, sock: startVirtiofsd(ref, spec, s) }));
  for (const f of fsSockets) {
    if (!(await waitFor(f.sock, 5_000))) throw new Error(`virtiofsd did not start for ${f.tag} (see ${file(ref, `${f.tag}.log`)})`);
  }

  const announced = awaitAnnouncement(sock(ref, `vsock.sock_${ANNOUNCE_PORT}`));
  rmSync(file(ref, "console.log"), { force: true });
  const pid = detached(chBin(), chArgs(ref, spec, fsSockets), file(ref, "ch.log"));
  writeFileSync(file(ref, "ch.pid"), `${pid}\n`);
  let done = false;
  let timer: Timer | undefined;
  try {
    // the agent says when it is up; polling is the fallback should it not
    const polled = waitForAgent(hybridVsock(sock(ref, "vsock.sock"), 1024, 1000), {
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
    const tail = consoleTail(ref);
    let ch = "";
    try { ch = readFileSync(file(ref, "ch.log"), "utf8").trim().split("\n").slice(-5).join("\n"); } catch {}
    throw new Error(`${(e as Error).message}${ch ? `\n${ch}` : ""}${tail ? `\n--- console\n${tail}` : ""}`);
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
const bridges = new Map<string, net.Server>();

function openBridge(ref: string, socket: { host: string; guest: string }) {
  bridges.get(ref)?.close();
  rmSync(socket.host, { force: true });
  mkdirSync(dirname(socket.host), { recursive: true });
  const server = net.createServer((c) => {
    c.on("error", () => {});
    client(ref).connect(socket.guest, 5_000).then((up) => {
      up.on("error", () => {});
      up.on("close", () => c.destroy());
      c.on("close", () => up.destroy());
      c.pipe(up);
      up.pipe(c);
    }, () => c.destroy()); // the VM is down, or nothing listens in it: the dialler retries
  });
  server.on("error", (e) => console.error(`⚠ ${ref}: socket ${socket.host}: ${e.message}`));
  server.listen(socket.host, () => { try { chmodSync(socket.host, 0o600); } catch {} });
  bridges.set(ref, server);
}

function closeBridge(ref: string) {
  const spec = readSpec(ref);
  bridges.get(ref)?.close();
  bridges.delete(ref);
  if (spec?.socket) rmSync(spec.socket.host, { force: true });
}

let restored = false;
/** After a supervisor restart: serve the sockets of the VMs already there. */
function restore() {
  if (restored) return;
  restored = true;
  let refs: string[] = [];
  try { refs = readdirSync(vmsDir()); } catch {}
  for (const ref of refs) {
    const spec = readSpec(ref);
    if (spec?.socket) openBridge(ref, spec.socket);
  }
}

/** A project's disk: a copy-on-write clone of the image's where the
 *  filesystem can (btrfs, xfs, APFS), a sparse copy otherwise; then grown —
 *  sparsely — and the agent grows the filesystem to match at boot. */
async function cloneDisk(src: string, dest: string, sizeBytes: number) {
  if (process.platform === "linux") {
    const cp = Bun.spawn(["cp", "--reflink=auto", "--sparse=always", src, dest], { stderr: "pipe" });
    if (await cp.exited !== 0) throw new Error(`could not copy the disk: ${(await new Response(cp.stderr).text()).trim()}`);
  } else {
    copyFileSync(src, dest, fsc.COPYFILE_FICLONE);
  }
  if (statSync(dest).size < sizeBytes) truncateSync(dest, sizeBytes);
}

async function exitedWithin(pid: number | null, ms: number) {
  for (const until = Date.now() + ms; pidAlive(pid) && Date.now() < until;) await Bun.sleep(50);
  return !pidAlive(pid);
}

/** Shared folders work when virtiofsd is there and the guest user can write
 *  what it shares: virtiofsd maps ids, or this user already has the image
 *  user's (1000 in sadbox's image). Unprivileged, it can create files only as
 *  this user. */
function canShare(): boolean {
  const bin = virtiofsdBin();
  return !!bin && (process.getuid?.() === 1000 || canTranslateIds(bin));
}

export const kvmDriver: ProjectDriver = {
  name: "kvm",
  capabilities: { snapshot: false, sharedMount: process.platform === "linux" && canShare(), routableIp: false },
  images: kvmImages,

  async serviceStatus(): Promise<ServiceStatus> {
    restore();
    const problems = vmmProblems();
    if (problems.length) return { running: false, error: problems[0].error, fix: problems[0].fix };
    const all = await this.list();
    return {
      running: true, version: `Cloud Hypervisor ${CH_VERSION}`,
      containersRunning: all.filter((v) => v.state === "running").length, containersTotal: all.length,
    };
  },

  async create(ref, image, opts) {
    restore();
    if (readSpec(ref)) throw new Error(`a VM named ${ref} already exists`);
    if (opts?.network && opts.network !== "none") throw new Error(`the KVM driver has no VM networks (asked for "${opts.network}"); VMs reach out only through the proxy`);
    const meta = diskMeta(image);
    if (!meta) throw new Error(`there is no disk for ${image} — run \`sadbox setup\` to build it`);
    const longest = sock(ref, `vsock.sock_${ANNOUNCE_PORT}`);
    if (longest.length > MAX_SOCK_PATH) throw new Error(`the VM's socket paths are too long for a unix socket (${longest}) — set SADBOX_KVM_RUN to a shorter folder`);
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
      writeSpec(spec);
      if (spec.socket) openBridge(ref, spec.socket);
      await boot(ref);
    } catch (e) {
      closeBridge(ref);
      try { process.kill(pidOf(ref) ?? 0, "SIGKILL"); } catch {}
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
    // the guest did not: ask CH, then make it
    await api(ref, "PUT", "vmm.shutdown").catch(() => {});
    if (await exitedWithin(pid, 5_000)) return;
    try { if (pid) process.kill(pid, "SIGKILL"); } catch {}
    if (await exitedWithin(pid, 3_000)) return;
    throw new Error("could not stop the VM (it is not responding)");
  },

  async setMemory(ref, memoryMB) {
    const spec = readSpec(ref);
    if (!spec) throw new Error(`no VM ${ref}`);
    if (await isRunning(ref)) throw new Error("the VM must be stopped to change its memory");
    writeSpec({ ...spec, memoryMB });
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
    const [counters, guest] = await Promise.all([
      api(ref, "GET", "vm.counters", timeoutMs).catch(() => null),
      client(ref).exec(["sh", "-c", "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; ls -d /proc/[0-9]* | wc -l"], { user: "root", timeoutMs }),
    ]);
    const s: ProjectStats = { memoryLimitBytes: spec.memoryMB * 1024 * 1024 };
    if (guest.exitCode === 0) {
      const kb = (k: string) => Number(guest.stdout.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? NaN) * 1024;
      const used = kb("MemTotal") - kb("MemAvailable");
      if (Number.isFinite(used)) s.memoryUsageBytes = used;
      const procs = Number(guest.stdout.trim().split("\n").pop());
      if (Number.isFinite(procs)) s.numProcesses = procs;
    }
    // block devices' counters, summed ({"_disk0": {"read_bytes": …}, …})
    if (counters) {
      let r = 0, w = 0;
      for (const [, c] of Object.entries<any>(counters)) { r += c?.read_bytes ?? 0; w += c?.write_bytes ?? 0; }
      s.blockReadBytes = r;
      s.blockWriteBytes = w;
    }
    // the VMM's CPU time is the guest's (its vCPU threads) plus a little of its own
    try {
      const f = readFileSync(`/proc/${pidOf(ref)}/stat`, "utf8").split(") ").pop()!.split(" ");
      s.cpuUsageUsec = (Number(f[11]) + Number(f[12])) * 10_000; // clock ticks at 100 Hz
    } catch {}
    return s;
  },

  exec(ref, cmd, opts) { return client(ref).exec(cmd, opts); },
  execWithStdin(ref, shellCmd, stdin, opts) { return client(ref).execWithStdin(shellCmd, stdin, opts); },
  stream(ref, shellCmd) { return client(ref).stream(shellCmd); },
  execCaptureBytes(ref, shellCmd, opts) { return client(ref).execCaptureBytes(shellCmd, opts); },
  terminal(ref, cmd, size) { return client(ref).terminal(cmd, size); },
};
