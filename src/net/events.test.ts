import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config";
import { db } from "../db";
import { makeProject } from "../../test/helpers";
import {
  clearProjectFeed, flushRequests, hostSummary, pruneRequests, recentRequests, recordRequest, requestsBefore,
  type RequestEntry,
} from "./events";

const P = makeProject("log-a");
const Q = makeProject("log-b");
let n = 0;
const entry = (over: Partial<RequestEntry> = {}): RequestEntry => ({
  id: `t${++n}`, ts: Date.now(), method: "GET", scheme: "https", host: "api.github.com", path: "/zen",
  status: 200, decision: "allowed", reqBytes: 0, respBytes: 10, durationMs: 5, ...over,
});

beforeEach(() => {
  flushRequests();
  db.run("DELETE FROM net_requests");
  clearProjectFeed(P); clearProjectFeed(Q);
});

describe("request log persistence", () => {
  test("recorded requests reach the database in a batch, with secret names and errors", () => {
    recordRequest(P, entry({ credentials: ["GITHUB_TOKEN"], redacted: ["GITHUB_TOKEN"] }));
    recordRequest(P, entry({ status: 403, decision: "blocked", error: "network is cut off for this VM", credentialInUrl: ["X"] }));
    expect(db.query("SELECT COUNT(*) AS c FROM net_requests").get()).toEqual({ c: 0 }); // not yet: batched
    flushRequests();
    const rows = requestsBefore(P, Date.now() + 1);
    expect(rows.map((r) => r.decision)).toEqual(["allowed", "blocked"]);
    expect(rows[0]).toMatchObject({ credentials: ["GITHUB_TOKEN"], redacted: ["GITHUB_TOKEN"] });
    expect(rows[1]).toMatchObject({ error: "network is cut off for this VM", credentialInUrl: ["X"] });
  });

  test("the live ring refills from the database after a restart / rebuild, without doubles", () => {
    for (let i = 0; i < 3; i++) recordRequest(P, entry({ path: `/old${i}` }));
    flushRequests();
    clearProjectFeed(P); // what a rebuild does — and what a fresh process looks like
    recordRequest(P, entry({ path: "/new" })); // arrives before anyone asks
    const live = recentRequests(P);
    expect(live.map((e) => e.path)).toEqual(["/old0", "/old1", "/old2", "/new"]);
    expect(recentRequests(P).length).toBe(4); // second call doesn't reload
  });

  test("paging back: oldest-first pages before a timestamp, per project", () => {
    const t0 = Date.now() - 10_000;
    for (let i = 0; i < 5; i++) recordRequest(P, entry({ ts: t0 + i, path: `/p${i}` }));
    recordRequest(Q, entry({ ts: t0 + 2, path: "/other" }));
    const page = requestsBefore(P, t0 + 4, 2);
    expect(page.map((e) => e.path)).toEqual(["/p2", "/p3"]);
    expect(requestsBefore(P, t0 + 4, 10).some((e) => e.path === "/other")).toBe(false);
  });

  test("by-host summary over a time range", () => {
    const now = Date.now();
    recordRequest(P, entry({ host: "a.com", ts: now - 1000, credentials: ["T1"] }));
    recordRequest(P, entry({ host: "a.com", ts: now - 500, status: 500, credentials: ["T1", "T2"] }));
    recordRequest(P, entry({ host: "a.com", ts: now - 400, status: 403, decision: "blocked", error: "nope" }));
    recordRequest(P, entry({ host: "b.com", ts: now - 2 * 86_400_000 })); // outside a 24h window
    const s = hostSummary(P, now - 86_400_000);
    expect(s.map((h) => h.host)).toEqual(["a.com"]);
    expect(s[0]).toMatchObject({ requests: 3, ok: 1, errors: 1, blocked: 1, last: now - 400, lastError: "nope" });
    expect(s[0].credentials.sort()).toEqual(["T1", "T2"]);
    expect(hostSummary(P, now - 7 * 86_400_000).map((h) => h.host).sort()).toEqual(["a.com", "b.com"]);
  });

  test("retention drops only rows older than the window", () => {
    const now = Date.now();
    recordRequest(P, entry({ ts: now - 8 * 86_400_000, path: "/stale" }));
    recordRequest(P, entry({ ts: now - 6 * 86_400_000, path: "/kept" }));
    expect(pruneRequests(7, now)).toBe(1);
    expect(requestsBefore(P, now).map((e) => e.path)).toEqual(["/kept"]);
  });

  test("retention is at least 7 days", () => {
    expect(config.netLogDays).toBeGreaterThanOrEqual(7);
  });
});
