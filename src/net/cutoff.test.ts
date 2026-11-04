import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { config } from "../config";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { isCutOff, setCutoff } from "./cutoff";
import { listPending, requestApproval } from "./approvals";
import { recentRequests, subscribe } from "./events";
import { startProxy } from "./proxy";

const A = makeProject("cut-a");

describe("setCutoff", () => {
  test("persists on the project row and reads back", () => {
    expect(isCutOff(A)).toBe(false);
    setCutoff(A, true);
    expect(isCutOff(A)).toBe(true);
    expect(db.query("SELECT net_cutoff FROM projects WHERE id=?").get(A)).toEqual({ net_cutoff: 1 });
    setCutoff(A, false);
    expect(isCutOff(A)).toBe(false);
  });

  test("cutting off denies the project's held approvals and tells the live view", async () => {
    const seen: string[] = [];
    const off = subscribe(A, (ev) => { if (ev.type === "cutoff") seen.push(`cutoff:${ev.on}`); if (ev.type === "pending-resolved") seen.push(`resolved:${ev.reason}`); });
    const held = requestApproval({ projectId: A, host: "held.example", method: "GET", scheme: "https", path: "/" });
    setCutoff(A, true);
    expect(await held).toBe("block");
    expect(listPending(A)).toEqual([]);
    expect(seen).toEqual(["resolved:network cut off", "cutoff:true"]);
    off();
    setCutoff(A, false);
  });

  test("unknown or destroyed projects are refused; no project is never cut off", () => {
    expect(() => setCutoff("nope", true)).toThrow(/not found/);
    const D = makeProject("cut-gone", "destroyed");
    expect(() => setCutoff(D, true)).toThrow(/not found/);
    expect(isCutOff(null)).toBe(false);
  });
});

// The real proxy, over TCP, with the stub VM at 127.0.0.1. A cut-off VM is
// refused before any upstream lookup, so no network is needed.
describe("proxy with the network cut off", () => {
  const P = makeProject("cut-proxy");
  let list: ReturnType<typeof spyOn>;
  beforeAll(async () => {
    list = spyOn(getDriver(), "list").mockResolvedValue([
      { ref: "sadbox-proj-cut-proxy", state: "running", address: "127.0.0.1" },
    ]);
    config.proxyPort = 20000 + Math.floor(Math.random() * 20000);
    config.proxyHost = "127.0.0.1";
    await startProxy();
    await Bun.sleep(200);
  });
  afterAll(() => { list.mockRestore(); setCutoff(P, false); });

  /** Send one raw request head to the proxy, return the status line it answers with. */
  const ask = (head: string) => new Promise<string>((resolve, reject) => {
    const s = net.connect(config.proxyPort, "127.0.0.1", () => s.write(head));
    let buf = "";
    s.on("data", (d) => { buf += d; if (buf.includes("\r\n")) { s.destroy(); resolve(buf.split("\r\n")[0]); } });
    s.on("error", reject);
    setTimeout(() => { s.destroy(); resolve(buf.split("\r\n")[0] || "(no answer)"); }, 3000);
  });

  test("CONNECT is refused before any tunnel opens, and logged", async () => {
    setCutoff(P, true);
    expect(await ask("CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n")).toBe("HTTP/1.1 403 Forbidden");
    expect(recentRequests(P).at(-1)).toMatchObject({ host: "api.github.com", status: 403, decision: "blocked", error: "network is cut off for this VM" });
  });

  test("plain http is refused too", async () => {
    setCutoff(P, true);
    expect(await ask("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")).toBe("HTTP/1.1 403 Forbidden");
    expect(recentRequests(P).at(-1)).toMatchObject({ host: "example.com", path: "/", status: 403 });
  });

  test("switched back on, the tunnel opens again", async () => {
    setCutoff(P, false);
    expect(await ask("CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n")).toBe("HTTP/1.1 200 Connection Established");
  });
});
