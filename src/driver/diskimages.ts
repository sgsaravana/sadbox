// A sadbox image as a disk a microVM boots: Docker builds the image from its
// Dockerfile as usual; a second build (images/disk) turns it into an ext4 disk
// with the guest agent as init. Shared by driver/kvm (Cloud Hypervisor) and
// driver/vz (Virtualization.framework): both boot the same raw ext4 disk.
//
// Each backend keeps its own store, because a project boots from a disk of its
// own and the image may be built for a different architecture:
//
//   <root>/<image>/rootfs.ext4   the disk projects are cloned from
//              /meta.json       recipe, user, build time
//
// A rebuild replaces the folder whole; a project boots from its own clone, so
// it is unaffected until it is rebuilt itself.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../config";
import { diskImageFiles } from "../assets";
import { runBuild } from "./container";
import { dockerBin as docker, dockerBuildArgs } from "./docker";
import type { ExecResult, ImageStore } from "./types";

const RECIPE_LABEL = "sadbox.recipe";

export interface DiskMeta {
  image: string;
  recipe: string | null;
  builtAt: string;
  sizeBytes: number;
  /** the image USER's uid and gid in the guest (folders shared in are mapped to them) */
  uid: number;
  gid: number;
}

export interface DiskImages {
  imageDir(image: string): string;
  diskPath(image: string): string;
  diskMeta(image: string): DiskMeta | undefined;
  buildDisk(image: string, recipe: string | null, opts?: { inherit?: boolean }): Promise<void>;
  store: ImageStore;
}

/** An image name as a folder name: "sadbox-base:latest" → "sadbox-base_latest". */
const slug = (image: string) => image.replace(/[^A-Za-z0-9._-]/g, "_");

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

/** The disk store under `imagesDir`, and the operations the driver needs. */
export function diskImages(imagesDir: string): DiskImages {
  const imageDir = (image: string) => join(imagesDir, slug(image));
  const diskPath = (image: string) => join(imageDir(image), "rootfs.ext4");

  function diskMeta(image: string): DiskMeta | undefined {
    try {
      const m = JSON.parse(readFileSync(join(imageDir(image), "meta.json"), "utf8")) as DiskMeta;
      return existsSync(diskPath(image)) ? m : undefined;
    } catch {
      return undefined;
    }
  }

  /** Turn a built Docker image into its disk, replacing the one there. */
  async function buildDisk(image: string, recipe: string | null, opts: { inherit?: boolean } = {}): Promise<void> {
    mkdirSync(imagesDir, { recursive: true });
    const ctx = mkdtempSync(join(tmpdir(), "sadbox-disk-"));
    // next to its final place, so it can be renamed into it
    const out = mkdtempSync(join(imagesDir, `.${slug(image)}-`));
    try {
      for (const [name, path] of Object.entries(diskImageFiles)) await Bun.write(join(ctx, name), Bun.file(path));
      writeFileSync(join(ctx, "image.json"), JSON.stringify(await imageConfig(image)));
      await runBuild(await dockerBuildArgs(["--build-arg", `BASE=${image}`, "--build-arg", `VERSION=${VERSION}`,
        "-o", `type=local,dest=${out}`, ctx]), "disk image build", opts.inherit);
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

  const store: ImageStore = {
    async recipe(image) {
      const m = diskMeta(image);
      return m ? m.recipe : undefined;
    },

    async build(contextDir, image, recipe, opts) {
      // --load: a buildx builder other than docker's own would otherwise keep
      // the tagged image inside itself, where the disk build cannot see it
      await runBuild(await dockerBuildArgs(["--load", "-t", image, "--label", `${RECIPE_LABEL}=${recipe}`, contextDir]),
        "base image build", opts?.inherit);
      await buildDisk(image, recipe, opts);
    },

    async probe(image, shellCmd) {
      // the Docker image the disk was made from has the same files
      return capture([docker(), "run", "--rm", "--network", "none", "--entrypoint", "sh", image, "-c", shellCmd]);
    },
  };

  return { imageDir, diskPath, diskMeta, buildDisk, store };
}
