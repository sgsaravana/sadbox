// A create that fails leaves its row in `error`. Retrying it under the same
// name must reuse that row — not trip the unique index — while a name held by a
// live (or previously created) project must say so in words.
import { afterAll, describe, expect, test } from "bun:test";
import { db, logEvent } from "../db";
import { makeProject } from "../../test/helpers";
import { createProject, getProject } from "./projects";

const ids: string[] = [];
const row = (name: string, state: string) => {
  const id = makeProject(name, state);
  db.query("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
  ids.push(id);
  return id;
};

afterAll(() => {
  for (const id of ids) {
    db.query("DELETE FROM events WHERE project_id = ?").run(id);
    db.query("DELETE FROM projects WHERE id = ?").run(id);
  }
});

describe("creating a project whose name is taken", () => {
  test("a live project is refused in words, not by the unique index", async () => {
    row("clash-live", "running");
    const err = await createProject({ name: "clash-live", empty: true }).catch((e) => String(e));
    expect(err).toMatch(/already exists/);
    expect(err).not.toMatch(/UNIQUE constraint/);
  });

  test("a create that never finished is retried on its own row", async () => {
    const id = row("clash-retry", "error");
    logEvent(id, "create.start", "the first attempt");
    logEvent(id, "create.error", "the first attempt failed");
    // The stub container has no `run`, so provisioning fails at driver.create.
    // That is past the row update, which is what this test is about.
    const err = await createProject({ name: "clash-retry", empty: true }).catch((e) => String(e));
    expect(err).not.toMatch(/UNIQUE constraint|already exists/);
    expect(getProject(id)).toMatchObject({ id, state: "error" });
    // it got past the row update and failed later, in the stubbed VM create
    expect(getProject(id)!.error).toMatch(/volume create failed|container run failed/);
  });

  test("a project that was created once keeps its row when its name is reused", async () => {
    const id = row("clash-built", "error");
    logEvent(id, "create.done"); // it worked once, then a rebuild failed
    logEvent(id, "rebuild.start");
    logEvent(id, "rebuild.error");
    const err = await createProject({ name: "clash-built", empty: true }).catch((e) => String(e));
    expect(err).toMatch(/Rebuild/);
    expect(getProject(id)!.state).toBe("error");
  });

  test("an error row with no create history is not taken for an unfinished create", async () => {
    const id = row("clash-legacy", "error");
    const err = await createProject({ name: "clash-legacy", empty: true }).catch((e) => String(e));
    expect(err).toMatch(/Rebuild/);
    expect(err).not.toMatch(/UNIQUE constraint/);
    expect(getProject(id)!.state).toBe("error");
  });
});
