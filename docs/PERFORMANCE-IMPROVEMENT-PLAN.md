# sadbox — Performance Improvement Plan

Status: plan, 2026-11-27. Branch `research/performance-deep-dive`.
Companion to [`docs/research/18-performance-deep-dive.md`](research/18-performance-deep-dive.md)
(the evidence, measurements and file:line index). This document is the *what to
do and in what order*. No code has been changed, and nothing is committed.

> Working rule for this repo: implement on a feature/fix branch, never on
> `main`; do not commit or push until explicitly asked.

---

## 1. Target outcomes

The plan is successful when these are true on a representative machine
(Apple silicon Mac for the CLI path, a KVM host for the agent path):

| Measure | Today (baseline) | Target | How measured |
|---|---|---|---|
| One open project page, guest/CLI ops | ~230 mixed ops/min; ~57 `stats`, ~42 `df`, ~15 probes, ~24 branch execs (N=1) | **<20 mixed ops/min, <10 guest execs/min** | counters + `ps`/spawn log |
| `/details` p95 (warm) | seconds on a large workdir; can self-retry | **<150 ms** | timed requests |
| Idle supervisor CPU | grows with open tabs | **<2 %** | `ps`/Activity Monitor |
| First request to a new HTTPS host | **~5 s** stall on stock macOS | **<100 ms** | timed `curl` through proxy |
| 100-asset page through a forward | 1 exec + 1 guest Bun **per connection** | **1 relay, 0 new processes after warm-up** | guest `ps` |
| Create/push host RSS, 1 GB repo | ≈ repo size (buffered tar) | **<100 MB over baseline** | RSS sampling |
| Editor git status, repo with `node_modules` | seconds every 5 s | **<100 ms cached; ≤15 s cadence** | timed requests |
| Static first load (HTML+JS+CSS) | ~237 KB, uncompressed, uncached | **<80 KB transferred; 304 on repeat** | devtools/`curl -I` |
| Activity page over 7 days | degrades with rows | stable at 1 M rows | seeded DB benchmark |

Guardrails (must not regress):

- **Security invariants**: DNS resolve-then-connect must use the *same* address;
  rules/credentials caches must invalidate on every mutation; secrets are never
  logged; per-project isolation and approvals keep working; proxy responses
  still redact.
- **Correctness**: no stale UI after an action; no cross-project attribution
  (`ctxByPort`); no lost work on sync/push; VM lifecycle unchanged.
- **Compatibility**: API responses may gain fields, not lose them; existing
  CLI/env behaviour stays; existing tests pass on `container`, `kvm` and `vz`.

---

## 2. Top suggestions at a glance

Ordered by impact ÷ effort. "P0/P1/P2" refer to §6 of the research doc.

| ID | Suggestion | Effort | Risk | Expected effect |
|---|---|---|---|---|
| Q-01 | Cache the slow guest probe, stop the 1 s retry, split `/details` | S | Low | Removes the largest steady-state guest cost |
| Q-02 | Raise branch TTL 5 s → 30–60 s + invalidate on change | S | Low | Removes O(N) execs every 5 s |
| Q-03 | Stats sampling floor + cached `inspect`; reuse `df` | S | Low | Removes continuous `container stats` and 40 execs/min |
| Q-04 | Point `vm-warn` at `/resources` | S | Low | Removes a whole-workdir probe per terminal/editor tab every 15 s |
| Q-05 | Pause all polling when hidden; share `/api/projects` | S | Low | Idle tabs go quiet; duplicate requests collapse |
| Q-06 | Static cache headers + compression + defer Ace | S | Low | First load ~237→<80 KB; no 489 KB xterm per tab |
| Q-07 | DB: `synchronous=NORMAL`, events index/retention, batch logs | S | Low | Faster writes, bounded growth, no fsync per log line |
| Q-08 | Collapse vault N+1 + missing indexes | S | Low | `/api/vault` 3N → 3 queries; faster per-item lookups |
| Q-09 | Proxy: rules/credential caches, memoize per request, cache DNS | M | Medium | ~10–16 queries + decrypts → a few |
| Q-10 | Proxy: reuse persisted certs, pre-mint, cap host servers | M | Low–Med | Kills the 5 s first-host stall; bounds FDs |
| S-01 | Editor cadence and head-blob fan-out | M | Low | Big-repo editor stops crawling |
| S-02 | Stream copy-in; incremental push | M | Medium | No GB-scale RAM spikes; faster pushes |
| S-03 | Batch provisioning; one apt install; parallel mounts | M | Low | Shorter create/rebuild |
| S-04 | Background loops (login/toolchain) on demand | S | Low | Less guest CPU every 30 s |
| S-05 | Frontend in-place renders, table throttling | M | Medium | Client CPU/jank under traffic |
| S-06 | Guest agent buffering/leak/backoff/async `ps` | M | Low | Less host CPU, no fd leak, faster boot |
| A-01 | Use the fast agent on Apple silicon | L | Medium | ~50× per guest op on macOS |
| A-02 | Persistent guest relay for forwards/routes/links | L | Medium | No process per connection |
| A-03 | Disk overlays/snapshots; image build caching | L | Medium | Instant create/resume; faster rebuilds |
| A-04 | Telemetry push (SSE per project) | M | Medium | Removes timer polling after Q-01..Q-05 |
| A-05 | Proxy data plane on a worker (only if measured) | L | High | Throughput headroom beyond one loop |

