// The login capture / copy-in, with the guest scripts run for real (by bun,
// against scratch home folders standing in for each VM's /home/agent).
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { claudeLogin, claudePlaceholders, saveClaudeLogin } from "../net/claudeoauth";
import { applyLogins, captureLogins, forgetLogin, listLogins, loginTick } from "./logins";

const A = { id: makeProject("lg-a"), name: "proj-lg-a" };
const B = { id: makeProject("lg-b"), name: "proj-lg-b" };
const homes: Record<string, string> = {};
const homeOf = (p: { name: string }) => homes[`sadbox-${p.name}`];
const put = (home: string, path: string, text: string) => { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), text); };
const json = (home: string, path: string) => JSON.parse(readFileSync(join(home, path), "utf8"));

// omp's credential store, as far as sadbox uses it — the real one writes the same table
const FAKE_OMP = `import { Database } from "bun:sqlite";
export class SqliteAuthCredentialStore {
  static async open() { const s = new SqliteAuthCredentialStore(); s.d = new Database(process.env.HOME + "/.omp/agent/agent.db"); return s; }
  getOAuth(p) { return this.d.query("SELECT 1 FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth'").get(p); }
  getApiKey(p) { const r = this.d.query("SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key'").get(p); return r ? JSON.parse(r.data).key : null; }
  async replaceAuthCredentials(p, creds) {
    this.d.query("DELETE FROM auth_credentials WHERE provider = ?").run(p);
    for (const c of creds) this.d.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'api_key', ?)").run(p, JSON.stringify({ key: c.key, ...(c.source ? { source: c.source } : {}) }));
  }
  close() { this.d.close(); }
}
`;
function ompDb(home: string, rows: [string, string, unknown][]) {
  mkdirSync(join(home, ".omp/agent"), { recursive: true });
  const d = new Database(join(home, ".omp/agent/agent.db"));
  d.run("CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)");
  for (const [p, t, data] of rows) d.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run(p, t, JSON.stringify(data));
  d.close();
  put(home, ".bun/install/global/node_modules/@oh-my-pi/pi-ai/src/auth/sqlite-credential-store.ts", FAKE_OMP);
}
const ompKeys = (home: string) => {
  const d = new Database(join(home, ".omp/agent/agent.db"), { readonly: true });
  const r = d.query<{ provider: string; credential_type: string; data: string }, []>("SELECT provider, credential_type, data FROM auth_credentials ORDER BY provider").all();
  d.close();
  return r.map((x) => [x.provider, x.credential_type, JSON.parse(x.data).key ?? "(oauth)"]);
};

