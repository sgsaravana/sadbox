import { afterAll, describe, expect, test } from "bun:test";
import { db } from "../db";
import { recordResourceSample, resourceSamples } from "./resources";

const id = `res-test-${process.pid}`;
afterAll(() => db.query("DELETE FROM resource_samples WHERE project_id = ?").run(id));

describe("resource samples", () => {
  test("range filtering and downsampling", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      recordResourceSample(id, {
        ts: now - 50_000 + i * 1_000,
        cpu: i * 4,
        memUsed: 100 + i, memLimit: 1_000,
        diskUsed: 500, diskTotal: 10_000,
        netRx: i * 1_000, netTx: i * 100,
      }, 0);
    }
    const all = resourceSamples(id, 60_000, 100);
    expect(all).toHaveLength(20);
    expect(all[0].cpu).toBe(0);
    expect(all.at(-1)!.cpu).toBe(76);
    const few = resourceSamples(id, 60_000, 5);
    expect(few.length).toBeLessThanOrEqual(5);
    expect(few.at(-1)!.ts).toBe(all.at(-1)!.ts);
    expect(resourceSamples(id, 1_000, 100).length).toBeLessThan(20);
  });
});