---

## 3. Phase 0 — measure first (½–1 day)

Do this before and after every phase. Without a baseline, improvements become
anecdotes.

1. **Add dev-only counters** behind `SADBOX_PERF=1`:
   - per endpoint: request count, p50/p95, bytes;
   - per driver: exec count, total time, `inspect`/`list`/`stats` count;
   - per proxy request: DNS time, DB query count, decrypt count, cache hits;
   - spawned subprocesses (wrap the driver `run`/`spawn` helpers).
2. **Build fixtures**:
   - small repo (~200 files, no `node_modules`);
   - medium (~5 k files, 100 MB);
   - large (~50 k files with `node_modules`, 1 GB, with a large `.git`).
3. **Run a fixed matrix** (write results into a scratch file, not the repo):
   - home, projects list, one detail page (5 min), 3 detail tabs, terminal,
     editor, forwarded app page load;
   - create/rebuild/start/stop; sync with 1/100/1 000 changed files; push;
   - proxy: first request to a new host, 100 sequential requests, `bun install`
     in a VM;
   - idle 30 min with one tab hidden.
4. **Record**: supervisor CPU/RSS/fds, guest CPU, exec count, SQLite/WAL size,
   UI long-task/jank, and the table from §1.
5. **Record the security checks** you will rerun after each phase: blocked host,
   unbound placeholder, private/self target, plain-http refusal, cross-project
   link, approval expiry.

**Done when**: a baseline sheet exists with the §1 rows filled for at least the
medium fixture, and the security checks have a documented pass/fail.

---

## 4. Phase 1 — quick wins (2–4 days)

Config-level or small, local changes. Can be split across people by area. Land
one task per branch/PR; each has an independent rollback.

### Q-01 — Cache the slow guest probe; stop the self-retry

**Why**: `GUEST_PROBE` runs `du -sb ~/workdir` + `git status` every 4 s per open
page; on timeout the UI re-asks after 1 s, so a busy VM is probed hardest
(research §4.2.3).

**Steps**
1. Introduce a per-project `ProbeCache` (in `core/projects.ts`, or a small
   `core/probecache.ts`) with entries `{ at, disk, workdirBytes, gitDirty,
   gitBranch, tmux }` and a TTL, default 30 s.
2. Split the probe command into a **fast** part (nothing / cheap) and a **slow**
   part (`du`, `git status`, tmux). Poll the fast part; serve the slow part from
   cache until the TTL expires or an explicit refresh is requested.
3. Add `?refresh=1` (or a UI "refresh" button) to force a slow probe.
4. Invalidate the cache on: branch switch, commit/stage/discard/stash, sync,
   push, app install/remove, start/stop, rebuild, workdir creation.
5. Keep the `/details` JSON shape stable; add `probeAgeMs` and `stale: true` so
   the UI can show freshness instead of guessing.
6. Change the UI partial retry from 1 s to ≥10 s (or remove it; the next 4 s
   tick will fill in anyway).
7. Make `driver.exec("true")` liveness check happen only when the probe actually
   timed out, not on every partial.

**Files**: `src/core/projects.ts` (probe, detail), `src/core/vitals.ts` (if the
cache lives there), `web/app.js` (`partial` retry), tests.
**Done when**: with the large fixture open, guest execs/min drop by >80 %, the
detail numbers refresh within 30 s, and "refresh" immediately updates them.

### Q-02 — Branch TTL and invalidation

