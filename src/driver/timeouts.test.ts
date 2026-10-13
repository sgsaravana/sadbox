import { describe, expect, test } from "bun:test";
import { getDriver } from "./index";

// "sadbox-stuck" is a VM whose commands never return (see test/setup.ts)
const driver = getDriver();
const quick = async <T>(run: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const r = await run();
  expect(Date.now() - t).toBeLessThan(2000);
  return r;
};

describe("a VM that does not answer", () => {
  test("exec gives up and says so", async () => {
    const r = await quick(() => driver.exec("sadbox-stuck", ["sh", "-c", "echo hi"], { timeoutMs: 300 }));
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toMatch(/did not respond/);
  });

  test("exec as another user gives up too", async () => {
    const r = await quick(() => driver.exec("sadbox-stuck", ["true"], { user: "root", timeoutMs: 300 }));
    expect(r.exitCode).toBe(124);
  });

  test("execWithStdin gives up", async () => {
    const r = await quick(() => driver.execWithStdin("sadbox-stuck", "cat > /dev/null", new TextEncoder().encode("x"), { timeoutMs: 300 }));
    expect(r.exitCode).toBe(124);
  });

  test("execCaptureBytes gives up with no output", async () => {
    const r = await quick(() => driver.execCaptureBytes("sadbox-stuck", "cat /etc/hostname", { timeoutMs: 300 }));
    expect(r.exitCode).toBe(124);
    expect(r.stdout.length).toBe(0);
  });

  test("a VM that answers is unaffected by the limit", async () => {
    const wd = "/home/agent/workdir";
    const r = await driver.exec("sadbox-fine", ["sh", "-c", `cd ${wd} && echo ok`], { timeoutMs: 3000 });
    expect(r).toMatchObject({ exitCode: 0, stdout: "ok\n" });
    const b = await driver.execCaptureBytes("sadbox-fine", `cd ${wd} && printf abc`, { timeoutMs: 3000 });
    expect(new TextDecoder().decode(b.stdout)).toBe("abc");
  });
});
