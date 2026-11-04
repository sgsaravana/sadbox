// The base image every VM boots from, kept in step with its recipe
// (images/base, embedded in the binary). An image built here carries a hash of
// that recipe as a label; when the recipe has changed since — tools added to
// the Dockerfile — the next create or rebuild builds the image again first, so
// the new VM has them.
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "../config";
import { baseImageFiles } from "../assets";

const BIN = config.containerBin;
const LABEL = "sadbox.recipe";
const BUILD_MS = 30 * 60_000; // installs packages, Node and the agents over the network

/** A short hash of the embedded Dockerfile and the files next to it. */
export async function recipeHash(): Promise<string> {
  const h = createHash("sha256");
  for (const name of Object.keys(baseImageFiles).sort()) {
    h.update(`${name}\0`);
    h.update(await Bun.file(baseImageFiles[name]).bytes());
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

// `image inspect` (container CLI 1.4.1): [{ variants: [{ config: { config: { Labels } } }] }]
/** The recipe an image was built from: null if it does not say, undefined if there is no such image. */
async function imageRecipe(image: string): Promise<string | null | undefined> {
  const proc = Bun.spawn([BIN, "image", "inspect", image], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return undefined;
  try {
    for (const v of JSON.parse(out)?.[0]?.variants ?? []) {
      const label = v?.config?.config?.Labels?.[LABEL];
      if (label) return label;
    }
  } catch {}
  return null;
}

/** Build the base image from the embedded recipe. `inherit` shows the build
 *  output on this terminal (sadbox setup); otherwise its tail is in the error. */
export async function buildBaseImage(opts: { inherit?: boolean } = {}): Promise<void> {
  const ctx = mkdtempSync(join(tmpdir(), "sadbox-img-"));
  try {
    for (const [name, embeddedPath] of Object.entries(baseImageFiles)) {
      await Bun.write(join(ctx, name), Bun.file(embeddedPath));
    }
    const out = opts.inherit ? "inherit" : "pipe";
    // not --quiet: on container 1.4.1 a quiet build never finishes
    const proc = Bun.spawn([BIN, "build", "--progress", "plain", "-t", config.baseImage,
      "--label", `${LABEL}=${await recipeHash()}`, ctx], { stdout: out, stderr: out });
    const timer = setTimeout(() => proc.kill("SIGKILL"), BUILD_MS);
    const [stdout, stderr, code] = await Promise.all([
      proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : "",
      proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : "",
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    if (code !== 0) {
      const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-6).join("\n");
      throw new Error(`base image build failed${tail ? `:\n${tail}` : ""}`);
    }
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

let building: Promise<void> | null = null;

/** Build the base image if it is missing or was built from an older recipe.
 *  `note` hears about a build before it starts (it takes minutes). An image
 *  named by SADBOX_BASE_IMAGE is someone else's and is left alone. */
export async function ensureBaseImage(note: (msg: string) => void = () => {}): Promise<void> {
  if (process.env.SADBOX_BASE_IMAGE) return;
  const have = await imageRecipe(config.baseImage);
  if (have === (await recipeHash())) return;
  note(have === undefined ? `building the base image ${config.baseImage}` : `the base image ${config.baseImage} is out of date — rebuilding it`);
  building ??= buildBaseImage().finally(() => { building = null; });
  await building;
}
