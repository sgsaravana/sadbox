// The Cloud Hypervisor release and the guest kernel the KVM driver boots. The
// kernel is built for Cloud Hypervisor's device model — virtio-pci, virtio-blk,
// ext4, virtio-console (`hvc0`), virtio-fs and vsock built in. The vz driver
// (Virtualization.framework) does not use it: VZ refuses CH's arm64 Image, so it
// builds Debian's kernel instead (images/kernel, src/driver/vz/vmm.ts).

export const CH_VERSION = "v54.0";
export const KERNEL_TAG = "ch-release-v7.2.8-20261009";

export const machine = process.arch === "arm64" ? "aarch64" : "x86_64";
export const chBinAsset = machine === "aarch64" ? "cloud-hypervisor-static-aarch64" : "cloud-hypervisor-static";
export const chKernelAsset = machine === "aarch64" ? "Image-arm64" : "vmlinux-x86_64";

export const kernelUrl = (asset: string) =>
  `https://github.com/cloud-hypervisor/linux/releases/download/${KERNEL_TAG}/${asset}`;
