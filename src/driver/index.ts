import { containerDriver } from "./container";
import type { WorkerDriver } from "./types";

// macOS → Apple container CLI. A Linux/Cloud-Hypervisor driver slots in here
// later (docs/research/02, Architecture A).
export function getDriver(): WorkerDriver {
  return containerDriver;
}
