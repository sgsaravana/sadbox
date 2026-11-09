import { afterAll, afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { config } from "../config";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { createHash, randomBytes } from "node:crypto";
import { forwardTicket } from "../core/auth";
import { AUTH_PATH, createForward, deleteForward, listForwards, noteUiOrigin, purgeProjectForwards, setForwardAccess, startForwards } from "./forwards";

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

/** A stand-in for an app in the VM. /cookie answers with the Cookie header it
 *  got, /set tries to set sadbox's cookies, /ws is a WebSocket echo. */
async function guestApp(body = "hello from the vm"): Promise<number> {
  const server = Bun.serve<{ cookie: string | null }>({
    port: 0, hostname: "127.0.0.1",
    async fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/ws" && srv.upgrade(req, { data: { cookie: req.headers.get("cookie") } })) return;
      if (path === "/cookie") return new Response(req.headers.get("cookie") ?? "(none)");
      if (path === "/set") {
        const h = new Headers();
        h.append("set-cookie", "sadbox_session=evil; Path=/");
        h.append("set-cookie", "app=1; Path=/");
        return new Response("set", { headers: h });
      }
      if (req.method === "POST") return new Response(String((await req.arrayBuffer()).byteLength));
      return new Response(body);
    },
    websocket: { message(ws, m) { ws.send(`echo ${m} (cookie: ${ws.data.cookie ?? "none"})`); } },
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
    const f = await createForward(A, { hostPort, guestPort, access: "open" });
    expect(f.active).toBe(true);
    const res = await fetch(`http://127.0.0.1:${hostPort}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from the vm");
  });

  test("passes a large upload through intact", async () => {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    await createForward(A, { hostPort, guestPort, access: "open" });
    const size = 8 * 1024 * 1024;
    const res = await fetch(`http://127.0.0.1:${hostPort}/`, { method: "POST", body: new Uint8Array(size) });
    expect(await res.text()).toBe(String(size));
  });

  test("several forwards route independently", async () => {
    const [g1, g2] = [await guestApp("one"), await guestApp("two")];
    const [h1, h2] = [await freePort(), await freePort()];
    await createForward(A, { hostPort: h1, guestPort: g1, access: "open" });
    await createForward(B, { hostPort: h2, guestPort: g2, access: "open" });
    expect(await (await fetch(`http://127.0.0.1:${h1}/`)).text()).toBe("one");
    expect(await (await fetch(`http://127.0.0.1:${h2}/`)).text()).toBe("two");
    expect(listForwards(A).map((f) => f.host_port)).toEqual([h1]);
    expect(listForwards(B).map((f) => f.host_port)).toEqual([h2]);
  });

  test("nothing listening in the VM drops the connection instead of hanging", async () => {
    const guestPort = await freePort();
    const hostPort = await freePort();
    await createForward(A, { hostPort, guestPort, access: "open" });
    expect(await refused(hostPort)).toBe(true);
  });
});

describe("removal and restart", () => {
  test("deleteForward closes the port and removes the row", async () => {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort, guestPort, access: "open" });
    deleteForward(A, f.id);
    expect(listForwards(A)).toEqual([]);
    expect(await refused(hostPort)).toBe(true);
  });

  test("deleteForward ignores a forward that belongs to another project", async () => {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort, guestPort, access: "open" });
    deleteForward(B, f.id);
    expect(listForwards(A).map((x) => x.id)).toEqual([f.id]);
    expect((await fetch(`http://127.0.0.1:${hostPort}/`)).status).toBe(200);
  });

  test("purgeProjectForwards frees every port of that project only", async () => {
    const guestPort = await guestApp();
    const [h1, h2, h3] = [await freePort(), await freePort(), await freePort()];
    await createForward(A, { hostPort: h1, guestPort, access: "open" });
    await createForward(A, { hostPort: h2, guestPort, access: "open" });
    await createForward(B, { hostPort: h3, guestPort, access: "open" });
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
    ins.run("r-ok", A, ok, guestPort); // made before access: behind sign-in
    ins.run("r-taken", A, taken, guestPort);
    ins.run("r-dead", gone, dead, guestPort);
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(taken, "127.0.0.1", () => r()));
    try {
      await startForwards();
      const byId = Object.fromEntries(listForwards(A).map((f) => [f.id, f.active]));
      expect(byId).toEqual({ "r-ok": true, "r-taken": false });
      expect((await fetch(`http://127.0.0.1:${ok}/`)).status).toBe(401);
      expect(await refused(dead)).toBe(true);
    } finally {
      squatter.close();
      db.run("DELETE FROM port_forwards WHERE project_id = 'fwd-gone'");
    }
  });
});

