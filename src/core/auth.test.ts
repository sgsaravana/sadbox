import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { config } from "../config";
import { db } from "../db";
import {
  AuthError, COOKIE, clearCookie, crossOrigin, ensurePassword, initialPasswordFile, login, logout,
  resetThrottle, safeNext, sessionCookie, sessionValid, setPassword, signedIn, tokenFrom,
} from "./auth";

const authFile = join(config.dataDir, "auth.json");
const req = (headers: Record<string, string> = {}, url = "http://localhost:7070/api/projects") =>
  new Request(url, { headers });

beforeEach(() => {
  rmSync(authFile, { force: true });
  rmSync(initialPasswordFile(), { force: true });
  db.run("DELETE FROM sessions");
  resetThrottle();
});

async function fails(p: Promise<unknown>): Promise<AuthError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AuthError); return e as AuthError; }
  throw new Error("expected the login to fail");
}

describe("first start", () => {
  test("generates a password, leaves it in a 0600 file, and it signs in", async () => {
    const pw = await ensurePassword();
    expect(pw!.length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(initialPasswordFile(), "utf8").trim()).toBe(pw!);
    expect(statSync(initialPasswordFile()).mode & 0o777).toBe(0o600);
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(authFile, "utf8")).not.toContain(pw!); // only a hash is stored
    expect(sessionValid(await login(pw))).toBe(true);
  });

  test("does nothing once a password exists", async () => {
    const first = await ensurePassword();
    expect(await ensurePassword()).toBeNull();
    expect(sessionValid(await login(first))).toBe(true);
  });

  test("with no password at all, nothing signs in", async () => {
    expect((await fails(login("anything"))).status).toBe(401);
    expect((await fails(login(""))).status).toBe(401);
  });
});

describe("setPassword", () => {
  test("replaces the password, removes the initial-password file, and signs everyone out", async () => {
    const initial = await ensurePassword();
    const old = await login(initial);
    await setPassword("correct horse battery");
    expect(existsSync(initialPasswordFile())).toBe(false);
    expect(sessionValid(old)).toBe(false);
    await fails(login(initial));
    expect(sessionValid(await login("correct horse battery"))).toBe(true);
  });

  test("refuses a short password", async () => {
    await expect(setPassword("short")).rejects.toThrow(/at least 8/);
  });
});

describe("login and sessions", () => {
  beforeEach(async () => { await setPassword("correct horse battery"); });

  test("a wrong, empty or non-string password is refused", async () => {
    for (const bad of ["nope", "", "correct horse batter", "correct horse battery ", undefined, null, 42, { $ne: "" }]) {
      expect((await fails(login(bad))).status).toBe(401);
      resetThrottle();
    }
  });

  test("each login gets its own token; only a hash is stored", async () => {
    const [a, b] = [await login("correct horse battery"), await login("correct horse battery")];
    expect(a).not.toBe(b);
    const stored = db.query<{ token_hash: string }, []>("SELECT token_hash FROM sessions").all().map((r) => r.token_hash);
    expect(stored).toHaveLength(2);
    expect(stored).not.toContain(a);
    expect(sessionValid(a) && sessionValid(b)).toBe(true);
  });

  test("unknown, empty and expired tokens are not sessions", async () => {
    const t = await login("correct horse battery");
    expect(sessionValid("made-up")).toBe(false);
    expect(sessionValid("")).toBe(false);
    expect(sessionValid(null)).toBe(false);
    db.run("UPDATE sessions SET expires_at = ?", [Date.now() - 1]);
    expect(sessionValid(t)).toBe(false);
  });

  test("logout ends that session only", async () => {
    const [a, b] = [await login("correct horse battery"), await login("correct horse battery")];
    logout(a);
    expect(sessionValid(a)).toBe(false);
    expect(sessionValid(b)).toBe(true);
  });

  test("repeated failures lock sign-in, even for the right password", async () => {
    for (let i = 0; i < 5; i++) await fails(login("wrong"));
    const e = await fails(login("correct horse battery"));
    expect(e.status).toBe(429);
    expect(e.message).toMatch(/try again in \d+s/);
    resetThrottle();
    expect(sessionValid(await login("correct horse battery"))).toBe(true);
  });

  test("a success clears the failure count", async () => {
    for (let i = 0; i < 4; i++) await fails(login("wrong"));
    await login("correct horse battery");
    for (let i = 0; i < 4; i++) expect((await fails(login("wrong"))).status).toBe(401);
  });
});

describe("request helpers", () => {
  test("tokenFrom picks the session cookie out of the header", () => {
    expect(tokenFrom(req({ cookie: `a=1; ${COOKIE}=tok123; b=2` }))).toBe("tok123");
    expect(tokenFrom(req({ cookie: `x${COOKIE}=nope` }))).toBeNull();
    expect(tokenFrom(req())).toBeNull();
  });

  test("signedIn needs a live session cookie", async () => {
    await setPassword("correct horse battery");
    const t = await login("correct horse battery");
    expect(signedIn(req({ cookie: `${COOKIE}=${t}` }))).toBe(true);
    expect(signedIn(req({ cookie: `${COOKIE}=forged` }))).toBe(false);
    expect(signedIn(req())).toBe(false);
  });

  test("the cookie is HttpOnly + SameSite=Strict, and Secure only over https", () => {
    const plain = sessionCookie(req(), "t");
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Strict");
    expect(plain).not.toContain("Secure");
    expect(sessionCookie(req({ "x-forwarded-proto": "https" }), "t")).toContain("Secure");
    expect(sessionCookie(req({}, "https://sadbox.example.com/"), "t")).toContain("Secure");
    expect(clearCookie()).toContain("Max-Age=0");
  });

  test("crossOrigin flags a browser request from another site", () => {
    const host = "localhost:7070";
    expect(crossOrigin(req({ host }))).toBe(false);                                   // curl / same-origin GET
    expect(crossOrigin(req({ host, origin: "http://localhost:7070" }))).toBe(false);
    expect(crossOrigin(req({ host, origin: "http://evil.example" }))).toBe(true);
    expect(crossOrigin(req({ host, origin: "http://localhost:9999" }))).toBe(true);   // another local app
    expect(crossOrigin(req({ host, origin: "null" }))).toBe(true);                    // sandboxed iframe / file://
    // behind a reverse proxy the public host arrives as X-Forwarded-Host
    expect(crossOrigin(req({ host: "127.0.0.1:7070", "x-forwarded-host": "sadbox.example.com", origin: "https://sadbox.example.com" }))).toBe(false);
  });

  test("safeNext only ever returns a local path", () => {
    expect(safeNext("/editor?id=1&name=x")).toBe("/editor?id=1&name=x");
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});
