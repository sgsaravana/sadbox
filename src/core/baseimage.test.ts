import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { ensureBaseImage, recipeHash } from "./baseimage";

const builds = () => {
  const log = process.env.SADBOX_TEST_BUILDS_LOG!;
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
};

describe("ensureBaseImage", () => {
  test("builds a missing or outdated image, stamped with the recipe, and leaves a current one alone", async () => {
    const notes: string[] = [];
    writeFileSync(process.env.SADBOX_TEST_IMAGE_RECIPE!, "an-older-recipe");
    const before = builds();
    await ensureBaseImage((m) => notes.push(m));
    expect(builds()).toBe(before + 1);
    expect(notes.join()).toMatch(/out of date/);
    expect(readFileSync(process.env.SADBOX_TEST_IMAGE_RECIPE!, "utf8")).toBe(await recipeHash());

    await ensureBaseImage((m) => notes.push(m));
    expect(builds()).toBe(before + 1);
    expect(notes.length).toBe(1);
  });

  test("callers at the same time share one build", async () => {
    writeFileSync(process.env.SADBOX_TEST_IMAGE_RECIPE!, "stale");
    const before = builds();
    await Promise.all([ensureBaseImage(), ensureBaseImage(), ensureBaseImage()]);
    expect(builds()).toBe(before + 1);
  });
});