describe("sign-in forwards", () => {
  /** A signed-in UI session, as core/auth's login() would leave it. */
  function session(): string {
    const token = randomBytes(16).toString("hex");
    db.query("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
      .run(createHash("sha256").update(token).digest("hex"), Date.now() + 60_000);
    return token;
  }
  const uiRequest = (token: string) => new Request("http://ui/", { headers: { cookie: `sadbox_session=${token}` } });

  /** Go through the UI's ticket and the forward's trade, as a browser would. */
  async function signIn(hostPort: number, fid: string, token = session(), next = "/") {
    const res = await fetch(`http://127.0.0.1:${hostPort}${AUTH_PATH}?t=${forwardTicket(uiRequest(token), fid)}&next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(next);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(new RegExp(`^sadbox_fwd_${hostPort}=[^;]+; Path=/; HttpOnly; SameSite=Lax`));
    return { cookie: set.split(";")[0], token };
  }

  async function signinForward() {
    const guestPort = await guestApp();
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort, guestPort });
    expect(f.access).toBe("signin");
    return { f, hostPort, base: `http://127.0.0.1:${hostPort}` };
  }

  test("new forwards are behind sign-in: no pass, no app", async () => {
    const { f, base } = await signinForward();
    const api = await fetch(`${base}/`);
    expect(api.status).toBe(401);
    // a page load is sent to the UI, which hands out the pass
    noteUiOrigin("https://sadbox.example.com");
    const page = await fetch(`${base}/app?x=1`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`https://sadbox.example.com/forwards/${f.id}/open?next=${encodeURIComponent("/app?x=1")}`);
    // the UI's own session cookie is no way in
    expect((await fetch(`${base}/`, { headers: { cookie: `sadbox_session=${session()}` } })).status).toBe(401);
  });

  test("a ticket buys a pass; the app never sees sadbox's cookies", async () => {
    const { f, hostPort, base } = await signinForward();
    const { cookie, token } = await signIn(hostPort, f.id, undefined, "/cookie");
    const res = await fetch(`${base}/cookie`, { headers: { cookie: `${cookie}; sadbox_session=${token}; theme=dark` } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("theme=dark");
    expect(await (await fetch(`${base}/cookie`, { headers: { cookie } })).text()).toBe("(none)");
    // nor may it set them
    const set = await fetch(`${base}/set`, { headers: { cookie } });
    expect(set.headers.getSetCookie()).toEqual(["app=1; Path=/"]);
  });

  test("a ticket is single-use, for its own forward only", async () => {
    const one = await signinForward();
    const two = await signinForward();
    const t = forwardTicket(uiRequest(session()), one.f.id);
    expect((await fetch(`${two.base}${AUTH_PATH}?t=${t}`, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(`${one.base}${AUTH_PATH}?t=${t}`, { redirect: "manual" })).status).toBe(403); // spent above
    expect((await fetch(`${one.base}${AUTH_PATH}?t=made-up`, { redirect: "manual" })).status).toBe(403);
    // and a pass for one forward does not open another
    const { cookie } = await signIn(one.hostPort, one.f.id);
    expect((await fetch(`${two.base}/`, { headers: { cookie: cookie.replace(String(one.hostPort), String(two.hostPort)) } })).status).toBe(401);
  });

  test("next is a local path only", async () => {
    const { f, hostPort } = await signinForward();
    const t = forwardTicket(uiRequest(session()), f.id);
    const res = await fetch(`http://127.0.0.1:${hostPort}${AUTH_PATH}?t=${t}&next=${encodeURIComponent("//evil.example")}`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe("/");
  });

  test("the pass ends with the UI session it came from", async () => {
    const { f, hostPort, base } = await signinForward();
    const { cookie, token } = await signIn(hostPort, f.id);
    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(200);
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(createHash("sha256").update(token).digest("hex")); // sign-out
    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(401);
  });

  test("WebSockets need the pass too, and go through with it", async () => {
    const { f, hostPort } = await signinForward();
    const ws = (cookie?: string) => new Promise<string>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${hostPort}/ws`, cookie ? { headers: { cookie } } as any : undefined);
      s.onopen = () => s.send("ping");
      s.onmessage = (e) => { resolve(String(e.data)); s.close(); };
      s.onerror = () => resolve("refused");
      s.onclose = () => resolve("refused");
    });
    expect(await ws()).toBe("refused");
    const { cookie } = await signIn(hostPort, f.id);
    expect(await ws(`${cookie}; app=2`)).toBe("echo ping (cookie: app=2)");
  });

  test("nothing listening in the VM is a 502, not a hang", async () => {
    const hostPort = await freePort();
    const f = await createForward(A, { hostPort, guestPort: await freePort() });
    const { cookie } = await signIn(hostPort, f.id);
    expect((await fetch(`http://127.0.0.1:${hostPort}/`, { headers: { cookie } })).status).toBe(502);
  });

  test("a forward can be opened to anyone and put back behind sign-in", async () => {
    const { f, base } = await signinForward();
    expect((await setForwardAccess(A, f.id, "open")).access).toBe("open");
    expect((await fetch(`${base}/`)).status).toBe(200);
    await setForwardAccess(A, f.id, "signin");
    expect((await fetch(`${base}/`)).status).toBe(401);
    await expect(setForwardAccess(A, f.id, "public")).rejects.toThrow(/access/);
    await expect(setForwardAccess(B, f.id, "open")).rejects.toThrow(/not found/);
  });
});
