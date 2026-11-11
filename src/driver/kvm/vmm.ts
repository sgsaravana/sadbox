// Cloud Hypervisor and the guest kernel it boots: pinned versions, fetched
// into the data dir on first use (`sadbox setup`), or named by the environment.
// The versions are the ones spikes/e-cloud-hypervisor proved.
import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config";
import { CH_VERSION, KERNEL_TAG, chBinAsset, chKernelAsset, kernelUrl } from "../kernels";

export { CH_VERSION, KERNEL_TAG };

export const kvmDir = () => join(config.dataDir, "kvm");
const binDir = () => join(kvmDir(), "bin");

/** The VMM binary: SADBOX_CH_BIN, or the pinned release under the data dir. */
export const chBin = () => process.env.SADBOX_CH_BIN || join(binDir(), `cloud-hypervisor-${CH_VERSION}`);
/** The guest kernel: SADBOX_KVM_KERNEL, or the pinned build under the data dir. */
export const kernelPath = () => process.env.SADBOX_KVM_KERNEL || join(binDir(), `${chKernelAsset}-${KERNEL_TAG}`);

const chUrl = () => `https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/${CH_VERSION}/${chBinAsset}`;

/** What stands between this machine and running VMs, as fixable sentences; empty when nothing does. */
export function vmmProblems(): { error: string; fix?: string }[] {
  const out: { error: string; fix?: string }[] = [];
  if (!process.env.SADBOX_TEST_FAKE_VMM) { // tests run a stand-in VMM (test/fake-ch.ts), on any machine
    if (process.platform !== "linux") out.push({ error: "KVM VMs need a Linux host" });
    else if (!existsSync("/dev/kvm")) out.push({ error: "/dev/kvm is missing: this machine has no KVM (virtualization off in the firmware, or a VM without nested virtualization)" });
    else {
      try { accessSync("/dev/kvm", constants.R_OK | constants.W_OK); }
      catch { out.push({ error: "/dev/kvm is not readable and writable by this user", fix: `sudo usermod -aG kvm $USER (then log in again)` }); }
    }
  }
  if (!existsSync(chBin())) out.push({ error: `Cloud Hypervisor is not installed (${chBin()})`, fix: "sadbox setup" });
  if (!existsSync(kernelPath())) out.push({ error: `the guest kernel is not installed (${kernelPath()})`, fix: "sadbox setup" });
  return out;
}

export async function download(url: string, dest: string, mode: number): Promise<void> {
  mkdirSync(binDir(), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  rmSync(tmp, { force: true });
  await Bun.write(tmp, res);
  chmodSync(tmp, mode);
  renameSync(tmp, dest);
}

/** Fetch whatever of Cloud Hypervisor and the kernel is missing. */
export async function ensureVmm(note: (msg: string) => void = () => {}): Promise<void> {
  if (!existsSync(chBin())) {
    if (process.env.SADBOX_CH_BIN) throw new Error(`SADBOX_CH_BIN is ${chBin()}, which does not exist`);
    note(`downloading Cloud Hypervisor ${CH_VERSION}`);
    await download(chUrl(), chBin(), 0o755);
  }
  if (!existsSync(kernelPath())) {
    if (process.env.SADBOX_KVM_KERNEL) throw new Error(`SADBOX_KVM_KERNEL is ${kernelPath()}, which does not exist`);
    note(`downloading the guest kernel (${KERNEL_TAG})`);
    await download(kernelUrl(chKernelAsset), kernelPath(), 0o644);
  }
}

/** virtiofsd, for sharing host folders into VMs; null when it is not installed
 *  (mounts are then not offered: agent history stays on the VM's disk). */
export function virtiofsdBin(): string | null {
  if (process.env.SADBOX_VIRTIOFSD) return process.env.SADBOX_VIRTIOFSD;
  for (const p of [Bun.which("virtiofsd"), "/usr/libexec/virtiofsd", "/usr/lib/qemu/virtiofsd", "/usr/lib/virtiofsd"]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
