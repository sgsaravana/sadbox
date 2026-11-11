import { containerDriver } from "./container";
import { kvmDriver } from "./kvm";
import { vzDriver } from "./vz";
import type { ProjectDriver } from "./types";

// Linux → Cloud Hypervisor on KVM; Intel Mac → Virtualization.framework
// through vfkit; Apple silicon Mac → Apple's container CLI
// (docs/research/14-intel-mac.md). SADBOX_DRIVER=container|kvm|vz overrides.
export function getDriver(): ProjectDriver {
  const want = process.env.SADBOX_DRIVER
    || (process.platform === "linux" ? "kvm" : process.arch === "x64" ? "vz" : "container");
  if (want === "kvm") return kvmDriver;
  if (want === "vz") return vzDriver;
  if (want === "container") return containerDriver;
  throw new Error(`SADBOX_DRIVER=${want}: not a driver (container, kvm or vz)`);
}
