import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { getDriver } from "./index";

// test/setup.ts's stub reports the service as down while this file exists
const marker = process.env.SADBOX_TEST_SERVICE_DOWN!;
const driver = getDriver();
afterEach(() => rmSync(marker, { force: true }));

describe("container service status", () => {
  test("running: version and VM counts", async () => {
    expect(await driver.serviceStatus()).toEqual({ running: true, version: "1.4.1", containersRunning: 1, containersTotal: 3 });
  });

  test("down: the CLI's reason and the command that fixes it", async () => {
    writeFileSync(marker, "");
    const s = await driver.serviceStatus();
    expect(s.running).toBe(false);
    expect(s.error).toMatch(/XPC connection error/);
    expect(s.fix).toBe("container system start");
  });

  test("a VM operation that fails because of it says so", async () => {
    writeFileSync(marker, "");
    await expect(driver.destroy("sadbox-svc")).rejects.toThrow(/container service is not running — start it with `container system start`/);
  });
});
