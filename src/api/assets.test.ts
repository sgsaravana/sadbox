import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../config";
import { startServer } from "./http";

// The UI is often served on a subdomain behind a reverse proxy. It must carry
// its own icon: without one a browser falls back to the primary domain's.
let server: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  config.port = 0;
  server = startServer();
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

describe("the UI's own assets", () => {
  test("serves the favicon in every shape a browser asks for", async () => {
    for (const [path, type] of [
      ["/favicon.svg", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/favicon-32.png", "image/png"],
      ["/apple-touch-icon.png", "image/png"],
    ]) {
      const r = await fetch(base + path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe(type);
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
  });

  test("links it from the pages", async () => {
    const html = await (await fetch(`${base}/login`)).text();
    expect(html).toContain('rel="icon"');
    expect(html).toContain("/favicon.svg");
  });
});