const driver = getDriver();
const scripts: string[] = [];
const exec = spyOn(driver, "execWithStdin").mockImplementation(async (ref, shellCmd, stdin) => {
  expect(shellCmd).toBe("exec /home/agent/.bun/bin/bun run -"); // nothing secret on the command line
  const script = new TextDecoder().decode(stdin as Uint8Array);
  scripts.push(script);
  const r = Bun.spawnSync([process.execPath, "run", "-"], { stdin: new TextEncoder().encode(script), env: { ...process.env, HOME: homes[ref] }, stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
});
afterAll(() => { exec.mockRestore(); for (const h of Object.values(homes)) rmSync(h, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ["agent_logins", "login_placeholders", "login_seen"]) db.run(`DELETE FROM ${t}`);
  for (const p of [A, B]) {
    const ref = `sadbox-${p.name}`;
    if (homes[ref]) rmSync(homes[ref], { recursive: true, force: true });
    homes[ref] = mkdtempSync(join(tmpdir(), "sadbox-vmhome-"));
  }
  scripts.length = 0;
});

describe("API-key logins", () => {
  test("a login in one VM is kept, and copied into another — OAuth ones are not", async () => {
    put(homeOf(A), ".local/share/opencode/auth.json", JSON.stringify({ minimax: { type: "api", key: "mm-key-1" }, github: { type: "oauth", refresh: "r", access: "a", expires: 1 } }));
    ompDb(homeOf(A), [["deepseek", "api_key", { key: "ds-key-1" }], ["anthropic", "oauth", { access: "x", refresh: "y" }]]);
    const r = await captureLogins(A);
    expect(r.captured.sort()).toEqual(["omp:deepseek", "opencode:minimax"]);
    expect(listLogins().map((l) => [l.tool, l.provider, l.shared, l.fromProject])).toEqual([
      ["omp", "deepseek", "copied", A.name], ["opencode", "minimax", "copied", A.name],
    ]);
    expect((await captureLogins(A)).captured).toEqual([]); // nothing new

    ompDb(homeOf(B), []);
    expect((await applyLogins(B)).sort()).toEqual(["omp (deepseek)", "opencode (minimax)"]);
    expect(json(homeOf(B), ".local/share/opencode/auth.json")).toEqual({ minimax: { type: "api", key: "mm-key-1" } });
    expect(statSync(join(homeOf(B), ".local/share/opencode/auth.json")).mode & 0o777).toBe(0o600);
    expect(ompKeys(homeOf(B))).toEqual([["deepseek", "api_key", "ds-key-1"]]);
    expect(await applyLogins(B)).toEqual([]); // already current
    // the secrets went in through the script's stdin, in it only as base64
    expect(scripts.at(-1)).not.toContain("ds-key-1");
  });

  test("the newest login wins; a VM still holding the old one does not bring it back", async () => {
    put(homeOf(A), ".local/share/opencode/auth.json", JSON.stringify({ minimax: { type: "api", key: "old" } }));
    put(homeOf(B), ".local/share/opencode/auth.json", JSON.stringify({ minimax: { type: "api", key: "old" } }));
    await captureLogins(A); await captureLogins(B);
    // logging in anew in B
    put(homeOf(B), ".local/share/opencode/auth.json", JSON.stringify({ minimax: { type: "api", key: "new" } }));
    expect((await captureLogins(B)).captured).toEqual(["opencode:minimax"]);
    expect((await captureLogins(A)).captured).toEqual([]); // A's is as sadbox saw it: not a new login
    await applyLogins(A);
    expect(json(homeOf(A), ".local/share/opencode/auth.json").minimax.key).toBe("new");
  });

  test("an OAuth login the VM has for a provider is left alone", async () => {
    put(homeOf(A), ".local/share/opencode/auth.json", JSON.stringify({ minimax: { type: "api", key: "k" } }));
    await captureLogins(A);
    put(homeOf(B), ".local/share/opencode/auth.json", JSON.stringify({ minimax: { type: "oauth", access: "own" } }));
    expect(await applyLogins(B)).toEqual([]);
    expect(json(homeOf(B), ".local/share/opencode/auth.json").minimax.access).toBe("own");
  });

  test("forget", async () => {
    put(homeOf(A), ".local/share/opencode/auth.json", JSON.stringify({ minimax: { type: "api", key: "k" } }));
    await captureLogins(A);
    expect(forgetLogin("opencode", "minimax")).toBe(true);
    expect(listLogins()).toEqual([]);
    expect(forgetLogin("opencode", "minimax")).toBe(false);
  });
});

describe("Claude's login", () => {
  const REAL = { accessToken: "sk-ant-oat01-" + "Q".repeat(90), refreshToken: "sk-ant-ort01-" + "W".repeat(90), expiresAt: Date.now() + 36e5, scopes: ["user:inference"], subscriptionType: "max" };

  test("a real login found in a VM is taken over, and replaced there by placeholders", async () => {
    put(homeOf(A), ".claude/.credentials.json", JSON.stringify({ claudeAiOauth: REAL, mcpOAuth: { keep: "me" } }));
    await loginTick(); // what the supervisor's loop does
    expect(claudeLogin()).toMatchObject({ accessToken: REAL.accessToken, refreshToken: REAL.refreshToken, subscriptionType: "max" });
    const ph = claudePlaceholders(A.id)!;
    const file = json(homeOf(A), ".claude/.credentials.json");
    expect(file.claudeAiOauth).toMatchObject({ accessToken: ph.access, refreshToken: ph.refresh, subscriptionType: "max" });
    expect(file.mcpOAuth).toEqual({ keep: "me" }); // the rest of the file stays
    expect(JSON.stringify(file)).not.toContain("QQQQ");
    expect(statSync(join(homeOf(A), ".claude/.credentials.json")).mode & 0o777).toBe(0o600);
    // next look: as sadbox left it
    expect(await captureLogins(A)).toEqual({ captured: [], replaceClaude: false });
  });

  test("a new VM gets its own placeholders", async () => {
    saveClaudeLogin(REAL, "elsewhere");
    expect(await applyLogins(B)).toEqual(["Claude login"]);
    const o = json(homeOf(B), ".claude/.credentials.json").claudeAiOauth;
    expect(o.accessToken).toBe(claudePlaceholders(B.id)!.access);
    expect(o.expiresAt).toBeGreaterThan(Date.now() + 5 * 365 * 864e5);
  });

  test("with a working login kept, a VM's own other login is replaced, not taken", async () => {
    saveClaudeLogin(REAL, "elsewhere");
    put(homeOf(A), ".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { ...REAL, accessToken: "sk-ant-oat01-" + "Z".repeat(90) } }));
    expect(await captureLogins(A)).toEqual({ captured: [], replaceClaude: true });
    expect(claudeLogin()!.accessToken).toBe(REAL.accessToken);
  });

  test("placeholders left from an earlier setup are not mistaken for a login", async () => {
    put(homeOf(A), ".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { ...REAL, accessToken: "sk-ant-oat01-sbx" + "x".repeat(80), refreshToken: "sk-ant-ort01-sbx" + "y".repeat(80) } }));
    expect(await captureLogins(A)).toEqual({ captured: [], replaceClaude: false });
    expect(claudeLogin()).toBeNull();
  });

  test("a login file Claude emptied (after a refused refresh) gets placeholders again — once sadbox's login works", async () => {
    put(homeOf(A), ".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }));
    expect((await captureLogins(A)).replaceClaude).toBe(false); // no login kept
    saveClaudeLogin(REAL, "x");
    db.run("UPDATE agent_logins SET status = 'refresh refused (invalid_grant) — log in again'");
    expect((await captureLogins(A)).replaceClaude).toBe(false); // the kept one is dead too
    db.run("UPDATE agent_logins SET status = NULL");
    expect((await captureLogins(A)).replaceClaude).toBe(true);
  });

  test("what the VM's Claude learnt about the account is kept for new VMs", async () => {
    saveClaudeLogin({ ...REAL, subscriptionType: null }, "x");
    await applyLogins(A);
    const f = json(homeOf(A), ".claude/.credentials.json");
    f.claudeAiOauth.subscriptionType = "max"; f.claudeAiOauth.rateLimitTier = "tier-x";
    put(homeOf(A), ".claude/.credentials.json", JSON.stringify(f));
    await captureLogins(A);
    expect(claudeLogin()).toMatchObject({ subscriptionType: "max", rateLimitTier: "tier-x" });
  });
});

test("a VM with nothing logged in", async () => {
  expect(await captureLogins(A)).toEqual({ captured: [], replaceClaude: false });
  expect(await applyLogins(A)).toEqual([]);
  expect(existsSync(join(homeOf(A), ".claude"))).toBe(false);
});
