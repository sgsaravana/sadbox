import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetFor, compareVersions, installBinary, parseChecksums, parseUpdateArgs, parseVersion } from "./update";

const dir = mkdtempSync(join(tmpdir(), "sadbox-update-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("versions", () => {
  test("parses v-prefixed and plain releases", () => {
    expect(parseVersion("v0.5.1")).toEqual({ major: 0, minor: 5, patch: 1, pre: [] });
    expect(parseVersion("0.6.0-beta.2")?.pre).toEqual(["beta", "2"]);
    expect(parseVersion("nope")).toBeNull();
  });

  test("orders releases and pre-releases", () => {
    expect(compareVersions("v0.6.0", "0.5.1")).toBe(1);
    expect(compareVersions("0.5.1", "v0.5.1")).toBe(0);
    expect(compareVersions("0.6.0-beta.1", "0.6.0")).toBe(-1);
    expect(compareVersions("0.6.0", "0.6.0-beta.9")).toBe(1);
    expect(compareVersions("0.6.0-beta.10", "0.6.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(() => compareVersions("latest", "0.5.1")).toThrow(/cannot compare/);
  });
});

describe("assets and checksums", () => {
  test("picks the GitHub asset for this OS and CPU", () => {
    expect(assetFor("darwin", "arm64")).toBe("sadbox-darwin-arm64");
    expect(assetFor("darwin", "x64")).toBe("sadbox-darwin-x64");
    expect(assetFor("linux", "x64")).toBe("sadbox-linux-x64");
    expect(() => assetFor("win32", "x64")).toThrow(/macOS and Linux/);
    expect(() => assetFor("linux", "armv7")).toThrow(/arm64 and x64/);
  });

  test("parses shasum output, with or without a star", () => {
    const h = "a".repeat(64), j = "b".repeat(64);
    const sums = parseChecksums(`${h}  sadbox-linux-x64\n${j} *sadbox-darwin-arm64\nnonsense\n`);
    expect(sums.get("sadbox-linux-x64")).toBe(h);
    expect(sums.get("sadbox-darwin-arm64")).toBe(j);
    expect(sums.size).toBe(2);
  });
});

describe("arguments", () => {
  test("flags and an exact version", () => {
    expect(parseUpdateArgs(["--check", "--prerelease", "--no-restart", "--no-image", "--force"])).toEqual({
      check: true, prerelease: true, restart: false, refreshImage: false, force: true,
    });
    expect(parseUpdateArgs([]).refreshImage).toBe(true);
    expect(parseUpdateArgs(["--version", "0.6.0"]).version).toBe("0.6.0");
    expect(parseUpdateArgs(["--version=v0.6.0"]).version).toBe("v0.6.0");
    expect(() => parseUpdateArgs(["--wat"])).toThrow(/unknown update option/);
    expect(() => parseUpdateArgs(["--version"])).toThrow(/needs a tag/);
  });
});

describe("installBinary", () => {
  test("replaces the file atomically and keeps it executable", () => {
    const target = join(dir, "sadbox");
    writeFileSync(target, "old");
    installBinary(new TextEncoder().encode("new binary"), target);
    expect(readFileSync(target, "utf8")).toBe("new binary");
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});
