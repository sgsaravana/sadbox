// vfkit and the guest kernel the vz driver boots: vfkit is a pinned download
// (or brew's), and the kernel + initramfs are built locally with Docker from
// images/kernel for the host's architecture. Both are fetched/built on first
// use (`sadbox setup`), or named by the environment.
//
// vfkit is a small CLI over Apple's Virtualization.framework (Apache-2.0,
// crc-org): one process per VM, virtio-blk/vsock/virtio-fs, no daemon. It
// supports both Intel and Apple silicon hosts; the guest architecture must
// match the host's. That is what lets sadbox run its own microVMs on an Intel
// Mac, where Apple's `container` CLI does not exist.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config";
import { kernelImageFiles } from "../../assets";
import { runBuild } from "../container";
import { dockerBuildArgs } from "../docker";

/** Pinned like Cloud Hypervisor; the release asset is a signed universal binary
 *  carrying com.apple.security.virtualization. */
export const VFKIT_VERSION = "v0.6.4";
export const VFKIT_SHA256 = "0ed83fc8ca7aa708598835480dba1362406aa7cd1dab3b27464eb76327d9652d";

export const vzDir = () => join(config.dataDir, "vz");
const binDir = () => join(vzDir(), "bin");

/** The VMM binary: SADBOX_VFKIT_BIN, a pinned download, or vfkit on PATH. */
export function vfkitBin(): string {
  if (process.env.SADBOX_VFKIT_BIN) return process.env.SADBOX_VFKIT_BIN;
  const pinned = join(binDir(), `vfkit-${VFKIT_VERSION}`);
  if (existsSync(pinned)) return pinned;
  return Bun.which("vfkit") ?? pinned;
}

/** The guest kernel: SADBOX_VZ_KERNEL, or the build under the data dir. */
export const kernelPath = () => process.env.SADBOX_VZ_KERNEL || join(binDir(), "vmlinuz");
/** Its initramfs: SADBOX_VZ_INITRD, or the one built with the kernel. */
export const initrdPath = () => process.env.SADBOX_VZ_INITRD || join(binDir(), "initrd.img");

const vfkitUrl = () => `https://github.com/crc-org/vfkit/releases/download/${VFKIT_VERSION}/vfkit`;

/** What stands between this machine and running VMs, as fixable sentences; empty when nothing does. */
export function vmmProblems(): { error: string; fix?: string }[] {
  const out: { error: string; fix?: string }[] = [];
  if (!process.env.SADBOX_TEST_FAKE_VMM) { // tests run a stand-in VMM (test/fake-vfkit.ts), on any machine
    if (process.platform !== "darwin") out.push({ error: "Virtualization.framework VMs need a Mac" });
  }
  if (!existsSync(vfkitBin())) out.push({ error: `vfkit is not installed (${vfkitBin()})`, fix: "sadbox setup (or brew install vfkit)" });
  if (!existsSync(kernelPath()) || !existsSync(initrdPath())) out.push({ error: `the guest kernel and initramfs are not built (${binDir()})`, fix: "sadbox setup" });
  return out;
}

async function download(url: string, dest: string, mode: number, sha256?: string): Promise<void> {
  mkdirSync(binDir(), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256) {
    const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (got !== sha256) throw new Error(`downloaded ${url} does not match its pinned sha256 (got ${got})`);
  }
  const tmp = `${dest}.part`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, bytes);
  chmodSync(tmp, mode);
  renameSync(tmp, dest);
}

/** Build the guest kernel and initramfs for this Mac's architecture. */
async function buildKernel(): Promise<void> {
  const ctx = mkdtempSync(join(tmpdir(), "sadbox-kernel-"));
  try {
    for (const [name, path] of Object.entries(kernelImageFiles)) await Bun.write(join(ctx, name), Bun.file(path));
    mkdirSync(binDir(), { recursive: true });
    await runBuild(await dockerBuildArgs(["-o", `type=local,dest=${binDir()}`, ctx]), "guest kernel build", true);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

/** Fetch vfkit and build the kernel if either is missing. */
export async function ensureVmm(note: (msg: string) => void = () => {}): Promise<void> {
  if (!existsSync(vfkitBin())) {
    if (process.env.SADBOX_VFKIT_BIN) throw new Error(`SADBOX_VFKIT_BIN is ${vfkitBin()}, which does not exist`);
    note(`downloading vfkit ${VFKIT_VERSION}`);
    await download(vfkitUrl(), vfkitBin(), 0o755, VFKIT_SHA256);
  }
  if (!existsSync(kernelPath()) || !existsSync(initrdPath())) {
    if (process.env.SADBOX_VZ_KERNEL) throw new Error(`SADBOX_VZ_KERNEL is ${kernelPath()}, which does not exist`);
    if (process.env.SADBOX_VZ_INITRD) throw new Error(`SADBOX_VZ_INITRD is ${initrdPath()}, which does not exist`);
    note("building the guest kernel and initramfs (Debian, a minute or two)");
    await buildKernel();
  }
}
