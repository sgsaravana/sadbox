import { describe, expect, test } from "bun:test";
import { extractLinks } from "./links";

describe("extractLinks", () => {
  test("finds plain links, newest (lowest on screen) first, without duplicates", () => {
    const screen = [
      "$ git remote -v",
      "origin  https://github.com/acme/app.git (fetch)",
      "origin  https://github.com/acme/app.git (push)",
      "Docs: https://example.com/docs.",
    ].join("\n");
    expect(extractLinks(screen, 80)).toEqual(["https://example.com/docs", "https://github.com/acme/app.git"]);
  });

  test("drops punctuation and brackets that only wrap the link", () => {
    const screen = [
      "see (https://a.example/x), then <https://b.example/y>; also 'https://c.example/z'!",
      'and "https://d.example/q?a=1&b=2".',
    ].join("\n");
    expect(extractLinks(screen, 200).sort()).toEqual([
      "https://a.example/x", "https://b.example/y", "https://c.example/z", "https://d.example/q?a=1&b=2",
    ]);
  });

  test("stitches a login URL that a full-screen program wrapped inside a bordered panel", () => {
    const url = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback" +
      "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abcDEF123-_xyz&state=QWERTY12345";
    const inner = 58;
    const rows = url.match(new RegExp(`.{1,${inner}}`, "g"))!;
    const screen = [
      "┌" + "─".repeat(inner + 2) + "┐",
      "│ " + "Open this link in your browser to sign in:".padEnd(inner) + " │",
      ...rows.map((r) => "│ " + r.padEnd(inner) + " │"),
      "│ " + "".padEnd(inner) + " │",
      "│ " + "Paste the code here:".padEnd(inner) + " │",
      "└" + "─".repeat(inner + 2) + "┘",
    ].join("\n");
    expect(extractLinks(screen, 120)[0]).toBe(url);
  });

  test("stitches a URL wrapped at the pane edge with indentation on every row", () => {
    const url = "https://auth.example.com/authorize?client_id=abc123&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb" +
      "&state=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz&scope=read+write";
    const width = 62; // two columns of indent, then 60 of text per row
    const rows = url.match(/.{1,60}/g)!;
    const screen = [
      "  Visit this address to authorize:",
      ...rows.map((r) => "  " + r),
      "",
      "  Waiting for you to finish in the browser…",
    ].join("\n");
    expect(rows.length).toBeGreaterThan(2);
    expect(extractLinks(screen, width)[0]).toBe(url);
  });

  test("when it stitches, the single-row reading is offered as well", () => {
    const screen = [
      "https://example.com/a-long-path-that-runs-right-up-to-the-edge-of-the-row",
      "continuation",
    ].join("\n");
    expect(extractLinks(screen, 73)).toEqual([
      "https://example.com/a-long-path-that-runs-right-up-to-the-edge-of-the-rowcontinuation",
      "https://example.com/a-long-path-that-runs-right-up-to-the-edge-of-the-row",
    ]);
  });

  test("is not thrown off by wider text elsewhere on screen (a long shell prompt above the panel)", () => {
    const url = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&state=h7Jk2Lm9Np4Qr6St8Uv0Wx";
    const w = 40, rows = url.match(new RegExp(`.{1,${w}}`, "g"))!;
    const screen = [
      "agent@sadbox-demo:~/workdir$ echo this is a much longer line than the panel below it, see https://example.com/docs",
      "  ┌" + "─".repeat(w + 2) + "┐",
      "  │ " + "Open this URL in your browser:".padEnd(w) + " │",
      ...rows.map((r) => "  │ " + r.padEnd(w) + " │"),
      "  │ " + "Paste the authorization code:".padEnd(w) + " │",
      "  └" + "─".repeat(w + 2) + "┘",
    ].join("\n");
    const links = extractLinks(screen, 138);
    expect(links[0]).toBe(url);
    expect(links).toContain("https://example.com/docs");
  });

  test("a short link followed by a shorter line is not stitched", () => {
    expect(extractLinks("Open https://example.com/login\nok\n", 80)).toEqual(["https://example.com/login"]);
    expect(extractLinks("  │ https://example.com/login          │\n  │ ok                                 │", 80))
      .toEqual(["https://example.com/login"]);
  });

  test("does not glue the next line onto a link that ends before the edge", () => {
    const screen = [
      "Open https://example.com/login",
      "Then come back here and press Enter to continue with the rest of setup.",
    ].join("\n");
    expect(extractLinks(screen, 80)).toEqual(["https://example.com/login"]);
  });

  test("does not run two links on consecutive full rows together", () => {
    const a = "https://example.com/" + "a".repeat(40), b = "https://example.org/" + "b".repeat(40);
    expect(extractLinks(`${a}\n${b}`, 60).sort()).toEqual([a, b].sort());
  });

  test("ignores things that are not http(s) links, and bare schemes", () => {
    expect(extractLinks("ftp://x.example/file  file:///etc/passwd  javascript:alert(1)  https://  http://", 80)).toEqual([]);
  });

  test("an empty screen has no links", () => {
    expect(extractLinks("", 80)).toEqual([]);
    expect(extractLinks("\n\n   \n", 80)).toEqual([]);
  });
});