**Why**: `BRANCH_TTL_MS = 5000` equals the UI poll, so every `/api/projects`
runs one guest `git rev-parse` per running project (research §4.2.1).

**Steps**
1. Raise the TTL to 30 s (configurable `SADBOX_BRANCH_TTL_MS`, 5–120 s).
2. Keep the first-ask short wait only when no branch is recorded.
3. Call `noteBranch()` (which refreshes the timestamp) from `switchBranch`,
   `syncProject`, `pushProject`, and project create/rebuild so the common
   actions update instantly.
4. Batch `hasGitToken` for all projects into one query in
   `projectsWithLiveState`.
5. Cache `driver.list()` for ~1 s and share it between `/api/projects` and
   `/api/system/status`; single-flight it.

**Files**: `src/core/projects.ts`, `src/core/gittoken.ts`, `src/api/http.ts`,
tests.
**Done when**: `/api/projects` makes no guest exec for an unchanged project, and
a branch switch shows up on the next poll.

### Q-03 — Stats floor, cached inspect, reuse `df`

**Why**: `/resources` every 1.5 s runs `inspect` + `container stats` (1–2 s) +
a separate `df` exec (research §4.2.2).

**Steps**
1. Add a per-ref stats sample floor (`SADBOX_STATS_MIN_MS`, default 3 000): if
   the last sample is younger, return it instead of starting another.
2. Add a per-ref `inspect` cache (TTL 2–5 s) invalidated on start/stop/destroy.
3. Fold the workdir `df` into the stats guest command (it already runs in the
   guest), or reuse the sampler's last disk reading.
4. On macOS, replace `container stats` in the *sampler* path with one guest
   `/proc/stat` + `/proc/meminfo` read (the same command used on KVM/vz) and
   compute CPU% between samples. Keep `container stats` only as a fallback.
5. Make the detail page's fast poll read the last sampler/sample values rather
   than starting its own when they are fresh.

**Files**: `src/core/vitals.ts`, `src/core/projects.ts`,
`src/driver/container.ts`, `src/driver/vz/index.ts` (async `ps`, see S-06).
**Done when**: one open page performs ≤1 stats and ≤1 `df` per 5 s; CPU/memory
graphs remain within ~1 point of the old values.

### Q-04 — `vm-warn` uses the cheap endpoint

**Why**: every terminal/editor tab fetches the heavy `/details` every 15 s just
to read CPU/memory (research §4.2.3).

**Steps**
1. Change `web/vm-warn.js` to fetch `/api/projects/:id/resources`.
2. If the warning needs `state`, use the `running` flag in that response.
3. Coordinate with A-04 later; until then, keep the 15 s cadence but cheap.

**Files**: `web/vm-warn.js`.
**Done when**: no terminal/editor tab triggers `du`/`git status`.

### Q-05 — Visibility pause and request sharing

**Why**: the main UI keeps polling in hidden tabs and fetches `/api/projects`
2–4× per navigation (research §4.8).

**Steps**
1. Add a single `PollCoordinator` in `app.js`: register each timer with a name,
   interval, and visibility policy; pause on `document.hidden`, resume (with
   immediate refresh) on visible.
2. Cache `/api/projects` for 2 s in the client and share it between the cards,
   nav tree, vault dialogs and link pickers; invalidate on an explicit action.
3. In `refreshNavTree`, skip the `/api/net/pending` call when the SSE stream
   already provides counts, or coalesce the two into one request.
4. Replace the `refreshNavTree()` calls inside SSE `pending` handlers with a
   local badge update.
5. Do not poll `/api/system/status` off the home view.

**Files**: `web/app.js`, `web/net-asks.js` (only tick when approvals exist),
`src/api/http.ts` if a combined endpoint is chosen.
**Done when**: a hidden tab makes zero periodic requests after one interval;
the network panel shows the same data as before.

### Q-06 — Static delivery

**Why**: ~237 KB of HTML/JS/CSS and 489 KB of xterm are re-downloaded on every
navigation/tab, uncompressed and uncached (research §4.7).

**Steps**
1. Add `Cache-Control` and a strong `ETag` (or content hash) to `staticRoutes`:
   `no-cache` for HTML, `max-age=31536000, immutable` for versioned vendor
   files; include `VERSION` in the URL or the ETag.
2. Enable gzip/brotli for text responses (pre-compress at build or use Bun's
   response compression where available; verify the exact Bun API before
   relying on it).
