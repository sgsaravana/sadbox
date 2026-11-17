// Destroy reports its steps in the same event log the create/rebuild progress
// view reads, and a repeated request after it finished is harmless.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db";
import { getDriver } from "../driver";
import { makeProject } from "../../test/helpers";
import { destroyProject, getProject } from "./projects";

const driver = getDriver();
const destroy = spyOn(driver, "destroy").mockImplementation(async () => {});
const id = makeProject("destroy-ev");
db.query("UPDATE projects SET history_mounted = 1 WHERE id = ?").run(id);

afterAll(() => {
  destroy.mockRestore();
  db.query("DELETE FROM events WHERE project_id = ?").run(id);
  db.query("DELETE FROM projects WHERE id = ?").run(id);
});

describe("destroy progress", () => {
  test("logs its steps, finishes, and ignores a repeat", async () => {
    await destroyProject(id);
    const types = db.query<{ type: string }, [string]>(
      "SELECT type FROM events WHERE project_id = ? ORDER BY id").all(id).map((r) => r.type);
    expect(types).toContain("destroy.start");
    expect(types).toContain("destroy.vm");
    expect(types).toContain("destroy.cleanup");
    expect(types).toContain("destroy");
    expect(getProject(id)!.state).toBe("destroyed");

    await destroyProject(id); // already destroyed: no second cleanup or error
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
