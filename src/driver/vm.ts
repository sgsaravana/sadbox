// What the "a VM is a folder" drivers share: the spec file, the pid file, the
// disk clone, mount planning, and the host-dials-in socket bridges. Used by
// driver/kvm (Cloud Hypervisor on Linux) and driver/vz (Apple's
// Virtualization.framework through vfkit).
//
// Both run one VMM process per project, detached, and reach the guest only
// through sadbox-agent over vsock; neither gives a VM a network interface.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, constants as fsc } from "node:fs";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import type { AgentClient } from "./agent";

/** A unix socket path must fit in sun_path (104 bytes on macOS, 108 on Linux). */
export const MAX_SOCK_PATH = 100;

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

/** The VM's spec, or null if there is none (or it is unreadable). */
export function readSpec(file: string): VmSpec | null {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function writeSpec(file: string, spec: VmSpec) {
  writeFileSync(`${file}.tmp`, JSON.stringify(spec, null, 2));
  // rename, so a crash never leaves half a file
  renameSync(`${file}.tmp`, file);
}

/** The pid in a pid file, or null if there is none. */
export function pidOf(file: string): number | null {
  try { return Number(readFileSync(file, "utf8").trim()) || null; } catch { return null; }
}

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  // on Linux, a zombie or a recycled pid is not our VMM
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) [ZX]/.test(stat);
  } catch { return true; }
}

export async function exitedWithin(pid: number | null, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; pidAlive(pid) && Date.now() < until;) await Bun.sleep(50);
  return !pidAlive(pid);
}

/** Start a process that is not the supervisor's to wait for: it outlives a restart. */
export function detached(bin: string, args: string[], log: string): number {
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

export async function waitFor(path: string, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(20)) if (existsSync(path)) return true;
  return existsSync(path);
}

/** A project's disk: a copy-on-write clone of the image's where the filesystem
 *  can (btrfs, xfs, APFS), a sparse copy otherwise; then grown — sparsely — and
 *  the agent grows the filesystem to match at boot. */
export async function cloneDisk(src: string, dest: string, sizeBytes: number) {
  if (process.platform === "linux") {
    const cp = Bun.spawn(["cp", "--reflink=auto", "--sparse=always", src, dest], { stderr: "pipe" });
    if (await cp.exited !== 0) throw new Error(`could not copy the disk: ${(await new Response(cp.stderr).text()).trim()}`);
  } else {
    copyFileSync(src, dest, fsc.COPYFILE_FICLONE);
  }
  if (statSync(dest).size < sizeBytes) truncateSync(dest, sizeBytes);
}

// ---- shared folders ----
export interface Share { tag: string; dir: string }
export interface MountPlan { tag: string; sub: string; guest: string; file: boolean }

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

// ---- the host-dials-in socket (the proxy's carriers) ----
/** Serve each project's published host socket, a connection at a time, onto
 *  the agent's `connect` to a unix socket in the guest. */
export function socketBridges(clientFor: (ref: string) => AgentClient) {
  const bridges = new Map<string, net.Server>();

  function open(ref: string, socket: { host: string; guest: string }) {
    bridges.get(ref)?.close();
    rmSync(socket.host, { force: true });
    mkdirSync(dirname(socket.host), { recursive: true });
    const server = net.createServer((c) => {
      c.on("error", () => {});
      clientFor(ref).connect(socket.guest, 5_000).then((up) => {
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

  function close(ref: string, socket?: { host: string }) {
    bridges.get(ref)?.close();
    bridges.delete(ref);
    if (socket) rmSync(socket.host, { force: true });
  }

  /** After a supervisor restart: serve the sockets of the VMs already there. */
  function restore(specs: VmSpec[]) {
    for (const spec of specs) {
      if (spec.socket && !bridges.has(spec.ref)) open(spec.ref, spec.socket);
    }
  }

  return { open, close, restore, has: (ref: string) => bridges.has(ref) };
}

/** The last lines of a file, for an error message. */
export function tail(file: string, lines = 5): string {
  try { return readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n"); } catch { return ""; }
}
