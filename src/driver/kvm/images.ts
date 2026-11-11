// The KVM driver's images (ROADMAP L2): the shared disk pipeline, kept under
// the data dir next to Cloud Hypervisor and its kernel.
import { join } from "node:path";
import { diskImages } from "../diskimages";
import { kvmDir } from "./vmm";

const disks = diskImages(join(kvmDir(), "images"));

export type { DiskMeta } from "../diskimages";
export const imageDir = disks.imageDir;
export const diskPath = disks.diskPath;
export const diskMeta = disks.diskMeta;
export const buildDisk = disks.buildDisk;
export const kvmImages = disks.store;
