import { afterAll, afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import { carryLink, createLink, deleteLink, linkTarget, listLinks, purgeProjectLinks } from "./links";

// The preload stubs the `container` CLI so a bridge into any "VM" lands on this
// machine's loopback — the linked app is just a local server here.
const A = makeProject("lnk-a");
const B = makeProject("lnk-b");
const C = makeProject("lnk-c");
const OFF = makeProject("lnk-off", "stopped");

const closers: (() => void)[] = [];
afterEach(() => { for (const p of [A, B, C, OFF]) purgeProjectLinks(p); });
afterAll(() => { for (const c of closers) c(); });

/** The app in the target VM: echoes what it was asked. */
function app(): number {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = req.method === "POST" ? await req.text() : "";
      return Response.json({ method: req.method, path: new URL(req.url).pathname + new URL(req.url).search,
        host: req.headers.get("host"), fwd: req.headers.get("x-forwarded-host"), body });
    },
  });
  closers.push(() => server.stop(true));
  return server.port!;
}

/** The proxy's front door, cut down to what a link needs: read the request
 *  line, hand the socket over as if it came from project `from`. */
function proxyFor(from: string | null): string {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      socket.off("data", onData);
      socket.pause();
      const [method, target] = buf.subarray(0, nl).toString().split(" ");
      carryLink(socket, buf, method, target, from);
    };
    socket.on("data", onData);
  }).listen(0, "127.0.0.1");
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

const via = (proxy: string, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, proxy } as RequestInit & { proxy: string });

describe("link names", () => {
  test("only <project>.sadbox.internal names a project", () => {
    expect(linkTarget("api.sadbox.internal")).toBe("api");
    expect(linkTarget("API.Sadbox.Internal")).toBe("api");
    expect(linkTarget("my-api.sadbox.internal.")).toBe("my-api");
    expect(linkTarget("x.api.sadbox.internal")).toBeNull();   // in the domain, but no such name
    expect(linkTarget("sadbox.internal")).toBeNull();
    expect(linkTarget("api.sadbox.internal.evil.com")).toBeUndefined();
    expect(linkTarget("example.com")).toBeUndefined();
    expect(linkTarget("localhost")).toBeUndefined();
  });
});

describe("creating and removing links", () => {
  test("a link is one project, one port, one way", () => {
    const l = createLink(A, { to: "proj-lnk-b", port: "3000" });
    expect(l).toMatchObject({ project: B, name: "proj-lnk-b", port: 3000, host: "proj-lnk-b.sadbox.internal:3000" });
    expect(listLinks(A)).toEqual({ outgoing: [l], incoming: [] });
    expect(listLinks(B).incoming).toEqual([{ ...l, project: A, name: "proj-lnk-a" }]);
    expect(listLinks(B).outgoing).toEqual([]);
    createLink(A, { to: B, port: 5173 }); // by id too
    expect(listLinks(A).outgoing.map((x) => x.port)).toEqual([3000, 5173]);
  });

  test("bad requests are refused", () => {
    for (const port of [0, 65536, -1, 80.5, "abc", null, undefined]) {
      expect(() => createLink(A, { to: B, port })).toThrow(/port must be/);
    }
    expect(() => createLink(A, { to: A, port: 80 })).toThrow(/itself/);
    expect(() => createLink(A, { to: "nope", port: 80 })).toThrow(/not found/);
    expect(() => createLink(A, { to: "", port: 80 })).toThrow(/not found/);
    expect(() => createLink("missing", { to: B, port: 80 })).toThrow(/project not found/);
    createLink(A, { to: B, port: 80 });
    expect(() => createLink(A, { to: B, port: 80 })).toThrow(/already/);
  });

  test("either end can remove a link; destroying either project removes it", () => {
    const l1 = createLink(A, { to: B, port: 1 });
    deleteLink(B, l1.id);
    expect(listLinks(A).outgoing).toEqual([]);
    const l2 = createLink(A, { to: B, port: 2 });
    deleteLink(C, l2.id); // not one of its links: ignored
    expect(listLinks(A).outgoing.length).toBe(1);
    createLink(C, { to: A, port: 3 });
    purgeProjectLinks(A);
    expect(db.query("SELECT COUNT(*) AS n FROM project_links").get()).toEqual({ n: 0 });
  });
});

describe("carrying a request over a link", () => {
  test("a linked port is reached, as a local caller, with the body intact", async () => {
    const port = app();
    createLink(A, { to: B, port });
    const r = await via(proxyFor(A), `http://proj-lnk-b.sadbox.internal:${port}/items?x=1`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ method: "GET", path: "/items?x=1", host: `localhost:${port}`,
      fwd: `proj-lnk-b.sadbox.internal:${port}`, body: "" });
    const p = await via(proxyFor(A), `http://proj-lnk-b.sadbox.internal:${port}/save`, { method: "POST", body: "x".repeat(100_000) });
    expect((await p.json()).body.length).toBe(100_000);
  });

  test("anything the link does not name is refused", async () => {
    const port = app(), other = app();
    createLink(A, { to: B, port });
    const status = async (from: string | null, url: string) => (await via(proxyFor(from), url)).status;
    expect(await status(A, `http://proj-lnk-b.sadbox.internal:${other}/`)).toBe(403);   // another port
    expect(await status(B, `http://proj-lnk-a.sadbox.internal:${port}/`)).toBe(403);    // the other way
    expect(await status(C, `http://proj-lnk-b.sadbox.internal:${port}/`)).toBe(403);    // another project
    expect(await status(A, `http://proj-lnk-c.sadbox.internal:${port}/`)).toBe(403);    // another target
    expect(await status(A, `http://x.proj-lnk-b.sadbox.internal:${port}/`)).toBe(403);  // not a project name
    expect(await status(null, `http://proj-lnk-b.sadbox.internal:${port}/`)).toBe(403); // unknown caller
    const r = await via(proxyFor(A), `http://proj-lnk-b.sadbox.internal:${other}/`);
    expect(await r.text()).toContain("has no link to");
  });

  test("a stopped target answers 502", async () => {
    createLink(A, { to: OFF, port: 3000 });
    expect((await via(proxyFor(A), "http://proj-lnk-off.sadbox.internal:3000/")).status).toBe(502);
  });

  test("CONNECT becomes a raw tunnel to the linked port only", async () => {
    const port = app();
    createLink(A, { to: B, port });
    const proxy = new URL(proxyFor(A));
    const talk = (target: string) => new Promise<string>((resolve) => {
      const s = net.connect(Number(proxy.port), "127.0.0.1", () => {
        s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      let got = "", sent = false;
      s.on("data", (d) => {
        got += d.toString();
        if (!sent && got.includes("200 Connection Established\r\n\r\n")) {
          sent = true;
          s.write("GET /tunnelled HTTP/1.1\r\nHost: whatever\r\nConnection: close\r\n\r\n");
        }
      });
      s.on("close", () => resolve(got));
    });
    const ok = await talk(`proj-lnk-b.sadbox.internal:${port}`);
    expect(ok).toContain("200 Connection Established");
    expect(ok).toContain('"path":"/tunnelled"');
    expect(await talk(`proj-lnk-b.sadbox.internal:${port + 1}`)).toStartWith("HTTP/1.1 403");
  });
});
