import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { config } from "../config";
import { getDriver } from "../driver";
import { copyOutHistory, historyOf, historyRoot, linkHistory, listHistory, prepareHistory } from "./history";

// A scratch folder stands in for the VM user's home; the guest snippets are run
// here against it, as the VM would run them against /home/agent.
const home = mkdtempSync(join(tmpdir(), "sadbox-home-"));
const inHome = (script: string) => script.replaceAll(config.guestHome, home);
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const commands: { cmd: string[]; user?: string }[] = [];
const driver = getDriver();
const exec = spyOn(driver, "exec").mockImplementation(async (_ref, cmd, opts) => {
  commands.push({ cmd, user: opts?.user });
  if (cmd[0] !== "sh" || opts?.user === "root") return { exitCode: 0, stdout: "", stderr: "" }; // tmux, chown
  const r = Bun.spawnSync(["sh", "-c", inHome(cmd[2])], { stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: "", stderr: r.stderr.toString() };
});
const capture = spyOn(driver, "execCaptureBytes").mockImplementation(async (_ref, script) => {
  const r = Bun.spawnSync(["sh", "-c", inHome(script)]);
  return { exitCode: r.exitCode, stdout: new Uint8Array(r.stdout) };
});
afterAll(() => { exec.mockRestore(); capture.mockRestore(); rmSync(home, { recursive: true, force: true }); });

beforeEach(() => {
  rmSync(historyRoot(), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home);
  commands.length = 0;
});

describe("the store", () => {
  test("is made on first use, and says what to mount where", () => {
    const mounts = prepareHistory("my-app");
    const root = join(historyRoot(), "my-app");
    expect(mounts).toEqual([
      { host: `${root}/claude/projects`, guest: "/home/agent/.claude/projects" },
      { host: `${root}/claude/file-history`, guest: "/home/agent/.claude/file-history" },
      { host: `${root}/claude/history.jsonl`, guest: "/home/agent/.claude/history.jsonl" },
      { host: `${root}/omp/sessions`, guest: "/home/agent/.omp/agent/sessions" },
      { host: `${root}/omp/db`, guest: "/home/agent/.sadbox/history/omp" },
      { host: `${root}/opencode/db`, guest: "/home/agent/.sadbox/history/opencode" },
      { host: `${root}/opencode/snapshot`, guest: "/home/agent/.local/share/opencode/snapshot" },
    ]);
    for (const m of mounts) expect(existsSync(m.host)).toBe(true);
    expect(lstatSync(`${root}/claude/history.jsonl`).isFile()).toBe(true); // a file mount needs the file
    // again: nothing changes, nothing is lost
    put(root, "claude/history.jsonl", "kept\n");
    expect(prepareHistory("my-app")).toEqual(mounts);
    expect(readFileSync(`${root}/claude/history.jsonl`, "utf8")).toBe("kept\n");
  });

  test("an empty store is no history", () => {
    prepareHistory("my-app");
    expect(historyOf("my-app")).toBeNull();
    expect(listHistory()).toEqual([]);
    expect(historyOf("never-made")).toBeNull();
  });

  test("sizes per tool, not following links", () => {
    const root = join(historyRoot(), "my-app");
    prepareHistory("my-app");
    put(root, "claude/projects/-home-agent-workdir/s1.jsonl", "x".repeat(100));
    put(root, "omp/db/history.db", "y".repeat(50));
    symlinkSync("/etc", `${root}/claude/projects/elsewhere`);
    expect(listHistory()).toEqual([{
      name: "my-app", bytes: 150, updatedAt: expect.any(String),
      tools: [{ tool: "claude", bytes: 100 }, { tool: "omp", bytes: 50 }],
    }]);
  });

  test("a link where a mount source should be is refused — it would mount that part of this machine", () => {
    const root = join(historyRoot(), "my-app");
    prepareHistory("my-app");
    rmSync(`${root}/claude/projects`, { recursive: true });
    symlinkSync(tmpdir(), `${root}/claude/projects`);
    expect(() => prepareHistory("my-app")).toThrow(/not a plain folder/);
    rmSync(`${root}/claude/projects`);
    rmSync(`${root}/claude/history.jsonl`);
    symlinkSync("/etc/hosts", `${root}/claude/history.jsonl`);
    expect(() => prepareHistory("my-app")).toThrow(/not a plain file/);
    rmSync(join(historyRoot(), "my-app"), { recursive: true });
    symlinkSync(tmpdir(), join(historyRoot(), "my-app"));
    expect(() => prepareHistory("my-app")).toThrow(/not a plain folder/);
  });

  test("only project names", () => {
    expect(() => prepareHistory("../x")).toThrow(/not a project name/);
    expect(() => prepareHistory("")).toThrow(/not a project name/);
  });
});

describe("in the VM", () => {
  test("the mount points' folders go to the VM user, the SQLite files are linked into their mounted folder", async () => {
    await linkHistory("sadbox-my-app");
    const chown = commands.find((c) => c.user === "root")!.cmd[2];
    for (const d of [".claude", ".omp", ".omp/agent", ".local", ".local/share", ".local/share/opencode", ".sadbox", ".sadbox/history"]) {
      expect(chown).toContain(`'/home/agent/${d}'`);
    }
    expect(chown).not.toContain("'/home/agent'"); // the home itself is left alone
    expect(readlinkSync(`${home}/.omp/agent/history.db`)).toBe(`${home}/.sadbox/history/omp/history.db`);
    expect(readlinkSync(`${home}/.local/share/opencode/opencode.db`)).toBe(`${home}/.sadbox/history/opencode/opencode.db`);
    await linkHistory("sadbox-my-app"); // again (a rebuild over the same disk): fine
  });
});

describe("copying out an older VM's history", () => {
  test("transcripts, prompt history and databases land in the store; links are left behind", async () => {
    const root = join(historyRoot(), "my-app");
    put(home, ".claude/projects/-home-agent-workdir/s1.jsonl", "session\n");
    put(home, ".claude/file-history/s1/a@v1", "old a\n");
    put(home, ".claude/history.jsonl", '{"display":"from the VM"}\n');
    put(home, ".claude/.credentials.json", "the login"); // not history
    put(home, ".omp/agent/history.db", "db");
    put(home, ".omp/agent/history.db-wal", "wal");
    put(home, ".omp/agent/agent.db", "the omp login");
    put(home, ".local/share/opencode/opencode.db", "oc");
    symlinkSync("/etc", `${home}/.claude/projects/evil`);
    symlinkSync("/etc/hosts", `${home}/.claude/projects/-home-agent-workdir/hosts.jsonl`);
    // what an earlier project of this name left
    prepareHistory("my-app");
    put(root, "claude/history.jsonl", '{"display":"earlier"}\n');
    put(root, "omp/db/history.db-shm", "stale shm of another database");
    put(root, "claude/projects/-home-agent-workdir/s0.jsonl", "earlier session\n");

    expect(await copyOutHistory("my-app", "sadbox-my-app")).toBe(6);
    expect(commands[0].cmd).toEqual(["tmux", "kill-server"]); // agents stopped first
    expect(readFileSync(`${root}/claude/projects/-home-agent-workdir/s1.jsonl`, "utf8")).toBe("session\n");
    expect(readFileSync(`${root}/claude/projects/-home-agent-workdir/s0.jsonl`, "utf8")).toBe("earlier session\n");
    expect(readFileSync(`${root}/claude/file-history/s1/a@v1`, "utf8")).toBe("old a\n");
    expect(readFileSync(`${root}/claude/history.jsonl`, "utf8")).toBe('{"display":"earlier"}\n{"display":"from the VM"}\n');
    expect(readFileSync(`${root}/omp/db/history.db`, "utf8")).toBe("db");
    expect(readFileSync(`${root}/omp/db/history.db-wal`, "utf8")).toBe("wal");
    expect(existsSync(`${root}/omp/db/history.db-shm`)).toBe(false);
    expect(readFileSync(`${root}/opencode/db/opencode.db`, "utf8")).toBe("oc");
    expect(existsSync(`${root}/claude/projects/evil`)).toBe(false);
    expect(existsSync(`${root}/claude/projects/-home-agent-workdir/hosts.jsonl`)).toBe(false);
    expect(JSON.stringify(listHistory())).not.toContain("credentials");
    expect(existsSync(`${root}/claude/.credentials.json`)).toBe(false);
    expect(existsSync(`${root}/omp/agent.db`)).toBe(false);
    expect(() => prepareHistory("my-app")).not.toThrow();
  });

  test("a VM with no history copies nothing", async () => {
    expect(await copyOutHistory("my-app", "sadbox-my-app")).toBe(0);
    expect(historyOf("my-app")).toBeNull();
  });

  test("a whole tool folder that is a link is not followed", async () => {
    mkdirSync(`${home}/.claude`, { recursive: true });
    symlinkSync(tmpdir(), `${home}/.claude/projects`);
    expect(await copyOutHistory("my-app", "sadbox-my-app")).toBe(0);
  });
});