3. Add `defer` to the Ace scripts (or import them on editor open).
4. Cache `Bun.file()` handles (or the bytes) instead of constructing a new
   response object per request; keep `Bun.file` streaming.
5. Verify 304s on reload and that a new build busts the cache.

**Files**: `src/api/http.ts`, `src/assets.ts`, `web/index.html`,
`web/editor.html`, `web/terminal.html`.
**Done when**: repeat loads transfer <10 KB; first load <80 KB with compression;
terminal open does not re-download xterm.

### Q-07 — SQLite writes and event log

**Why**: WAL with default `synchronous=FULL`, one fsync per log line, unbounded
unindexed `events` (research §4.7).

**Steps**
1. Set `PRAGMA synchronous = NORMAL`, `PRAGMA busy_timeout = 5000`, and (if not
   already) confirm `journal_mode = WAL` at startup.
2. Add `CREATE INDEX IF NOT EXISTS events_project_id ON events(project_id, id)`.
3. Add retention for `events`: keep N days (default 30) or a per-project cap;
   run a chunked prune (e.g. `DELETE … WHERE id IN (SELECT … LIMIT 1000)` in a
   loop), not one unbounded delete.
4. Batch `logOutput` into one transaction (or one multi-row insert) per command;
   keep the 500-line cap.
5. Wrap the remaining multi-row loops (`updateSettings`, `setSeen`, purge
   helpers) in transactions.
6. Drop the redundant `resource_samples` index; add an index on `ts` for the
   hourly prune (or prune per project with the PK).
7. Gate migrations with `PRAGMA user_version` and run DDL + `migrateToVault` in
   one transaction so startup stops doing dozens of autocommits.

**Files**: `src/db.ts`, `src/core/projects.ts`, `src/core/settings.ts`,
`src/core/logins.ts`, `src/core/resources.ts`, tests.
**Done when**: a verbose create writes its log in one commit; `events` size
stays bounded; startup runs one migration transaction.

### Q-08 — Vault N+1 and missing indexes

**Why**: `/api/vault` is 3 queries per item and is loaded on every UI boot; some
lookups scan (research §4.7).

**Steps**
1. Replace per-item `listBindings`/`projectsOf`/`listFetchGrants` with three bulk
   queries and group in memory (or one joined query per relation).
2. Add indexes: `project_secrets(secret_id)`,
   `vault_fetch_grants(secret_id)`, `port_forwards(project_id)`,
   `forward_sessions(forward_id)`, `project_links(to_project)`.
3. Keep `projectVaultView` on the same bulk path.
4. Add a test that counts queries for a 20-item vault (target: constant, not
   3N).

**Files**: `src/core/vault.ts`, `src/net/fetchgrants.ts`, `src/db.ts`, tests.
**Done when**: `/api/vault` runs a fixed number of queries independent of item
count.

### Q-09 — Proxy caches and per-request memoization

**Why**: 10–16 synchronous queries and repeated secret decryption per allowed
request (research §4.4).

**Steps**
1. Add a per-project `RulesCache` with a version counter. Bump it in
   `createRule`, `deleteRule`, `moveRule`, header-rule CRUD, and any approval
   that creates a binding. Cache the **rule rows** (not verdicts) and the
   header-rule rows, then evaluate against the request as today.
2. Add a per-project `CredentialCache` for **metadata only** (secret id, name,
   placeholder, encrypted value, bindings, login placeholders) with a version
   counter bumped on vault/binding/access/login changes. Do not cache plaintext.
3. Memoize `projectCredentials()`/`loginCredentials()` for the duration of one
   request (pass a context object through the handler).
4. Skip `redactResponse`/`bodyRedactor` entirely when the project has no
   redactable secrets (cache a boolean).
5. Evaluate rules **before** `resolveTarget`; only resolve for allow/ask.
6. Cache `ownAddresses()` for ~30 s.
7. Single-flight `refreshIpMap()` and raise its TTL; record the VM→IP mapping at
   create/start where possible.
8. Add a DNS cache `(host → {address, reach})` with a 30–60 s TTL and negative
   caching; keep check+connect on the cached address (security invariant).

**Files**: `src/net/rules.ts`, `src/net/credentials.ts`,
`src/net/claudeoauth.ts`, `src/net/proxy.ts`, `src/net/cutoff.ts`, tests.
**Done when**: a repeat request to an allowed host performs ≤3 DB queries total
and no DNS lookup within the TTL; rule changes take effect immediately.

