import { containerDriver } from "./container";
import { kvmDriver } from "./kvm";
import type { ProjectDriver } from "./types";

// macOS → Apple's container CLI; Linux → Cloud Hypervisor on KVM
// (docs/research/02, Architecture A). SADBOX_DRIVER=container|kvm overrides.
export function getDriver(): ProjectDriver {
  const want = process.env.SADBOX_DRIVER || (process.platform === "linux" ? "kvm" : "container");
  if (want === "kvm") return kvmDriver;
  if (want === "container") return containerDriver;
  throw new Error(`SADBOX_DRIVER=${want}: not a driver (container or kvm)`);
}
