import { describe, expect, test } from "bun:test";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { getProject, projectDetails, refFor, startProject, stopProject } from "./projects";

const driver = getDriver();
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(50); };

describe("stop / start", () => {
  test("stop shuts the VM down and records it; start brings it back", async () => {
    const id = makeProject("pw1");
    const ref = refFor("proj-pw1");

    expect((await stopProject(id)).state).toBe("stopped");
    expect((await driver.inspect(ref)).state).toBe("stopped");
    expect((await projectDetails(id)).state).toBe("stopped");

    expect((await startProject(id)).state).toBe("running");
    expect((await driver.inspect(ref)).state).toBe("running");
  });

  test("a VM stopped behind sadbox's back is noticed", async () => {
    const id = makeProject("pw2");
    await driver.stop(refFor("proj-pw2"));
    expect(getProject(id)!.state).toBe("running"); // not yet looked at
    const d = await projectDetails(id);
    expect(d.state).toBe("stopped");
    expect(d.live?.state).toBe("stopped");
    expect(getProject(id)!.state).toBe("stopped");
  });

  test("a VM booted behind sadbox's back gets its start finished", async () => {
    const id = makeProject("pw3", "stopped");
    expect((await projectDetails(id)).state).toBe("starting"); // the stub VM is up
    await until(() => getProject(id)!.state === "running");
    expect(getProject(id)!.state).toBe("running");
  });

  test("states sadbox is in the middle of are left alone", async () => {
    const id = makeProject("pw4", "creating");
    await driver.stop(refFor("proj-pw4"));
    expect((await projectDetails(id)).state).toBe("creating");
    await expect(stopProject(id)).rejects.toThrow(/busy/);
    await expect(startProject(id)).rejects.toThrow(/busy/);
  });

  test("starting a project that is gone is refused", async () => {
    await expect(startProject("nope")).rejects.toThrow(/not found/);
  });
});