### Q-10 — Certificates and per-host servers

**Why**: first request to a new host stalls 5 s on LibreSSL; the persisted leaf
cert is not reused; per-host servers are unbounded (research §4.4).

**Steps**
1. Read the persisted `.leaf-<host>.crt` on startup if it exists, is valid, and
   matches the CA; skip minting.
2. Pre-mint on the paths that know hosts: project create/rebuild (git remote and
   known bindings), rule/binding creation, and the agent hosts at proxy start.
3. If the installed OpenSSL supports `-not_before`, use it and skip the 5 s
   sleep. If not, mint in the background and hold the CONNECT only until the
   cert is ready (with a cap), instead of an unconditional 5 s.
4. Add an LRU cap to `hostServers`/`certCache` (e.g. 256 entries), closing
   idle listeners on eviction.
5. Re-test whether a single TLS front end with `SNICallback` works on the
   current Bun; if it does, remove the per-host listener and the loopback hop.
6. Fix `ctxByPort` to key on the socket/`remoteAddress:remotePort` (correctness).
7. Give upstreams an explicit `https.Agent` with a longer idle timeout and one
   retry on a stale keep-alive socket; keep the pool keyed by host, not just IP.

**Files**: `src/net/ca.ts`, `src/net/proxy.ts`, tests.
**Done when**: first request to a new host is <100 ms after warm-up, restart
does not re-stall, and 1 000 distinct hosts do not exhaust FDs.

---

## 5. Phase 2 — structural, low/medium risk (1–2 weeks)

### S-01 — Editor cadence and fan-out

1. Poll `/files/status` every 10–15 s (and on window focus), not 5 s.
2. Stop using `--ignored` for the colour pass; use plain `git status` or a
   `.gitignore`-aware filter. Offer "show ignored" explicitly.
3. Fetch `/file/head` lazily for the active tab only; cache base/index by blob
   oid and skip when unchanged.
4. Cache `/files/index` for ~10 s and cap it at the source (`head` before
   transfer); replace `find -exec test` with pruning (`-path '*/.git' -prune`).
5. Re-read a folder only when its entry set changed.
6. Skip the pre-write SHA on `force`; compare `indexOid` instead of resending
   whole files to stage hunks where possible.
7. Clear `tab.diffTimer` on close.

**Done when**: a 10-tab editor in the large fixture generates <10 requests per
minute while idle, and typing remains responsive.

### S-02 — Copy-in and push

1. Stream `tar` stdout into `execWithStdin` instead of buffering the archive
   (use a `Blob`/stream; the agent already applies backpressure).
2. Exclude build output (`node_modules`, `.venv`, `target`, `dist`, …) by
   default for plain folders and honour `.gitignore`; add a `.sadboxignore`.
3. Keep `.git` for sync correctness. If history size is the problem, evaluate a
   partial/filtered clone (`--filter=blob:none`) or a shallow copy **only** if
   sync-back can still resolve the base commit; otherwise keep the full copy and
   rely on streaming plus the exclude list.
4. Push: first compare size/mtime/git-status; hash only candidate files; do not
   hash every byte on both sides when nothing changed.
5. Add progress events for large copies (bytes/total) so the UI can show it.

**Done when**: a 1 GB repo create peaks host RSS within 100 MB of baseline and
an unchanged push does not read the whole tree.

### S-03 — Provisioning batching

1. Combine the guest writes that are independent — `chown`, history ownership
   and links, shell hooks, `net.env`, vault env — into one `sh -c` script.
2. Install all `apps` with one `apt-get update && apt-get install -y pkg…`
   command; parallelise optional-app installs with a small concurrency cap.
3. `Promise.all` the post-boot mount replay (7 sequential mounts today).
4. Group the history spots under one shared root so there is one share, not 7.
5. Cache `historyOf()` sizes by mtime; do not walk the store on every create.
6. Use the agent announcement/ping for start readiness instead of 30 × 500 ms
   execs.

**Done when**: an empty create makes ≤4 guest round trips after boot, and a
create with 4 apt extras makes one apt install.

### S-04 — Background loops

1. Login capture: on create/start, then every 5–10 min (configurable), not every
   30 s; first cheap-stat the credential files and skip the guest script when
   mtimes are unchanged; run projects with a small concurrency cap, not
   sequentially.
2. Toolchain probe: reduce to the tools that actually change (claude, omp,
   opencode, bun) and keep the 5 min TTL; do not source `nvm.sh` for a version
   check.
