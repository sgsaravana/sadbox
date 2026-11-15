// Measures the two routing shapes against one mock app. Run: bun test.ts
import http from "node:http";
import net from "node:net";
import { startApp } from "./app";
import { startRouter } from "./router";

const APP_A = 15701;
const APP_B = 15702;
const PATH_PORT = 15700;
const HOST_PORT = 15710;
const BASE_PORT = 15711;

const routes = new Map([["sample", APP_A], ["other", APP_B]]);
const appA = await startApp(APP_A, "sample");
const appB = await startApp(APP_B, "other");
const pathRouter = await startRouter({ mode: "path", port: PATH_PORT, routes });
const hostRouter = await startRouter({ mode: "host", port: HOST_PORT, routes });
const baseRouter = await startRouter({ mode: "path", port: BASE_PORT, routes, injectBase: true });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
}

async function get(port: number, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });
  return { status: r.status, headers: r.headers, body: await r.text() };
}

/** Host header without the WHATWG fetch forbidden-header problem. */
function getHost(port: number, path: string, host: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on("error", reject);
  });
}

/** Raw WebSocket client: lets us set Host, which the global WebSocket cannot. */
function wsEcho(port: number, path: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const key = Buffer.from("spike-key-01234").toString("base64");
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let raw = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => reject(new Error("ws timeout")), 2000);
    s.on("data", (buf) => {
      if (!upgraded) {
        raw = Buffer.concat([raw, buf]);
        const end = raw.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = raw.subarray(0, end).toString("latin1");
        if (!head.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          return reject(new Error(head.split("\r\n")[0]));
        }
        upgraded = true;
        raw = raw.subarray(end + 4);
        const payload = Buffer.from("ping");
        const frame = Buffer.alloc(2 + 4 + payload.length);
        frame[0] = 0x81; frame[1] = 0x80 | payload.length;
        const mask = Buffer.from([1, 2, 3, 4]);
        mask.copy(frame, 2);
        for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
        s.write(frame);
        if (raw.length) s.emit("data", Buffer.alloc(0));
        return;
      }
      raw = Buffer.concat([raw, buf]);
      // server frames are unmasked: [0x81][len][payload]
      if (raw.length < 2 || raw[1] > raw.length - 2) return;
      const text = raw.subarray(2, 2 + raw[1]).toString("utf8");
      clearTimeout(timer);
      s.end();
      resolve(text);
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

console.log("\n== PATH MODE — /p/<name>/… ==");
{
  const echo = await get(PATH_PORT, "/p/sample/echo");
  const j = JSON.parse(echo.body);
  check("prefix is stripped upstream", j.path === "/echo", `upstream saw ${j.path}`);
  check("X-Forwarded-Prefix is set", j.forwardedPrefix === "/p/sample", String(j.forwardedPrefix));

  const slash = await get(PATH_PORT, "/p/sample?x=1");
  check("missing trailing slash redirects", slash.status === 308 && slash.headers.get("location") === "/p/sample/?x=1",
    `${slash.status} → ${slash.headers.get("location")}`);

  const unknown = await get(PATH_PORT, "/p/nope/");
  check("unknown name is 404", unknown.status === 404, `${unknown.status}`);

  const redirect = await get(PATH_PORT, "/p/sample/go");
  check("Location is rewritten with the prefix", redirect.headers.get("location") === "/p/sample/after",
    String(redirect.headers.get("location")));

  const cookie = await get(PATH_PORT, "/p/sample/cookie");
  check("Set-Cookie Path is scoped", /path=\/p\/sample/i.test(cookie.headers.get("set-cookie") ?? ""),
    String(cookie.headers.get("set-cookie")));

  const ws = await wsEcho(PATH_PORT, "/p/sample/ws", "127.0.0.1:15700");
  check("WebSocket is carried, path stripped", ws === "echo:ping", JSON.stringify(ws));

  const html = await get(PATH_PORT, "/p/sample/");
  check("HTML keeps root-absolute asset URLs (breaks in a browser)",
    html.body.includes('src="/app.js"'), 'browser asks for /app.js, not /p/sample/app.js');

  const abs = await get(PATH_PORT, "/p/sample/absurl");
  const absHref = abs.body.match(/href="([^"]+)"/)?.[1] ?? "";
  check("app-generated absolute URL loses the prefix", absHref === "http://127.0.0.1:15700/absolute", absHref);

  const a = JSON.parse((await get(PATH_PORT, "/p/sample/echo")).body);
  const b = JSON.parse((await get(PATH_PORT, "/p/other/echo")).body);
  check("two named routes reach two different apps", a.path === "/echo" && b.path === "/echo",
    `${a.path} / ${b.path}`);

  const based = await get(BASE_PORT, "/p/sample/");
  check("<base href> makes relative links work", based.body.includes('<base href="/p/sample/">'));
  check("<base href> does NOT fix root-absolute links", based.body.includes('src="/app.js"'));
}

console.log("\n== HOST MODE — <name>.sadbox.test ==");
{
  const echo = await getHost(HOST_PORT, "/echo", "sample.sadbox.test");
  const j = JSON.parse(echo.body);
  check("name comes from the Host header", j.host === "sample.sadbox.test", j.host);
  check("path is unchanged", j.path === "/echo", j.path);
  check("no prefix is injected", j.forwardedPrefix === null, String(j.forwardedPrefix));

  const redirect = await getHost(HOST_PORT, "/go", "sample.sadbox.test");
  check("Location is unchanged", redirect.headers.location === "/after", String(redirect.headers.location));

  const cookie = await getHost(HOST_PORT, "/cookie", "sample.sadbox.test");
  check("Set-Cookie Path=/ is unchanged", /path=\//i.test(String(cookie.headers["set-cookie"])),
    String(cookie.headers["set-cookie"]));

  const html = await getHost(HOST_PORT, "/", "sample.sadbox.test");
  check("root-absolute URLs are correct at the app root", html.body.includes('src="/app.js"'));

  const ws = await wsEcho(HOST_PORT, "/ws", "sample.sadbox.test");
  check("WebSocket is carried at /ws", ws === "echo:ping", JSON.stringify(ws));

  const unknown = await getHost(HOST_PORT, "/", "nobody.sadbox.test");
  check("unknown host is 404", unknown.status === 404, `${unknown.status}`);

  const a = JSON.parse((await getHost(HOST_PORT, "/api/data", "sample.sadbox.test")).body);
  const b = JSON.parse((await getHost(HOST_PORT, "/api/data", "other.sadbox.test")).body);
  check("two hosts reach two different apps", a.app === "sample" && b.app === "other", `${a.app}/${b.app}`);
}

for (const s of [pathRouter, hostRouter, baseRouter, appA, appB]) s.close();
console.log(`\n${failures ? `${failures} checks failed` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
