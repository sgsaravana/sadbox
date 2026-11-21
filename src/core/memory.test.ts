import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../config";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { getProject, projectDetails, refFor, setProjectCpus, setProjectMemory, stopProject } from "./projects";

const driver = getDriver();
const MB = 1024 * 1024;

/** Give a stub VM the files the runtime keeps for a real one. */
function runtimeFiles(ref: string, memoryMB: number, cpus = 4) {
  const dir = join(config.containerDataDir, "containers", ref);
  mkdirSync(dir, { recursive: true });
  const resources = `"resources":{"cpus":${cpus},"memoryInBytes":${memoryMB * MB}}`;
  // as the runtime writes them: one line, slashes escaped, a float it must not lose
  writeFileSync(join(dir, "config.json"), `{"id":"${ref}","creationDate":782000000.12345601,${resources},"image":"a\\/b"}`);
  writeFileSync(join(dir, "runtime-configuration.json"), `{"path":"file:\\/\\/x","containerConfiguration":{"id":"${ref}",${resources}}}`);
  return (name: string) => readFileSync(join(dir, name), "utf8");
}

describe("project memory", () => {
  test("a running VM is restarted with the new size", async () => {
    const id = makeProject("mem1");
    const ref = refFor("proj-mem1");
    const file = runtimeFiles(ref, 1024);

    const r = await setProjectMemory(id, 4096);
    expect(r).toMatchObject({ memoryMB: 4096, restarted: true, applied: true, state: "running" });
    expect(getProject(id)!.memory_mb).toBe(4096);
    expect((await driver.inspect(ref)).state).toBe("running");
    // only the number changed
    expect(file("config.json")).toBe(`{"id":"${ref}","creationDate":782000000.12345601,"resources":{"cpus":4,"memoryInBytes":${4096 * MB}},"image":"a\\/b"}`);
    expect(file("runtime-configuration.json")).toContain(`"memoryInBytes":${4096 * MB}`);
    const events = db.query<{ type: string }, [string]>("SELECT type FROM events WHERE project_id = ? AND type LIKE 'vm.%' ORDER BY id").all(id).map((e) => e.type);
    expect(events).toEqual(["vm.stop", "vm.start", "vm.memory"]);
  });

  test("a stopped VM stays stopped and boots with it later", async () => {
    const id = makeProject("mem2");
    const ref = refFor("proj-mem2");
    const file = runtimeFiles(ref, 1024);
    await stopProject(id);

    const r = await setProjectMemory(id, 2048);
    expect(r).toMatchObject({ memoryMB: 2048, restarted: false, applied: null, state: "stopped" });
    expect(file("runtime-configuration.json")).toContain(`"memoryInBytes":${2048 * MB}`);
    const d = await projectDetails(id);
    expect(d.resources.memoryMB).toBe(2048);
    expect(d.resources.memoryLimitBytes).toBe(2048 * MB);
  });

  test("a VM whose files cannot be edited comes back up unchanged", async () => {
    const id = makeProject("mem3"); // no runtime files at all
    await expect(setProjectMemory(id, 4096)).rejects.toThrow(/Rebuild applies it/);
    expect(getProject(id)!.memory_mb).toBeNull();
    expect(getProject(id)!.state).toBe("running");
  });

  test("sizes that make no sense are refused before anything is touched", async () => {
    const id = makeProject("mem4");
    for (const bad of [0, 100, 1.5, "lots", 10_000_000, null]) {
      await expect(setProjectMemory(id, bad)).rejects.toThrow(/memory/);
    }
    expect(getProject(id)!.state).toBe("running");
  });

  test("the driver will not edit a running VM", async () => {
    const ref = refFor("proj-mem5");
    runtimeFiles(ref, 1024);
    await expect(driver.setMemory(ref, 2048)).rejects.toThrow(/must be stopped/);
  });
});

describe("project CPUs", () => {
  test("a running VM is restarted with the new count", async () => {
    const id = makeProject("cpu1");
    const ref = refFor("proj-cpu1");
    const file = runtimeFiles(ref, 1024, 4);

    const r = await setProjectCpus(id, 8);
    expect(r).toMatchObject({ cpus: 8, restarted: true, applied: true, state: "running" });
    expect(getProject(id)!.cpus).toBe(8);
    expect((await driver.inspect(ref)).state).toBe("running");
    // only the CPU number changed; memory is still where it was
    expect(file("config.json")).toBe(`{"id":"${ref}","creationDate":782000000.12345601,"resources":{"cpus":8,"memoryInBytes":${1024 * MB}},"image":"a\\/b"}`);
    expect(file("runtime-configuration.json")).toContain(`"cpus":8`);
    const events = db.query<{ type: string }, [string]>("SELECT type FROM events WHERE project_id = ? AND type LIKE 'vm.%' ORDER BY id").all(id).map((e) => e.type);
    expect(events).toEqual(["vm.stop", "vm.start", "vm.cpus"]);
  });

  test("a stopped VM stays stopped and boots with it later", async () => {
    const id = makeProject("cpu2");
    const ref = refFor("proj-cpu2");
    const file = runtimeFiles(ref, 1024, 4);
    await stopProject(id);

    const r = await setProjectCpus(id, 2);
    expect(r).toMatchObject({ cpus: 2, restarted: false, applied: null, state: "stopped" });
    expect(file("runtime-configuration.json")).toContain(`"cpus":2`);
    const d = await projectDetails(id);
    expect(d.cpus).toBe(2);
    expect(d.resources.cpus).toBe(2);
  });

  test("a VM whose files cannot be edited comes back up unchanged", async () => {
    const id = makeProject("cpu3"); // no runtime files at all
    await expect(setProjectCpus(id, 8)).rejects.toThrow(/Rebuild applies it/);
    expect(getProject(id)!.cpus).toBeNull();
    expect(getProject(id)!.state).toBe("running");
  });

  test("counts that make no sense are refused before anything is touched", async () => {
    const id = makeProject("cpu4");
    for (const bad of [0, 17, 1.5, "lots", null]) {
      await expect(setProjectCpus(id, bad)).rejects.toThrow(/CPUs/);
    }
    expect(getProject(id)!.state).toBe("running");
  });

  test("the driver will not edit a running VM", async () => {
    const ref = refFor("proj-cpu5");
    runtimeFiles(ref, 1024, 4);
    await expect(driver.setCpus(ref, 8)).rejects.toThrow(/must be stopped/);
  });
});