3. Sampler: add jitter (±20 %), skip VMs sampled <20 s ago, cap concurrency, and
   delay the first tick by a few seconds after boot.

**Done when**: a VM that is idle and unchanged sees no login/toolchain guest
process for 5 min.

### S-05 — Frontend render discipline

1. Patch detail fields in place (textContent/value) instead of replacing the
   stats/actions/tools panels.
2. Throttle the Activity table to 250–500 ms, append new rows instead of
   rebuilding; debounce the filter; cap `netModel.older` (e.g. 1 000 rows) and
   render a window.
3. rAF-throttle chart hover and redraw only the hovered canvas.
4. Guard `renderDetail` against stale responses (`if (hash !== current) return`).
5. Append create logs to an array and join once; cap the lines.
6. Stop the 1 s `net-asks` tick when there are no asks; share one SSE stream.
7. Fix the terminal: `@xterm/addon-webgl` (optional), explicit scrollback,
   `ResizeObserver`, auto-reconnect with backoff, and a `bufferedAmount` guard.
8. Editor: `useWorker: true`, cap the diff trace, debounce the diff further,
   render the commit/palette/branch lists only when their inputs change.

**Done when**: with the network panel open during `bun install`, UI long tasks
stay under ~50 ms and the table scrolls smoothly.

### S-06 — Agent robustness and host buffering

1. Replace `readFrames`'s per-chunk `Buffer.concat` with a chunk list and a
   single concat at the end.
2. Fix the `request()` timeout leak: destroy the socket as soon as it resolves
   if the request already timed out.
3. Add exponential backoff to `waitForAgent` (20 → 100/250/500 ms).
4. Cache the guest user lookup (uid/gid/groups/shell) per user and stop reading
   `/etc/passwd` twice per exec; pool the 128 KiB pump buffers.
5. Make the vz driver's `ps` calls async (or use `libproc`/`/proc`); remove the
   blocking `Bun.spawnSync` from stats and `vmmPids`.
6. Add a timeout to `hostGit`.
7. Kill virtiofsd on a failed KVM boot.

**Done when**: bulk reads (100 MB bundle) do not show quadratic CPU/memory, and
stopping a VM no longer freezes the API for ~100 ms.

---

## 6. Phase 3 — architectural (2–4 weeks, one at a time)

### A-01 — Fast guest agent on Apple silicon

**Goal**: remove the ~90 ms CLI tax on the most common platform.

1. Design: keep `container` for create/start/stop/destroy/images; run
   `sadbox-agent` (the Go PID-1/daemon already used on KVM/vz) inside the macOS
   base image, listening on a socket published with `--publish-socket` (the same
   mechanism as the proxy relay). If Apple's runtime exposes vsock later, prefer
   it.
