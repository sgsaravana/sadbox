import { describe, expect, test } from "bun:test";
import {
  displayHostPath,
  gitConfigFor,
  isDrvFsPath,
  isWindowsPath,
  normalizeHostPath,
  parseNestedVirtualization,
  windowsPathToWsl,
  wslDoctorLines,
  wslFrom,
  wslPathToWindows,
} from "./wsl";

describe("WSL detection", () => {
  test("recognises WSL from the distro environment", () => {
    expect(wslFrom("linux", { WSL_DISTRO_NAME: "Ubuntu-24.04" }, "Linux 6.6.0")).toEqual({
      distro: "Ubuntu-24.04",
      version: null,
    });
  });

  test("recognises WSL from the Microsoft kernel", () => {
    expect(wslFrom("linux", {}, "Linux 6.6.87.2-microsoft-standard-WSL2 #1 SMP")).toEqual({
      distro: "WSL",
      version: 2,
    });
  });

  test("native Linux and macOS are not WSL", () => {
    expect(wslFrom("linux", {}, "Linux 6.8.0-45-generic #45-Ubuntu SMP")).toBeNull();
    expect(wslFrom("darwin", { WSL_DISTRO_NAME: "Ubuntu" }, "Darwin 25.0.0")).toBeNull();
  });
});

describe("Windows paths", () => {
  test("recognises drive and UNC paths, not POSIX ones", () => {
    expect(isWindowsPath("C:\\Users\\me\\repo")).toBe(true);
    expect(isWindowsPath("d:/work/project")).toBe(true);
    expect(isWindowsPath("C:")).toBe(true);
    expect(isWindowsPath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsPath("/mnt/c/Users/me")).toBe(false);
    expect(isWindowsPath("~/repo")).toBe(false);
  });

  test("translates a drive path to its WSL mount", () => {
    expect(windowsPathToWsl("C:\\Users\\me\\repo")).toBe("/mnt/c/Users/me/repo");
    expect(windowsPathToWsl("d:/work/project/")).toBe("/mnt/d/work/project");
    expect(windowsPathToWsl("C:")).toBe("/mnt/c");
    expect(windowsPathToWsl("C:\\")).toBe("/mnt/c");
  });

  test("UNC paths have no default WSL mount", () => {
    expect(windowsPathToWsl("\\\\server\\share\\repo")).toBeNull();
  });

  test("translates a WSL mount back to a Windows path", () => {
    expect(wslPathToWindows("/mnt/c/Users/me/repo")).toBe("C:\\Users\\me\\repo");
    expect(wslPathToWindows("/mnt/d")).toBe("D:\\");
    expect(wslPathToWindows("/home/me/repo")).toBeNull();
  });

  test("knows which folders live on a Windows drive", () => {
    expect(isDrvFsPath("/mnt/c/Users/me")).toBe(true);
    expect(isDrvFsPath("/mnt/d")).toBe(true);
    expect(isDrvFsPath("/mnt/c")).toBe(true);
    expect(isDrvFsPath("/home/me")).toBe(false);
    expect(isDrvFsPath("/mnt/cache/x")).toBe(false);
  });

  test("normalizes user input only when running on WSL", () => {
    expect(normalizeHostPath("C:\\Users\\me\\repo", true)).toBe("/mnt/c/Users/me/repo");
    expect(normalizeHostPath("C:\\Users\\me\\repo", false)).toBe("C:\\Users\\me\\repo");
    expect(normalizeHostPath("  /home/me/repo  ", true)).toBe("/home/me/repo");
  });

  test("shows Windows paths only when running on WSL", () => {
    expect(displayHostPath("/mnt/c/Users/me", true)).toBe("C:\\Users\\me");
    expect(displayHostPath("/mnt/c/Users/me", false)).toBe("/mnt/c/Users/me");
    expect(displayHostPath("/home/me", true)).toBe("/home/me");
  });

  test("adds git settings only for DrvFs folders", () => {
    expect(gitConfigFor("/mnt/c/Users/me/repo")).toEqual([
      "-c", "safe.directory=/mnt/c/Users/me/repo",
      "-c", "core.fileMode=false",
      "-c", "core.autocrlf=false",
      "-c", "core.symlinks=false",
    ]);
    expect(gitConfigFor("/home/me/repo")).toEqual([]);
  });
});

describe(".wslconfig", () => {
  test("reads the [wsl2] setting", () => {
    expect(parseNestedVirtualization("[wsl2]\nnestedVirtualization=true\n")).toBe(true);
    expect(parseNestedVirtualization("[wsl2]\nNestedVirtualization = false\n")).toBe(false);
    expect(parseNestedVirtualization("[wsl2]\n# nestedVirtualization=false\n")).toBeUndefined();
    expect(parseNestedVirtualization("[experimental]\nnestedVirtualization=false\n")).toBeUndefined();
    expect(parseNestedVirtualization("")).toBeUndefined();
  });
});

describe("doctor text", () => {
  test("explains the fix when /dev/kvm is missing", () => {
    const lines = wslDoctorLines({ distro: "Ubuntu-24.04", version: 2 }, false, "/home/me/.sadbox");
    const text = lines.join("\n");
    expect(text).toContain("Windows: WSL 2, Ubuntu-24.04");
    expect(text).toContain("nestedVirtualization=true");
    expect(text).toContain("wsl --shutdown");
  });

  test("warns when the data dir is on a Windows drive", () => {
    const lines = wslDoctorLines({ distro: "Ubuntu", version: 2 }, true, "/mnt/c/Users/me/.sadbox");
    expect(lines.join("\n")).toContain("data dir is on a Windows drive");
  });
});
