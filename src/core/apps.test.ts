import { describe, expect, test } from "bun:test";
import { normalizeAppIds, optionalApp, optionalAppCatalog, optionalAppsFromGuest, storedAppIds } from "./apps";

describe("optional apps", () => {
  test("the catalog offers Blender", () => {
    expect(optionalAppCatalog().map((a) => a.id)).toContain("blender");
    expect(optionalApp("blender")).toMatchObject({ label: "Blender", binary: "blender" });
  });

  test("an unknown id is refused, not silently dropped", () => {
    expect(() => optionalApp("gimp")).toThrow(/unknown optional app/);
    expect(() => normalizeAppIds(["blender", "gimp"])).toThrow(/unknown optional app/);
  });

  test("ids are trimmed, lowercased and de-duplicated", () => {
    expect(normalizeAppIds([" Blender ", "blender"])).toEqual(["blender"]);
    expect(normalizeAppIds("blender")).toEqual(["blender"]);
    expect(normalizeAppIds(undefined)).toEqual([]);
  });

  test("a stored row drops apps the catalog no longer has", () => {
    expect(storedAppIds(JSON.stringify(["blender", "gone"]))).toEqual(["blender"]);
    expect(storedAppIds("not json")).toEqual([]);
    expect(storedAppIds(null)).toEqual([]);
  });

  test("the guest probe says what is installed, and its version", () => {
    const apps = optionalAppsFromGuest({ app_blender: "Blender 4.3.2\nbuild date" });
    const blender = apps.find((a) => a.id === "blender")!;
    expect(blender.installed).toBe(true);
    expect(blender.version).toBe("4.3.2");

    const missing = optionalAppsFromGuest({}).find((a) => a.id === "blender")!;
    expect(missing.installed).toBe(false);
    expect(missing.version).toBeNull();

    // a stopped VM has nothing to probe: the project's recorded choice stands in
    const stopped = optionalAppsFromGuest({}, ["blender"]).find((a) => a.id === "blender")!;
    expect(stopped.installed).toBe(true);
    expect(stopped.version).toBeNull();
  });
});
