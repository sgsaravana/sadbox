import { afterAll, describe, expect, test } from "bun:test";
import { db, logEvent } from "../db";
import { logLine, logOutput, projectEvents, redactLog } from "./projects";

// The create form reads this log for real progress; multiple projects share the
// events table, so a unique id keeps these rows out of anyone else's way.
const id = `ev-test-${process.pid}`;

afterAll(() => db.query("DELETE FROM events WHERE project_id = ?").run(id));

describe("a project's event log", () => {
  test("only that project's events, oldest first, and only after an id", () => {
    logEvent(id, "create.start", "x");
    logEvent(null, "login.refresh", "not this project");
    logEvent("another-project", "create.start", "not this project either");
    logEvent(id, "vm.ready", "y");

    const all = projectEvents(id);
    expect(all.map((e) => [e.type, e.detail])).toEqual([
      ["create.start", "x"],
      ["vm.ready", "y"],
    ]);
    expect(all[0]!.id).toBeLessThan(all[1]!.id);
    expect(all[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    expect(projectEvents(id, all[0]!.id).map((e) => e.type)).toEqual(["vm.ready"]);
    expect(projectEvents(id, all[1]!.id)).toEqual([]);
  });

  test("is bounded, so a chatty create cannot flood the reply", () => {
    for (let i = 0; i < 5; i++) logEvent(id, "step", String(i));
    const page = projectEvents(id, 0, 3);
    expect(page.map((e) => e.detail)).toEqual(["x", "y", "0"]);
  });

  test("an empty or unknown project is an empty log", () => {
    expect(projectEvents("no-such-project")).toEqual([]);
  });
});

describe("raw create logs", () => {
  const logId = `${id}-raw`;
  afterAll(() => db.query("DELETE FROM events WHERE project_id = ?").run(logId));

  test("credentials never reach the event log", () => {
    expect(redactLog("https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/o/r"))
      .toBe("https://***@github.com/o/r");
    expect(redactLog("fatal: token ghp_abcdefghijklmnopqrstuvwxyz rejected")).toBe("fatal: token *** rejected");
  });

  test("log lines keep their source and are one event each", () => {
    logLine(logId, "clone", "first");
    logOutput(logId, "clone.error", "second\nthird");
    logLine(logId, "clone", "");
    const events = projectEvents(logId);
    expect(events.map((e) => [e.type, e.detail])).toEqual([
      ["log.clone", "first"],
      ["log.clone.error", "second"],
      ["log.clone.error", "third"],
    ]);
  });
});
