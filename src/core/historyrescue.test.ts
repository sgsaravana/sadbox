// An older VM (created before agent history was mounted) has its history on
// its own disk: Rebuild and Destroy copy it out first (research/13, A3).
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { historyRoot } from "./history";
import { destroyProject, rebuildProject } from "./projects";

const driver = getDriver();
const home = mkdtempSync(join(tmpdir(), "sadbox-oldvm-"));
mkdirSync(join(home, ".claude/projects/-home-agent-workdir"), { recursive: true });
writeFileSync(join(home, ".claude/projects/-home-agent-workdir/s1.jsonl"), "old session\n");
const tarOfHome = new Uint8Array(Bun.spawnSync(["tar", "-cf", "-", "-C", home, ".claude/projects"]).stdout);

let captureFails = false;
const capture = spyOn(driver, "execCaptureBytes").mockImplementation(async () =>
  captureFails ? { exitCode: 2, stdout: new Uint8Array() } : { exitCode: 0, stdout: tarOfHome });
const destroy = spyOn(driver, "destroy");
afterAll(() => { capture.mockRestore(); destroy.mockRestore(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  rmSync(historyRoot(), { recursive: true, force: true });
  capture.mockClear(); destroy.mockClear(); captureFails = false;
});

const events = (id: string) => db.query<{ type: string; detail: string }, [string]>(
  "SELECT type, detail FROM events WHERE project_id = ? AND type LIKE 'history%' ORDER BY rowid").all(id);
const session = (name: string) => join(historyRoot(), name, "claude/projects/-home-agent-workdir/s1.jsonl");

describe("an older VM's history is copied out before it goes", () => {
  test("on Destroy", async () => {
    const id = makeProject("hr-old");
    await destroyProject(id);
    expect(readFileSync(session("proj-hr-old"), "utf8")).toBe("old session\n");
    expect(events(id).at(-1)).toEqual({ type: "history.copyout", detail: "1 file(s) of agent history copied out of the VM, kept for proj-hr-old" });
  });

  test("not for a VM that has it mounted already", async () => {
    const id = makeProject("hr-new");
    db.query("UPDATE projects SET history_mounted = 1 WHERE id = ?").run(id);
    await destroyProject(id);
    expect(capture).not.toHaveBeenCalled();
  });

  test("a Destroy goes ahead even when the copy fails", async () => {
    captureFails = true;
    const id = makeProject("hr-fail");
    await destroyProject(id);
    expect(destroy).toHaveBeenCalled();
    expect(events(id).at(-1)?.type).toBe("history.copyout.error");
  });

  test("a Rebuild does not: the VM and its history are left as they were", async () => {
    captureFails = true;
    const id = makeProject("hr-rebuild");
    const src = mkdtempSync(join(tmpdir(), "sadbox-src-"));
    db.query("UPDATE projects SET source_path = ? WHERE id = ?").run(src, id);
    await expect(rebuildProject(id)).rejects.toThrow(/could not copy the agent history out of the VM first/);
    expect(destroy).not.toHaveBeenCalled();
    expect(db.query<{ state: string }, [string]>("SELECT state FROM projects WHERE id = ?").get(id)!.state).toBe("running");
  });
});
