import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { projectDetails, refFor } from "./projects";
import { cpuPercent, forgetVitals, liveStats } from "./vitals";

const calls = (ref: string) => {
  const log = process.env.SADBOX_TEST_STATS_LOG!;
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l === ref).length : 0;
};
const sample = (at: number, cpuUsageUsec: number) => ({ at, stats: { cpuUsageUsec } as any });

describe("cpuPercent", () => {
  test("is the share of all the VM's CPUs used between two samples", () => {
    // 2 s of CPU time over 4 s of wall time on 4 CPUs
    expect(cpuPercent(sample(0, 0), sample(4000, 2_000_000), 4)).toBeCloseTo(12.5);
    expect(cpuPercent(sample(0, 0), sample(1000, 1_000_000), 1)).toBeCloseTo(100);
  });
  test("is clamped, and unknown without a usable pair", () => {
    expect(cpuPercent(sample(0, 0), sample(1000, 9_000_000), 1)).toBe(100);
    expect(cpuPercent(sample(0, 5), sample(1000, 0), 1)).toBe(0);
    expect(cpuPercent(sample(0, 0), sample(50, 10), 1)).toBeNull(); // too close together
    expect(cpuPercent(sample(0, 0), sample(1000, 10), 0)).toBeNull();
  });
});

describe("liveStats", () => {
  test("does not wait for a slow sample, and hands it to the next caller", async () => {
    const ref = "sadbox-vitals-a";
    let t = Date.now();
    const first = await liveStats(ref, 4, 50);
    expect(Date.now() - t).toBeLessThan(400);
    expect(first).toEqual({ stats: null, cpuPercent: null, pending: true });

    // a second look while the first sample is still being taken starts nothing new
    await liveStats(ref, 4, 50);
    await Bun.sleep(150); // the stub logs a call once it is running
    expect(calls(ref)).toBe(1);

    await Bun.sleep(900);
    t = Date.now();
    const second = await liveStats(ref, 4, 50);
    expect(Date.now() - t).toBeLessThan(200);
    expect(second.pending).toBe(false);
    expect(second.stats?.memoryUsageBytes).toBe(1048576);
    expect(second.cpuPercent).toBeNull(); // one sample so far
    await Bun.sleep(150);
    expect(calls(ref)).toBe(2);           // …and the next one is on its way

    await Bun.sleep(750);
    const third = await liveStats(ref, 4, 50);
    expect(third.cpuPercent).not.toBeNull();
    await Bun.sleep(700); // let the last sample finish
    forgetVitals(ref);
  });

  test("a stats call that never answers is cut off", async () => {
    const t = Date.now();
    expect(await getDriver().stats("sadbox-stuck", 300)).toBeNull();
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("projectDetails", () => {
  test("overlapping requests for one project share a single round of queries", async () => {
    const id = makeProject("vit1");
    const a = projectDetails(id), b = projectDetails(id);
    expect(a).toBe(b);
    const d = await a;
    expect(d.live?.state).toBe("running");
    expect(d.resources.memoryUsageBytes).toBe(1048576); // sample (0.5 s) arrived within the first wait
    expect(d.partial).toBe(false);
    expect(calls(refFor("proj-vit1"))).toBe(1);

    const t = Date.now();
    const again = await projectDetails(id);
    expect(again).not.toBe(d);
    expect(again.resources.memoryUsageBytes).toBe(1048576);
    expect(Date.now() - t).toBeLessThan(450); // did not wait for the new sample
    await Bun.sleep(700);
    forgetVitals(refFor("proj-vit1"));
  });
});
