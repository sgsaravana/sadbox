// Spike F.4 — swapping placeholders in request BODIES (docs/research/12, V3).
// Placeholders are not the length of the real value, so a body swap has to
// buffer the body and send it on with a new Content-Length. This checks that
// real clients survive that — fixed-length and chunked bodies, `Expect:
// 100-continue`, JSON / form / text — and that typed rendering works in JSON
// (`"limit": "<ph>"` → `"limit": 50`). Host only, plain http (the TLS side is
// the existing MITM and does not change anything here).
//   bun spikes/f-agent-sessions/body-swap.ts
import http from "node:http";

const CAP = 1 << 20; // bodies larger than this are passed through untouched
const PH = { token: "sk-sbxAAAAAAAAAAAAAAAAAAAAAAAAAAAA", limit: "sbxlimitBBBBBBBBBBBBBBBBBBBBBBBB", cfg: "sbxcfgCCCCCCCCCCCCCCCCCCCCCCCCCCC" };
const REAL = { token: "sk-real-0123456789", limit: 50, cfg: { region: "eu", retries: 3 } };

/** Swap every placeholder in `body` by content type. In JSON a quoted
 *  placeholder that is the whole string takes the typed value; anywhere else
 *  it is spliced in as (escaped) text. */
function swapBody(body: string, type: string): string {
  let out = body;
  for (const [k, ph] of Object.entries(PH)) {
    const real = (REAL as any)[k];
    const text = typeof real === "string" ? real : JSON.stringify(real);
    if (/json/.test(type)) {
      out = out.split(`"${ph}"`).join(JSON.stringify(real));       // typed: the whole value
      out = out.split(ph).join(JSON.stringify(text).slice(1, -1));  // inside a longer string
    } else if (/x-www-form-urlencoded/.test(type)) {
      out = out.split(ph).join(encodeURIComponent(text));
    } else {
      out = out.split(ph).join(text);
    }
  }
  return out;
}

// upstream: echoes what arrived, with the headers that matter
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      body: body.toString(), received: body.length,
      contentLength: req.headers["content-length"] ?? null, te: req.headers["transfer-encoding"] ?? null,
    }));
  });
});

// proxy: buffer a textual body up to CAP, swap, forward with a fresh length
const proxy = http.createServer((req, res) => {
  const type = String(req.headers["content-type"] || "");
  const textual = /json|x-www-form-urlencoded|^text\//.test(type);
  const headers = { ...req.headers };
  const send = (body?: Buffer) => {
    if (body) { delete headers["transfer-encoding"]; headers["content-length"] = String(body.length); }
    delete headers["expect"]; // answered here (node sends 100 Continue itself) — not forwarded
    const up = http.request({ host: "127.0.0.1", port: (upstream.address() as any).port, method: req.method, path: req.url, headers }, (u) => {
      res.writeHead(u.statusCode || 502, u.headers); u.pipe(res);
    });
    if (body) up.end(body); else req.pipe(up);
  };
  if (!textual) return send();
  const chunks: Buffer[] = []; let n = 0; let over = false;
  req.on("data", (c: Buffer) => { n += c.length; if (n > CAP) over = true; chunks.push(c); });
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    send(over ? raw : Buffer.from(swapBody(raw.toString("utf8"), type)));
  });
});

await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
const P = `http://127.0.0.1:${(proxy.address() as any).port}`;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, got: any, ok: (b: any) => boolean) =>
  (process.env.TRACE && console.error("done:", name), results.push({ name, ok: ok(got), detail: JSON.stringify(got).slice(0, 160) }));

// 1. fetch, JSON with Content-Length, typed values
{
  const r = await (await fetch(`${P}/json`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth: `Bearer ${PH.token}`, limit: PH.limit, cfg: PH.cfg }) })).json();
  const b = JSON.parse(r.body);
  check("fetch JSON, typed number + json, token in a longer string", r, () =>
    b.limit === 50 && b.cfg.region === "eu" && b.auth === "Bearer sk-real-0123456789" && r.received === Number(r.contentLength));
}
// 2. fetch with a streamed (chunked) body
{
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"k":"${PH.token}`)); c.enqueue(new TextEncoder().encode(`"}`)); c.close(); } });
  const r = await (await fetch(`${P}/chunked`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as any)).json();
  check("fetch chunked body → re-sent with Content-Length", r, () => JSON.parse(r.body).k === REAL.token && r.te === null && r.received === Number(r.contentLength));
}
// 3. form body
{
  const r = await (await fetch(`${P}/form`, { method: "POST", body: new URLSearchParams({ client_secret: PH.token, n: PH.limit }) })).json();
  const f = new URLSearchParams(r.body);
  check("form-urlencoded", r, () => f.get("client_secret") === REAL.token && f.get("n") === "50");
}
// 4. node:http, chunked, no content-length
{
  const r = await new Promise<any>((resolve) => {
    const q = http.request(`${P}/node`, { method: "POST", headers: { "content-type": "text/plain" } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => resolve(JSON.parse(d)));
    });
    q.write(`token=${PH.token}`); q.end();
  });
  check("node:http chunked text", r, () => r.body === `token=${REAL.token}`);
}
// 5. curl with Expect: 100-continue (forced: curl 8 only sends it past 1 MiB)
{
  const big = JSON.stringify({ pad: "x".repeat(4000), t: PH.token });
  // async: the proxy runs in this process, so a blocking spawn would deadlock it
  const c = Bun.spawn(["curl", "-s", "-v", "-H", "Expect: 100-continue", "-H", "content-type: application/json", "--data-binary", big, `${P}/curl`], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text()]);
  const r = { ...JSON.parse(out || "{}"), sentExpect: /Expect: 100-continue/i.test(err) };
  check("curl, Expect: 100-continue", r, () => r.sentExpect && r.body && JSON.parse(r.body).t === REAL.token);
}
// 6. a non-textual body passes through byte for byte
{
  const bin = new Uint8Array([0, 1, 2, ...new TextEncoder().encode(PH.token)]);
  const r = await (await fetch(`${P}/bin`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bin })).json();
  check("binary body untouched", r, () => r.received === bin.length && r.body.includes(PH.token));
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.detail}`}`);
upstream.close(); proxy.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