2. Build: add the agent to the macOS image pipeline (reuse
   `images/disk`'s agent build); version it with the image recipe.
3. Driver: implement `exec`, `execWithStdin`, `execCaptureBytes`, `stream`,
   `terminal` over `driver/agent.ts` in `driver/container.ts`; keep the CLI
   methods behind `SADBOX_FAST_EXEC=0` as a fallback.
4. Lifecycle: start/verify the agent on boot; fall back to `container exec` if
   it does not answer; surface the mode in `doctor`.
5. Tests: run the driver contract suite against both paths; measure exec p50/p95
   and a full create.

**Acceptance**: `exec true` p50 <10 ms on Apple silicon; all existing tests pass;
create is no slower; a kill switch reverts to the CLI.

### A-02 — Persistent guest relay for forwards/routes/links

**Goal**: no process per connection.

1. Protocol: host sends a small header (target port) over a carrier; the guest
   relay dials the port and splices bytes. Reuse the carrier/pool model of
   `relay.js`.
2. Guest: one root-owned relay process per VM, started with the existing guest
   tools; it listens on a published socket, accepts carriers, and enforces a
   connection cap.
3. Host: replace `driver.stream(guestConnectCmd(port))` in `forwards.ts`,
   `routes.ts`, `links.ts` with a pool per (project) and a port header; keep the
   old path behind a flag.
4. Backpressure: honour `write()` return values/`pause()`/`resume()`; cap bytes
   queued per connection; close on overflow.
5. Security: the relay only accepts the host carrier socket; no guest-local
   listener reachable by the agent; verify the proxy/forward auth gates still
   run before the bridge.
6. Remove `Connection: close` on links once the relay supports reuse.

**Acceptance**: 100-asset page load and an HMR socket through a forward spawn
zero guest processes after warm-up; throughput ≥ the old path; auth unchanged.

### A-03 — Disk and image costs

1. Detect reflink support; if unavailable, use a qcow2 overlay (Cloud
   Hypervisor) or a shared read-only base + overlay instead of a full copy.
2. On Linux, evaluate CH snapshot/restore for near-instant stop/start.
3. Pin base-image installers and add BuildKit cache mounts; keep apt archives
   or bake common optional apps (Blender is ~800 MB per VM).
4. Cache `recipeHash`/`diskMeta` per process; do not run `container image
   inspect` on every create.

**Acceptance**: create on ext4 is dominated by boot, not a 2.3 GB copy; a
base-image rebuild reuses cached download layers.

### A-04 — Push-based telemetry

1. Add an SSE (or WS) channel per project that pushes state + resources when
   they change (the network panel already proves the pattern).
2. Keep a low-frequency fallback poll (30 s) for clients that lose the stream.
3. Remove the 1.5 s/4 s timers once the stream is reliable; keep `/resources`
   and `/details` for explicit loads.

**Acceptance**: with the stream connected, an open page makes no periodic
requests; state changes appear within ~200 ms.

### A-05 — Proxy data plane on a worker (conditional)

Only if Phase 0/2 measurements show the single loop >60 % of a core at the
expected peak.

1. Move the proxy's accept/TLS/HTTP path into a `Worker` with its own SQLite
   connection (read-only caches) and message-passing for approvals/logging.
2. Keep the control plane (UI, rules CRUD) in the main thread; invalidate via
   messages.
3. Alternatively, keep the same protocol and move only the byte plane to a Go
   sidecar (the named escape hatch).

**Acceptance**: measured throughput/CPU improvement with no change in security
behaviour; a flag reverts to the in-process proxy.

---

## 7. Sequencing and dependencies

```
Phase 0 (baseline)
  └─> Q-01..Q-08 (parallel by area; Q-01/Q-02/Q-03 first)
        └─> Q-09/Q-10 (proxy; depends on Q-07 indexes and Q-08 vault cache)
              └─> S-01..S-06 (editor, copy/push, provisioning, loops, UI, agent)
                    ├─> A-01 (agent on macOS)  ─┐
                    ├─> A-02 (relay)            ├─> A-04 (push telemetry)
                    └─> A-03 (disk/images)     ─┘
                          └─> A-05 only if measured
```

Suggested first week: Q-01, Q-02, Q-03, Q-04, Q-05, Q-06, Q-07, Q-08 — all are
small and independently reversible. Re-measure before starting Phase 2.

---

## 8. Validation checklist (for every task)

- [ ] Unit tests for the new cache/TTL/invalidation and its failure modes.
- [ ] Integration test against `test/fake-ch.ts` / `test/fake-vfkit.ts` where
      the driver is involved.
- [ ] `bun test`; `test/e2e-linux.ts`; `kvm.it.test.ts` / `vz.it.test.ts` if the
      change touches a driver.
- [ ] Re-run the §1 metrics and record before/after.
- [ ] Re-run the security checks from Phase 0.
- [ ] Check hidden-tab behaviour, restart behaviour, and a VM restart.
- [ ] Check that `SADBOX_*` kill switches/old paths still work.
- [ ] Update `docs/research/18-performance-deep-dive.md` (mark the finding
      addressed) and any user-facing limitation.

### Security regression checks (must stay true)

1. A name resolving to loopback/self is blocked unless an exact-host rule
   allows it; `*` never opens it.
2. A request classified as private/LAN is not allowed by a catch-all rule.
3. A placeholder sent to an unbound host never gets a real value; plain HTTP
   never swaps.
4. A secret value never appears in `/api` responses, logs, or the request log.
5. A project cannot reach another project's port without a link; a link is
   one-way.
6. An approval expired/denied cannot be reused; a rule cache invalidation is
   immediate after a block/allow.
7. Forward/named-route sign-in passes still gate every request and WebSocket.

---

## 9. Rollout notes

- Prefer **additive API fields** and keep old endpoints working; the UI and API
  are used by scripts/tests.
- Put risky changes behind env flags with safe defaults, then flip defaults
  after the §1 targets are met.
- DB changes: index creation and retention are additive; gate with
  `user_version`; no destructive migration without a backup/`VACUUM` note.
- Document the new flags in `sadbox help` and the README env list.
- Keep the old CLI exec path until A-01 has run for a release; keep the old
  bridge path until A-02 has run for a release.

Suggested flag defaults:

| Flag | Default | Purpose |
|---|---|---|
| `SADBOX_PROBE_TTL_MS` | `30000` | slow probe fields (`du`, `git status`, tmux) |
| `SADBOX_STATS_MIN_MS` | `3000` | minimum gap between stats samples per VM |
| `SADBOX_BRANCH_TTL_MS` | `30000` | branch lookup per project |
| `SADBOX_EVENTS_DAYS` | `30` | `events` retention |
| `SADBOX_PROXY_CACHE` | `1` | rule/credential/DNS caches (kill switch) |
| `SADBOX_FAST_EXEC` | `0` → `1` | agent exec on macOS (0 during rollout) |
| `SADBOX_PERSISTENT_RELAY` | `0` → `1` | forwards/routes/links relay |

Rough effort for one person: Phase 1 **2–4 days**, Phase 2 **1–2 weeks**,
Phase 3 **2–4 weeks** (A-01 and A-02 are the bulk). Phase 1 alone should deliver
most of the perceived responsiveness win.

---

## 10. Non-goals (do not do)

- Do not rewrite the supervisor in Go/Rust for these numbers.
- Do not add a frontend framework/build step to fix rendering.
- Do not replace SQLite.
- Do not poll faster to feel live; push or cache.
- Do not cache decrypted secrets beyond a request.
- Do not cache DNS results in a way that re-resolves between the classification
  and the connect.
- Do not make `main` the working branch for any of this.

---

## 11. Copy-paste task list

| ID | Task | Area | Effort | Depends on | Done when |
|---|---|---|---|---|---|
| Q-01 | Probe cache + `/details` split + no 1 s retry | core/api | S | Phase 0 | <10 guest execs/min per page |
| Q-02 | Branch TTL + batch `hasGitToken` + list cache | core | S | — | no branch exec per poll |
| Q-03 | Stats floor + inspect TTL + reuse `df` | core/driver | S | — | ≤1 stats/df per 5 s |
| Q-04 | `vm-warn` → `/resources` | web | S | — | no heavy probe per tab |
| Q-05 | Visibility pause + shared projects cache | web | S | — | hidden tab quiet |
| Q-06 | Static cache/ETag/gzip + defer Ace | api/web | S | — | <80 KB first, 304 repeat |
| Q-07 | DB pragmas + events index/retention + batch logs | db/core | S | — | one commit per log batch |
| Q-08 | Vault bulk queries + indexes | db/core | S | — | constant queries |
| Q-09 | Proxy rule/credential/DNS caches + memo | net | M | Q-07/08 | ≤3 queries per repeat request |
| Q-10 | Cert reuse/pre-mint/cap + agent + ctx key | net | M | Q-09 | no 5 s stall |
| S-01 | Editor cadence/fan-out/index | core/web | M | Q-01 | <10 req/min idle editor |
| S-02 | Stream copy-in + incremental push | core | M | — | RSS flat on 1 GB repo |
| S-03 | Batch provisioning + shares | core/driver | M | — | ≤4 round trips |
| S-04 | Background loops on demand | core | S | — | no 30 s guest churn |
| S-05 | In-place UI renders/table/terminal | web | M | — | <50 ms long tasks |
| S-06 | Agent buffering/leak/backoff/async ps | driver/guest | M | — | no quadratic bulk read |
| A-01 | Agent on Apple silicon | driver | L | S-06 | <10 ms exec p50 |
| A-02 | Persistent relay | net/guest | L | S-02 | 0 processes per asset |
| A-03 | Disk overlays/snapshots/image cache | driver/images | L | — | create not copy-bound |
| A-04 | Push telemetry | api/web | M | Q-01..Q-05 | no timer polls |
| A-05 | Proxy worker | net | L | Q-09, measured | measured headroom |

---

## 12. References

- Evidence, numbers and file:line index:
  [`docs/research/18-performance-deep-dive.md`](research/18-performance-deep-dive.md).
- Measured agent/CLI costs: `spikes/e-cloud-hypervisor/README.md`.
- Lifecycle timings: `docs/ROADMAP.md`.
- Sync design: `docs/research/06-workdir-sync.md`.
- Stack rationale and the Go escape hatch:
  `docs/research/07-supervisor-stack.md`.
