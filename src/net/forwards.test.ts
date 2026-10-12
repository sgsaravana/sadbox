import { afterAll, afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { config } from "../config";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { createForward, deleteForward, listForwards, purgeProjectForwards, startForwards } from "./forwards";

// The preload stubs the `container` CLI so every VM resolves to 127.0.0.1 — the
// "guest" side of a forward is just a local server here.
const A = makeProject("fwd-a");
const B = makeProject("fwd-b");

const closers: (() => void)[] = [];
afterEach(() => { purgeProjectForwards(A); purgeProjectForwards(B); });
afterAll(() => { for (const c of closers) c(); });

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A stand-in for an app in the VM. */
async function guestApp(body = "hello from the vm"): Promise<number> {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "POST") return new Response(String((await req.arrayBuffer()).byteLength));
      return new Response(body);
    },
  });
  closers.push(() => server.stop(true));
  return server.port!;
}

const refused = (port: number) => fetch(`http://127.0.0.1:${port}/`).then(() => false, () => true);

describe("createForward validation", () => {
  test("rejects out-of-range and non-numeric ports", async () => {
    const hostPort = await freePort();
    for (const guestPort of [0, 65536, -1, 80.5, "abc", null, undefined]) {
      await expect(createForward(A, { hostPort, guestPort })).rejects.toThrow(/VM port/);
    }
    for (const bad of [0, 80, 1023, 65536, "abc", null]) {
      await expect(createForward(A, { hostPort: bad, guestPort: 8000 })).rejects.toThrow(/host port/);
    }
    expect(listForwards(A)).toEqual([]);
  });

  test("accepts numeric strings (as a form would send them)", async () => {
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort: String(hostPort), guestPort: "8000" });
    expect(f.host_port).toBe(hostPort);
    expect(f.guest_port).toBe(8000);
  });

  test("refuses the supervisor's own ports", async () => {
    await expect(createForward(A, { hostPort: config.port, guestPort: 8000 })).rejects.toThrow(/sadbox itself/);
    await expect(createForward(A, { hostPort: config.proxyPort, guestPort: 8000 })).rejects.toThrow(/sadbox itself/);
  });

  test("refuses unknown and destroyed projects", async () => {
    const hostPort = await freePort();
    await expect(createForward("nope", { hostPort, guestPort: 8000 })).rejects.toThrow(/project not found/);
    const dead = makeProject("fwd-dead", "destroyed");
    await expect(createForward(dead, { hostPort, guestPort: 8000 })).rejects.toThrow(/project not found/);
  });

  test("a host port can be forwarded once, across all projects", async () => {
    const hostPort = await freePort();
    await createForward(A, { hostPort, guestPort: 8000 });
    await expect(createForward(A, { hostPort, guestPort: 9000 })).rejects.toThrow(/already forwarded/);
    await expect(createForward(B, { hostPort, guestPort: 8000 })).rejects.toThrow(/already forwarded/);
  });

  test("a host port something else holds is refused and not stored", async () => {
    const hostPort = await freePort();
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(hostPort, "127.0.0.1", () => r()));
    try {
      await expect(createForward(A, { hostPort, guestPort: 8000 })).rejects.toThrow(/already in use/);
      expect(listForwards(A)).toEqual([]);
    } finally {
      squatter.close();
    }
  });
});

describe("forwarding", () => {
  test("carries a request to the VM port and the response back", async () => {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort, guestPort });
    expect(f.active).toBe(true);
    const res = await fetch(`http://127.0.0.1:${hostPort}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from the vm");
  });

  test("passes a large upload through intact", async () => {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    await createForward(A, { hostPort, guestPort });
    const size = 8 * 1024 * 1024;
    const res = await fetch(`http://127.0.0.1:${hostPort}/`, { method: "POST", body: new Uint8Array(size) });
    expect(await res.text()).toBe(String(size));
  });

  test("several forwards route independently", async () => {
    const [g1, g2] = [await guestApp("one"), await guestApp("two")];
    const [h1, h2] = [await freePort(), await freePort()];
    await createForward(A, { hostPort: h1, guestPort: g1 });
    await createForward(B, { hostPort: h2, guestPort: g2 });
    expect(await (await fetch(`http://127.0.0.1:${h1}/`)).text()).toBe("one");
    expect(await (await fetch(`http://127.0.0.1:${h2}/`)).text()).toBe("two");
    expect(listForwards(A).map((f) => f.host_port)).toEqual([h1]);
    expect(listForwards(B).map((f) => f.host_port)).toEqual([h2]);
  });

  test("nothing listening in the VM drops the connection instead of hanging", async () => {
    const guestPort = await freePort();
    const hostPort = await freePort();
    await createForward(A, { hostPort, guestPort });
    expect(await refused(hostPort)).toBe(true);
  });
});

describe("removal and restart", () => {
  test("deleteForward closes the port and removes the row", async () => {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort, guestPort });
    deleteForward(A, f.id);
    expect(listForwards(A)).toEqual([]);
    expect(await refused(hostPort)).toBe(true);
  });

  test("deleteForward ignores a forward that belongs to another project", async () => {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort, guestPort });
    deleteForward(B, f.id);
    expect(listForwards(A).map((x) => x.id)).toEqual([f.id]);
    expect((await fetch(`http://127.0.0.1:${hostPort}/`)).status).toBe(200);
  });

  test("purgeProjectForwards frees every port of that project only", async () => {
    const guestPort = await guestApp();
    const [h1, h2, h3] = [await freePort(), await freePort(), await freePort()];
    await createForward(A, { hostPort: h1, guestPort });
    await createForward(A, { hostPort: h2, guestPort });
    await createForward(B, { hostPort: h3, guestPort });
    purgeProjectForwards(A);
    expect(listForwards(A)).toEqual([]);
    expect(await refused(h1)).toBe(true);
    expect(await refused(h2)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${h3}/`)).status).toBe(200);
  });

  test("startForwards re-opens stored forwards, skipping destroyed projects and taken ports", async () => {
    const guestPort = await guestApp();
    const [ok, taken, dead] = [await freePort(), await freePort(), await freePort()];
    const gone = makeProject("fwd-gone", "destroyed");
    // rows as a previous supervisor run would have left them
    const ins = db.query("INSERT INTO port_forwards (id, project_id, host_port, guest_port) VALUES (?, ?, ?, ?)");
    ins.run("r-ok", A, ok, guestPort);
    ins.run("r-taken", A, taken, guestPort);
    ins.run("r-dead", gone, dead, guestPort);
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(taken, "127.0.0.1", () => r()));
    try {
      await startForwards();
      const byId = Object.fromEntries(listForwards(A).map((f) => [f.id, f.active]));
      expect(byId).toEqual({ "r-ok": true, "r-taken": false });
      expect((await fetch(`http://127.0.0.1:${ok}/`)).status).toBe(200);
      expect(await refused(dead)).toBe(true);
    } finally {
      squatter.close();
      db.run("DELETE FROM port_forwards WHERE project_id = 'fwd-gone'");
    }
  });
});
