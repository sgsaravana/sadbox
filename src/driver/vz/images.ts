// The vz driver's images: the same disk pipeline as the KVM driver (Docker
// builds the image, images/disk turns it into ext4 with the agent as init),
// kept under the data dir next to vfkit and the kernel. Docker on an Intel Mac
// builds linux/amd64 natively; on Apple silicon, linux/arm64.
import { join } from "node:path";
import { diskImages } from "../diskimages";
import { vzDir } from "./vmm";

const disks = diskImages(join(vzDir(), "images"));

export type { DiskMeta } from "../diskimages";
export const imageDir = disks.imageDir;
export const diskPath = disks.diskPath;
export const diskMeta = disks.diskMeta;
export const buildDisk = disks.buildDisk;
export const vzImages = disks.store;
