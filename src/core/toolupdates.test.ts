import { afterAll, describe, expect, test } from "bun:test";
import { latestToolVersions } from "./toolupdates";

const realFetch = globalThis.fetch;

afterAll(() => { globalThis.fetch = realFetch; });

describe("latest tool releases", () => {
  test("one broken registry does not hide the other answers", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("claude-code-releases")) return new Response("2.1.999\n");
      if (url.includes("pi-coding-agent")) return new Response(JSON.stringify({ version: "18.0.0" }));
      if (url.includes("opencode-ai")) return new Response("nope", { status: 500 });
      if (url.includes("/bun/")) return new Response(JSON.stringify({ version: "1.4.4" }));
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;

    const by = Object.fromEntries((await latestToolVersions(true)).map((t) => [t.key, t]));
    expect(by.claude.latest).toBe("2.1.999");
    expect(by.omp.latest).toBe("18.0.0");
    expect(by.opencode.latest).toBeNull();
    expect(by.opencode.error).toContain("500");
    expect(by.bun.latest).toBe("1.4.4");
  });
});
