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
import { getDriver } from "../driver";

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

/** Build the base image from the embedded recipe. `inherit` shows the build
 *  output on this terminal (sadbox setup); otherwise its tail is in the error. */
export async function buildBaseImage(opts: { inherit?: boolean } = {}): Promise<void> {
  const ctx = mkdtempSync(join(tmpdir(), "sadbox-img-"));
  try {
    for (const [name, embeddedPath] of Object.entries(baseImageFiles)) {
      await Bun.write(join(ctx, name), Bun.file(embeddedPath));
    }
    await getDriver().images.build(ctx, config.baseImage, await recipeHash(), opts);
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
  const have = await getDriver().images.recipe(config.baseImage);
  if (have === (await recipeHash())) return;
  note(have === undefined ? `building the base image ${config.baseImage}` : `the base image ${config.baseImage} is out of date — rebuilding it`);
  building ??= buildBaseImage().finally(() => { building = null; });
  await building;
}
