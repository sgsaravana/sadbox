import { expect, test } from "bun:test";
import { duringSetup, inSetup } from "./setup";

test("the provisioning window is open only while the supervisor's own setup runs", async () => {
  expect(inSetup("p")).toBe(false);
  const seen = await duringSetup("p", async () => inSetup("p") && !inSetup("other"));
  expect(seen).toBe(true);
  expect(inSetup("p")).toBe(false);
});

test("the window closes even when setup throws", async () => {
  await expect(duringSetup("p", async () => { throw new Error("clone failed"); })).rejects.toThrow("clone failed");
  expect(inSetup("p")).toBe(false);
});

test("overlapping setups for one project keep it open until the last one ends", async () => {
  let release!: () => void;
  const outer = duringSetup("p", () => new Promise<void>((r) => { release = r; }));
  await duringSetup("p", async () => {});
  expect(inSetup("p")).toBe(true);
  release(); await outer;
  expect(inSetup("p")).toBe(false);
});
