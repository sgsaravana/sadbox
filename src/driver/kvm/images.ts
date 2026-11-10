// The Linux driver's images (ROADMAP L2): a sadbox image as a disk Cloud
// Hypervisor boots. Docker builds the image from its Dockerfile as usual; a
// second build (images/disk) turns it into an ext4 disk with the guest agent as
// init. Each image's disk lives under the data dir:
//
//   ~/.sadbox/kvm/images/<image>/rootfs.ext4   the disk projects are cloned from
//                                /meta.json    recipe, user, build time
//
// A rebuild replaces the folder whole; a project boots from its own clone
// (vms.ts), so it is unaffected until it is rebuilt itself.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VERSION } from "../../config";
import { diskImageFiles } from "../../assets";
import { runBuild } from "../container";
import type { ExecResult, ImageStore } from "../types";
import { kvmDir } from "./vmm";

const RECIPE_LABEL = "sadbox.recipe";
const docker = () => process.env.SADBOX_DOCKER_BIN || "docker";

export interface DiskMeta {
  image: string;
  recipe: string | null;
  builtAt: string;
  sizeBytes: number;
  /** the image USER's uid and gid in the guest (folders shared in are mapped to them) */
  uid: number;
  gid: number;
}

const imagesDir = () => join(kvmDir(), "images");
/** An image name as a folder name: "sadbox-base:latest" → "sadbox-base_latest". */
const slug = (image: string) => image.replace(/[^A-Za-z0-9._-]/g, "_");
export const imageDir = (image: string) => join(imagesDir(), slug(image));
export const diskPath = (image: string) => join(imageDir(image), "rootfs.ext4");

export function diskMeta(image: string): DiskMeta | undefined {
  try {
    const m = JSON.parse(readFileSync(join(imageDir(image), "meta.json"), "utf8")) as DiskMeta;
    return existsSync(diskPath(image)) ? m : undefined;
  } catch {
    return undefined;
  }
}

async function capture(cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

/** The image's ENV / USER / WORKDIR as Docker has them, for the agent. */
async function imageConfig(image: string): Promise<{ Env: string[]; User: string; WorkingDir: string }> {
  const r = await capture([docker(), "image", "inspect", "--format", "{{json .Config}}", image]);
  if (r.exitCode !== 0) throw new Error(`docker image inspect ${image}: ${r.stderr.trim()}`);
  const c = JSON.parse(r.stdout);
  return { Env: c.Env ?? [], User: c.User ?? "", WorkingDir: c.WorkingDir ?? "" };
}

/** Turn a built Docker image into its disk, replacing the one there. */
export async function buildDisk(image: string, recipe: string | null, opts: { inherit?: boolean } = {}): Promise<void> {
  mkdirSync(imagesDir(), { recursive: true });
  const ctx = mkdtempSync(join(tmpdir(), "sadbox-disk-"));
  // next to its final place, so it can be renamed into it
  const out = mkdtempSync(join(imagesDir(), `.${slug(image)}-`));
  try {
    for (const [name, path] of Object.entries(diskImageFiles)) await Bun.write(join(ctx, name), Bun.file(path));
    writeFileSync(join(ctx, "image.json"), JSON.stringify(await imageConfig(image)));
    await runBuild([docker(), "build", "--progress", "plain", "--build-arg", `BASE=${image}`, "--build-arg", `VERSION=${VERSION}`,
      "-o", `type=local,dest=${out}`, ctx], "disk image build", opts.inherit);
    const [uid, gid] = readFileSync(join(out, "user"), "utf8").trim().split(":").map(Number);
    const meta: DiskMeta = {
      image, recipe, builtAt: new Date().toISOString(), sizeBytes: statSync(join(out, "rootfs.ext4")).size,
      uid: Number.isFinite(uid) ? uid : 0, gid: Number.isFinite(gid) ? gid : 0,
    };
    writeFileSync(join(out, "meta.json"), JSON.stringify(meta, null, 2));
    rmSync(join(out, "user"), { force: true });
    const dest = imageDir(image), old = `${dest}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(dest)) renameSync(dest, old);
    renameSync(out, dest);
    rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(ctx, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

export const kvmImages: ImageStore = {
  async recipe(image) {
    const m = diskMeta(image);
    return m ? m.recipe : undefined;
  },

  async build(contextDir, image, recipe, opts) {
    await runBuild([docker(), "build", "--progress", "plain", "-t", image, "--label", `${RECIPE_LABEL}=${recipe}`, contextDir],
      "base image build", opts?.inherit);
    await buildDisk(image, recipe, opts);
  },

  async probe(image, shellCmd) {
    // the Docker image the disk was made from has the same files
    return capture([docker(), "run", "--rm", "--network", "none", "--entrypoint", "sh", image, "-c", shellCmd]);
  },
};
