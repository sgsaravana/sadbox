// The detail view's "not responding" flag means the guest did not answer at
// all. A probe command that ran and exited nonzero (e.g. a missing optional
// app) must not make a healthy VM look dead.
import { describe, expect, test } from "bun:test";
import { guestUnreachable } from "./projects";

describe("the guest probe", () => {
  test("only a timeout, an unreachable agent or no result counts as unreachable", () => {
    expect(guestUnreachable(null)).toBe(true);
    expect(guestUnreachable({ exitCode: 124 })).toBe(true); // timed out
    expect(guestUnreachable({ exitCode: 255 })).toBe(true); // no answer / hung up
    expect(guestUnreachable({ exitCode: 0 })).toBe(false);
    expect(guestUnreachable({ exitCode: 1 })).toBe(false); // a command simply failed
    expect(guestUnreachable({ exitCode: 127 })).toBe(false); // e.g. a missing app
    expect(guestUnreachable({ exitCode: 1, stderr: "Error: XPC connection error" })).toBe(true);
    expect(guestUnreachable({ exitCode: 1, stderr: "container system start" })).toBe(true);
  });
});
