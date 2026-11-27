# 18 — Performance Deep Dive

Status: research/analysis only, 2026-11-27. Branch `research/performance-deep-dive`.
No code was changed, no commit was made. This document is a read-only review of the
implementation as it stands on `main` at `ee515c9` (v0.6.12), plus the measured
numbers already recorded in `spikes/`, `docs/ROADMAP.md` and the test suite.

The actionable companion — suggestions, steps, sequencing and acceptance
criteria — is [`docs/PERFORMANCE-IMPROVEMENT-PLAN.md`](../PERFORMANCE-IMPROVEMENT-PLAN.md).

Audience: whoever works on sadbox next. Read §1 for the verdict, §6 for the
ordered plan, and the appendix for the file:line index.

---

## 1. Executive summary

**The tech stack is sufficient. A rewrite would be the wrong move.** Bun +
TypeScript + SQLite + a vanilla-JS frontend + per-platform microVM drivers is
the right shape for a single-user supervisor with tens of projects. Nothing found
here needs a different language, runtime, database or framework.

What is **not** sufficient is the current *use* of that stack. Five patterns
account for most of the avoidable cost:

1. **Telemetry is the workload.** The UI polls three independent loops (1.5 s,
   4 s, 5 s × 2) and every loop does fresh guest work. One open project page
   costs roughly **230 mixed guest/CLI operations per minute** — including a
   whole-workdir `du -sb`, a whole-repo `git status`, 40 `container stats`
   calls and 40 `df` execs — before the agent does anything. Every terminal and
   editor tab adds another full `/details` probe every 15 s. On Apple silicon
   this is tens of seconds of subprocess/guest time per minute per open page —
   often most of a core.
2. **The Apple-silicon control plane is a process per operation.** `container
   exec` costs ≈90 ms (measured in Spike E) and 0.1–0.3 s in practice, while the
   in-guest agent already used on Linux/Intel answers in **1.7 ms p50**. The
   same product therefore has a ~50× slower guest-control path on its most
   common platform, purely because the driver shells out to a CLI.
3. **Per-request work is not cached.** The proxy does DNS, 10–16 SQLite queries,
   repeated secret decryptions, and keeps a TLS listener per host for every
   request.
4. **Inbound apps spawn a guest process per connection.** Port forwards, named
   routes and project links run `bun connect.js` inside the VM for **every TCP
   connection**.
5. **The event log is unbounded and writes one fsync per row.** `events` is never
   pruned or indexed by project, and a verbose provisioning step can insert 500
   rows outside a transaction.

**Short answer:** the existing stack is both sufficient and the right place to
improve. The significant gains available — ~20–50× on guest operations on Apple
silicon, ~10× less telemetry, ~5–10× less per-request proxy overhead, and no
per-connection process for forwarded apps — are all achievable inside Bun,
SQLite, the vanilla frontend and the existing driver/agent boundary. No
migration to Go, Rust, Postgres, React or a different VMM is warranted at the
current scale. The only credible future change is moving the proxy data plane to
a worker (or a Go sidecar) *if* measurements show the single event loop
saturating.

The good news: every one of these is an in-stack change. The measured wins
available without touching the architecture are large:

| Change | Where | Expected effect | Confidence |
|---|---|---|---|
| Cache/slow down telemetry (branch TTL, probe cache, stats floor, `/resources` reuse) | `core/projects.ts`, `core/vitals.ts`, `web/*` | Removes ~90–95 % of steady-state guest ops; one open page from ~230 to <20 ops/min | High |
| Use the existing guest agent on Apple silicon (published socket) | `driver/container.ts` + image | Guest op ≈90 ms → ≈2–5 ms; create, editor, sync, probes all speed up ~20–50× | Medium-high (design work) |
| One persistent guest relay for forwards/routes/links | `net/{forwards,routes,links,guest}.ts` | Per-connection ≈100 ms + process → ≈1 ms; page loads and HMR stop paying per asset | High |
| Cache DNS/rules/credentials; remove the 5 s cert settle; bound per-host servers | `net/proxy.ts`, `net/rules.ts`, `net/credentials.ts`, `net/ca.ts` | ~10–16 SQL queries + decrypts + a DNS lookup per request become a few cached lookups; first request to a new host stops stalling 5 s | High |
| DB pragmas, indexes, batched writes, collapse N+1s | `db.ts`, `core/projects.ts`, `core/vault.ts` | Create logs stop fsyncing per line; Activity stays fast as logs grow; vault list 3N queries → 3 | High |
| Static caching + compression + pause polling when hidden | `api/http.ts`, `web/app.js` | First load 237 KB → ~60 KB; 488 KB xterm no longer re-downloaded per tab; idle tabs go quiet | High |

**Bottom line:** with the P0 fixes, sadbox should feel instantaneous at the
UI, keep guest CPU for the agent instead of telemetry, and make the Apple-silicon
experience close to the Linux/Intel one. None requires abandoning Bun, SQLite,
the vanilla frontend or the microVM model.

---

## 2. Method and evidence

- Full read of the runtime paths: `src/{api,core,driver,net}`, `web/*`,
  `guest/agent/*`, `db.ts`, `config.ts`, plus `docs/research/*` and `spikes/*`.
- Measured numbers are taken from the repository's own spikes, not invented:
  - `container exec` ≈ **90 ms** on macOS, vsock agent `exec` **p50 1.7 ms /
    p95 2.3 ms**, `ping` **0.73 ms** — `spikes/e-cloud-hypervisor/README.md:82-112`.
  - macOS warm create→ready ≈ **1.2 s** — `docs/research/README.md:117`.
  - KVM create→ready **7.0 s** (dominated by a 2.3 GB disk copy), start
    **0.18 s**, stop **0.05 s**, destroy **0.13 s** — `docs/ROADMAP.md:151-155`.
  - vz create **0.46–0.99 s**, start **0.42–0.92 s**, stop **0.05–0.10 s**,
    destroy **0.06–0.11 s** — `docs/ROADMAP.md:251-254`.
  - `container stats` "takes a couple of seconds per call" — `core/vitals.ts:2`.
  - `Bun.spawnSync(["ps","-axww",…])` in the vz driver measured at **60–190 ms**
    of event-loop block on this machine (three runs).
- Costs not measured here are labelled **estimate** or **verify**. Nothing was
  benchmarked against a running VM in this pass, because the working tree must
  stay untouched; §8 defines the benchmarks to run next.
- `bun:sqlite` behaviour is taken from Bun's current docs: `db.query()`
  caches compiled statements, up to `MAX_QUERY_CACHE_SIZE` (default **20**);
  WAL is enabled but `synchronous` is **not** set.

---

## 3. Where the time actually goes

sadbox has four kinds of work, with very different cost profiles:

| Work | Path | Cost driver | Sensitive to |
|---|---|---|---|
| **UI telemetry** | browser → `Bun.serve` → driver → guest | number of polls × per-poll guest ops | open tabs, number of projects, workdir size |
| **Agent egress** | VM → proxy → internet | per-request DNS, rules, TLS, upstream connections | request rate |
| **Inbound apps** | browser → forward/route → guest | one exec + one guest process per connection | assets/connections per page |
| **Lifecycle** | create/rebuild/start/stop | sequential guest round trips, disk clone | image size, number of steps |

The first row is, today, the largest and the least valuable: it exists to draw
numbers the user looks at briefly.

### 3.1 Per-minute budget of one open project page (macOS `container`)

Counted from the code (intervals in `web/app.js`, server work in
`core/projects.ts`, `core/vitals.ts`):

| Poll | Interval | Per tick | Per minute |
|---|---|---|---|
| `/api/projects` (nav tree, always) | 5 s | `container list` + **N branch `exec`s** | 12 list + 12N execs |
| `/api/projects` (cards, projects view) | 5 s | same again | another 12 list + 12N execs |
| `/api/system/status` (home) | 5 s | `container system status` spawn | 12 spawns |
| `/api/projects/:id/resources` | 1.5 s | `inspect` + `container stats` + `df` exec | 40 inspect + 40 stats + 40 execs |
| `/api/projects/:id/details` | 4 s | `inspect` + `GUEST_PROBE` (`du -sb`, `git status`, 3 tmux) + stats | 15 inspect + 15 probes + ~15 stats |
| `vm-warn` (each terminal/editor tab) | 15 s | **full `/details`** | 4 probes per tab |
| resource sampler | 30 s per running VM | `inspect` + `stats` + `df` | 2 of each per VM |
| login loop | 30 s per running VM | `bun run -` in the guest | 2 guest Bun starts per VM |

One page, one project, no other tabs: about **230 mixed operations/min** —
~36 CLI spawns (`list`/`status`), ~57 `inspect`s, ~57 `stats` demanded, ~42 `df`
execs, ~24 branch execs, ~15 whole-workdir probes and ~2 guest Bun starts. On
macOS the stats loop alone keeps `container stats` running essentially
continuously (1–2 s per call, one at a time per VM, so ~30–40 completed per
minute), and the rest adds tens of seconds of subprocess/guest time — i.e. most
of a core, continuously, before the agent does any work. Each extra terminal tab
adds ~12 operations/min (4 heavy probes).

On vz/KVM the same count is much cheaper (agent ops at 1.7 ms), but it is still
wasted guest CPU, wasted wakeups and wasted supervisor time — and it scales
O(projects × tabs).

### 3.2 What the user actually needs from telemetry

- A state dot: running/stopped/error — changes rarely.
- CPU/memory/disk numbers: 1–3 s resolution is plenty for a graph.
- Branch, dirty count, workdir size, tmux clients: useful on the detail page,
  not at 4 s; 15–30 s is indistinguishable to a human.

Almost all of the cost is avoidable with TTLs and event-driven updates that keep
the perceived freshness.

### 3.3 Symptom → cause map

| What the user feels | Most likely cause | Where |
|---|---|---|
| First request to a new host hangs ~5 s | cert minting with the LibreSSL settle | `net/ca.ts:33-45,108` |
| Fans spin / UI feels busy with a project page open | telemetry fan-out (`stats`, `df`, `du`, `git status`) | §4.2 |
| Create/rebuild takes ~1 s+ on a Mac | ~14 sequential `container exec`s at ~90 ms | §4.1.1, §4.3 |
| Page load through a forward is slow; many `bun` processes in the VM | one exec + one Bun process per connection | §4.5 |
| Editor crawls in a repo with `node_modules` | `git status --ignored` every 5 s + per-tab blob reads | §4.6 |
| Creating from a large repo uses GBs of RAM | whole tar buffered in host memory | §4.3 |
| Activity page gets slower over days | `events`/`net_requests` growth, unindexed queries | §4.7 |
| Terminal sluggish under heavy output | xterm DOM renderer, no WebGL, no backpressure | §4.8 |
| Remote/LAN UI slow to load | no compression or cache headers; 489 KB xterm per tab | §4.7 |

---

## 4. Findings

### 4.1 Guest control plane and drivers

#### 4.1.1 The macOS exec tax

`driver/container.ts:330-333` runs every guest command as a new `container exec`
process. `spikes/e-cloud-hypervisor/README.md:111` measures ≈90 ms per exec, and
0.1–0.3 s is typical once the CLI, the apiserver and vminitd are involved.
`driver/agent.ts` already implements the fast path (one vsock/unix connection
per operation, ~1.7 ms p50) for KVM and vz. Apple silicon, the most common
platform, is the only one paying the CLI tax.

Consequences:

- Every probe, branch lookup, `df`, editor git status and vault/login write on
  an Apple-silicon Mac is ~50× more expensive than it needs to be.
- A create chain of ~14 sequential execs (`core/projects.ts:332-512`) pays
  ~1.3 s of pure round-trip overhead before any real work.
- The same code (agent protocol, guest image) already exists; the container
  driver publishes a unix socket for the proxy relay (`container.ts:196-201`,
  `--publish-socket`), so the mechanism to reach an in-guest agent exists.

**Opportunity (P0, architectural but in-stack):** bake `sadbox-agent` into the
macOS base image and publish its socket (or use vsock if Apple's runtime exposes
it), then route `exec`/`stream`/`terminal` through the agent exactly as the KVM
driver does. Keep `container` for create/start/stop/destroy/images. Expected:
guest ops from ~90–300 ms to ~2–10 ms.

#### 4.1.2 Exec is not pooled, and its buffering is quadratic

- One connection per operation is intentional (`driver/agent.ts:5-7`), but there
  is no pooling or pipelining. At 1.7 ms this is fine; on macOS it compounds the
  CLI cost.
- `readFrames` reassembles with `buf = Buffer.concat([buf, d])` on every chunk
  (`agent.ts:89-98`). For bulk reads — sync bundles, `copyOutHistory` tars,
  editor file reads — this is O(n²) memcpy: a 100 MB payload over 64 KB chunks
  moves several GB of memory. Use a chunk list and one concat.
- `agentClient.request()` leaks the socket if the timeout fires before `dial()`
  resolves (`agent.ts:231-247`): `s` is still `undefined` in `finally`, and the
  socket that arrives later is handed to `readFrames` and never destroyed.
- `waitForAgent` retries every **20 ms** with no backoff (`agent.ts:354-365`).
  On vz, `unixSocket()` fails instantly while vfkit has not created the socket,
  so a boot can spin ~3 000 connect attempts in 60 s (`vz/index.ts:42`), while
  the announcement listener is already armed.

#### 4.1.3 Synchronous work on the event loop

- `vz/index.ts:64-84`: `vmmPids()` runs `Bun.spawnSync(["ps","-axww",…])` and was
  measured at **60–190 ms** per call. It runs on `boot`, `stop`, `destroy`
  (twice) and error cleanup. Every one freezes the HTTP API, proxy, SSE and
  terminals for that long. Use the pid file plus `/proc`/`libproc`, or an async
  `ps` with a cached scan.
- `vz/index.ts:240-245`: `cpuUsec()` runs `Bun.spawnSync(["ps","-p",…])` on
  every stats sample — i.e. several times a minute per open page. Read CPU time
  from the VMM's process info without blocking (`/proc` on Linux; `proc_pidinfo`
  or async `ps` on macOS).
- `core/history.ts:147`: `Bun.spawnSync(["tar",…])` on destroy (rare, acceptable,
  but the same pattern).

#### 4.1.4 Boot and lifecycle serialization

- Mount replay after boot is sequential (`vz/index.ts:204-206`,
  `kvm/index.ts:174-176`): one round trip per history spot (**7** when shared
  mounts are available). `Promise.all`.
- `startProject` polls with an exec every 500 ms, up to 30 times
  (`core/projects.ts:1124-1128`), although `driver.start` already waited for the
  agent. One `ping` would do.
- KVM boot starts one virtiofsd per share and waits sequentially
  (`kvm/index.ts:142-145`); on boot failure only the VMM is killed, orphaning
  virtiofsd processes (`kvm/index.ts:163-168`).
- Disk clone on ext4 is a full 2.3 GB copy (~7 s) before boot
  (`driver/vm.ts:82-90`). APFS/btrfs reflink is instant. The TODO already names
  qcow2/overlay as the fix (`docs/TODO.md:82-86`).

### 4.2 Telemetry: the dominant steady-state cost

This is the most valuable area to fix, and the fixes are small.

#### 4.2.1 `/api/projects` does O(N) guest execs every 5 s

`projectsWithLiveState()` (`core/projects.ts:1256-1281`) calls `driver.list()`
and then `liveBranch()` for every running project. `liveBranch`'s TTL is
**5000 ms** (`projects.ts:1229`), exactly the UI poll interval, so the cache is
expired on nearly every tick: **one `container exec git rev-parse` per project
per poll**, times two calls per tick (cards + nav tree), times every open tab.

At 10 projects and two tabs that is ~8 execs/second forever, to keep a branch
label current. The branch changes only when the user or agent changes it; a
30–60 s TTL, or invalidation on `switchBranch`/`git` events, removes it entirely.

`settle()` is also called twice per row (`1256-1267`) and can write the DB, log
an event, or even trigger `startProject()` from a GET. `hasGitToken(r)` runs a
three-table join **per project** on the same poll (`gittoken.ts:113-123`), and
`driver.list()` is repeated by `serviceStatus()` on vz/kvm (`vz/index.ts:256`),
so the home page fetches the VM list twice every 5 s. Batch `hasGitToken` into
one query for all rows.

#### 4.2.2 `/resources` every 1.5 s: stats + a separate `df` exec

`projectResources()` (`projects.ts:677-719`) does:

1. `driver.inspect()` — a `container inspect` spawn on macOS;
2. `liveStats()` — `container stats --no-stream`, **1–2 s per call**;
3. a separate `df -B1` exec, duplicating the `df` that `GUEST_PROBE` already runs.

`liveStats()` starts a new sample on every call with no minimum interval
(`vitals.ts:74-83`). With the 1.5 s resources poll and the 4 s details poll, the
macOS driver's `container stats` runs at essentially continuous duty cycle for
as long as a detail page is open. On vz/kvm the stats exec also forks `grep`,
`awk`, `ls` and `wc` in the guest (`kvm/index.ts:330-334`), plus — on vz — a
blocking `ps` spawn (`vz/index.ts:402` → `240-245`).

Fix: a per-ref sampling floor (~3–5 s), a cached `inspect` (2–5 s TTL), fold
`df` into the stats exec or reuse the sampler's last sample, and on macOS derive
CPU from `/proc/stat` in the guest instead of `container stats` (one 90 ms exec
instead of a 1–2 s CLI call, and more accurate).

#### 4.2.3 `/details` every 4 s: a whole-workdir scan

`GUEST_PROBE` (`projects.ts:628-641`) includes:

```sh
du -sb ~/workdir                       # O(all files)
git status --porcelain | wc -l         # O(repo)
tmux list-sessions / -windows / -clients
df -B1 ~/workdir
```

`du` and `git status` are scans of the entire project (with `node_modules`,
tens of thousands of paths). They run every 4 s per open detail page, with an
8 s cap, and **self-amplify**: if the probe times out, the UI immediately
re-fetches `/details` after 1 s (`web/app.js:2019-2022`), so the busiest VM gets
probed the hardest. This is the worst pathological loop in the codebase.

`vm-warn.js` fetches the **same heavy `/details`** every 15 s from every terminal
and editor tab, only to read CPU/memory (`web/vm-warn.js:54-85`). Three open
terminal tabs = three whole-workdir scans every 15 s.

Fix: split the endpoint. Fast/cached fields (state, CPU, memory) at 1–3 s from a
cheap source; slow fields (`du`, `git status`, tmux) cached ≥30 s or computed
on demand; have `vm-warn` call `/resources`; drop the 1 s retry for
`probeIncomplete`.

#### 4.2.4 Background loops also hit every VM

- Resource sampler: every 30 s, `Promise.allSettled` over all running projects,
  each doing `inspect` + stats + `df` (`projects.ts:729-748`). No jitter, no
  concurrency cap; one global `busy` flag. On macOS that is N × 1–2 s of
  `container stats` every 30 s; with 10 VMs the sampler alone keeps the
  container service busy.
- Login capture: every 30 s, sequentially over all running VMs, runs a
  `bun run -` script that reads credentials and opens omp's SQLite DB
  (`core/logins.ts:246-265`, `151-202`). Per VM that is an exec + a Bun start
  (~100 ms+) every 30 s, even when nothing has changed.
- Toolchain probe: 11 version commands (including sourcing `nvm.sh`) every
  5 min per VM (`vitals.ts:99-111`, `toolchain.ts:32-40`). Properly cached, but
  worth reducing to the few tools that change.

### 4.3 VM lifecycle (create / rebuild / start / stop)

Create is well structured but **serialized**. `provisionVM`
(`projects.ts:332-512`) performs roughly 14 sequential guest round trips for an
empty project, and more with apps:

`chown` → `linkHistory` (2) → `installGuestProxy` (CA + tools + relay + net.env:
4) → `injectVault` → tar extract → env-file marking → git config → shell hooks
→ remote config → `apt-get update` + one `apt-get install` **per package** →
optional apps (2 each, sequential) → logins → tmux.

Each step is a separate exec/connection. Several are independent and could be
one shell script (chown, history ownership/links, shell hooks, net.env, vault
write). `apt-get install` should take all packages in one command. Optional-app
installs could run concurrently (with a lock).

Other lifecycle costs:

- `resolveImage`/`ensureBaseImage` re-reads and re-hashes the embedded recipe
  and runs `container image inspect` on **every** create/rebuild
  (`core/baseimage.ts:15-51`, `projects.ts:102-112`, `108-110`). Cache the hash
  per process and the image probe briefly.
- **Copy-in buffers the entire archive in host RAM, including `.git`**
  (`projects.ts:144-153`). A 1 GB `.git` means ≥1 GB RAM per concurrent
  create/rebuild, plus the same bytes over the wire and into the guest. No
  compression. Plain folders (and repos with no commit) are copied with
  `readdirSync` + a synchronous `lstatSync` per entry and **ignore `.gitignore`
  entirely** (`projects.ts:133-137`), so `node_modules`/`dist` go into the VM.
- **Push reads and hashes every byte on both sides on every click**
  (`core/push.ts:76-92`): a host `git hash-object` over every file, then a guest
  probe that hashes every file again (`push.ts:54-58`), before the by-content
  diff. Unchanged pushes still cost 2× repo size in reads.
- **History is 7 separate virtiofs shares** (one per spot, `history.ts:41-52`),
  so KVM starts 7 `virtiofsd` processes and both KVM and vz replay **7
  sequential mounts** on every boot (`kvm/index.ts:141-145,174-176`,
  `vz/index.ts:160-161,204-206`). One shared root would cut that to one.
- `historyOf(name)` recursively `lstat`s the whole history store on **every
  create** (`projects.ts:599` → `history.ts:199-239`), and `listHistory()` does
  it for every project on `/api/agents` and `/api/history`. Cache sizes by
  mtime/TTL.
- The base image is built in five unpinned network layers (Bun, Claude, omp,
  opencode, Node/nvm — `images/base/Dockerfile:21-41`), so changing an early
  layer re-downloads all of them. The disk build copies the whole rootfs with
  `mkfs.ext4 -d` (`images/disk/Dockerfile:33-39`).
- `cloneDisk` uses `cp --reflink=auto` / APFS clonefile (`driver/vm.ts:82-90`).
  Where reflink is unsupported (a Docker volume on ext4/overlay), it silently
  becomes a full byte copy of the 2 GB base disk **per create/rebuild**.
- `baseImageToolchain()` checks its 10-minute cache **after**
  `resolveBaseImage()`, which runs up to three `container image inspect` spawns
  even on a cache hit (`toolchain.ts:85-99`).

Recorded lifecycle numbers (vz): create 0.46–0.99 s, start 0.42–0.92 s,
stop 0.05–0.10 s. The provisioning chain's ~14 execs at 90 ms on Apple silicon
is mostly invisible because it overlaps the boot; with the fast agent it becomes
nearly free.

### 4.4 Egress proxy (`src/net/proxy.ts`)

Every isolated VM (the default) has no NIC; its only route out is the proxy. So
the proxy is on the critical path of every agent action (model calls, npm, git,
package installs).

Per HTTPS request today:

1. **DNS lookup per request.** `resolveTarget` calls `dns.lookup(..., {all:true})`
   (`proxy.ts:141-158`) with no cache. This is the deliberate resolve-then-connect
   defence (classify the address, then connect to the same address). A TTL cache
   of (host → address, reach) preserves that property exactly: the check and the
   connection use the same cached address. 30–60 s TTL plus negative caching.
2. **Rule evaluation with fresh SQL.** `evaluate()` selects all `net_rules` on
   **every request** (`rules.ts:215-237`) and, when no rule matches, runs the
   `vaultRules()` join (`rules.ts:234`). `applyHeaders()` selects all header rules
   per request **and per response** (`rules.ts:241-270`), decrypting secret-backed
   values each time.
3. **Credential metadata and decryption per request/response.**
   `substituteRequest` loads `projectCredentials()` (secret rows + Claude login,
   decrypting the login) per request (`credentials.ts:69-85`, `109-118`).
   `redactResponse` calls `redactable()`, which decrypts **every** proxy secret
   for **every** response, even when there is no body and nothing to redact
   (`credentials.ts:197-219`). `bodyRedactor` repeats the decrypt for streamed
   bodies (`credentials.ts:226-264`).
4. **A TLS server per hostname, with a loopback hop.** Bun's `SNICallback` was
   broken, so `serverForHost` creates one `https.Server` + loopback listener per
   host and keeps it forever in `hostServers` (`proxy.ts:442-457`), and every
   CONNECT is spliced through a fresh loopback TCP connection
   (`proxy.ts:459-469`). This works and is proven, but it is an extra copy of
   every byte and an unbounded map of listeners/certs.
5. **Certificate minting on first use — with a 5 s stall on stock macOS.**
   `mintCert` runs `openssl x509 -req` and, when `-not_before` is unavailable
   (LibreSSL is macOS's `/usr/bin/openssl`), waits `SETTLE_MS = 5000` before
   returning (`ca.ts:33-45`, `93-110`). The first HTTPS request to any **new
   host** therefore blocks ~5 s. This is very visible on a fresh project (first
   `git clone`, first API call to a new domain) and is pure lost time.
   Certs are cached per host **in memory only** (`ca.ts:80-91`); the minted
   `.leaf-<host>.crt` is written to disk (`ca.ts:96`) but never read back, so
   **every supervisor restart pays the 5 s again for each host**. There is no
   warm-up and no eviction.
6. **`networkInterfaces()` on every lookup.** `ownAddresses()` is called inside
   `classifyAddress` for every resolution (measured ~58 µs), and resolution
   happens *before* `evaluate`, so even a request a block rule would refuse pays
   DNS + the interface scan (`proxy.ts:150`, `269-272`). Evaluate rules first;
   only resolve for allow/ask; cache `ownAddresses()` for ~30 s.
7. **`projectForIp` thundering herd on the legacy TCP path.** Once `ipMapAt` is
   older than 3 s, every concurrent request awaits its own `refreshIpMap()`, and
   each refresh spawns `container list --all --format json`
   (`proxy.ts:52-74`, `container.ts:295-306`). A burst of N requests can mean N
   CLI spawns; a miss triggers a second refresh. Single-flight the refresh,
   lengthen the TTL, and record the VM→IP mapping at create/start instead of
   rediscovering it. (Carrier traffic carries `knownProject` and skips this.)
8. **Upstream pooling is implicit.** Verified for Bun 1.4.4: the global agent
   has `keepAlive: true`, LIFO, `timeout: 5000`, `maxSockets: Infinity`, so
   reuse does happen. But (a) an origin idle for >5 s gets a new TLS handshake;
   (b) the pool is keyed by the **resolved IP**, so round-robin DNS or address
   flapping splits it; (c) a stale reused socket is not retried — `up.on("error")`
   just returns 502 (`proxy.ts:414-421`). Set an explicit agent with a longer
   keep-alive, and retry an idempotent request once on a fresh connection.
9. **Query count and decryption, not compilation.** Measured execute cost is
   sub-microsecond (`db.query()` ≈0.40 µs vs a hoisted statement ≈0.31 µs); a
   true cache miss adds a prepare (tens of µs), but with **10–16 synchronous
   SQLite queries per allowed request** the count dominates. Several of them
   re-query and re-decrypt the same secrets: `substituteRequest`,
   `swapsBodies`, `redactResponse` and `bodyRedactor` each rebuild
   `projectCredentials()` (`credentials.ts:69-85`, `123-125`, `197-219`,
   `226-264`), and `loginCredentials()` decrypts the Claude login every time
   (`claudeoauth.ts:109-119`). Memoize per project **for the duration of one
   request**, skip the redaction machinery when the project has no redactable
   secrets, and keep decryption where it is. Raising
   `MAX_QUERY_CACHE_SIZE`/hoisting hot statements is cheap hygiene, not a win.
10. **Logging is well designed** — a 500-entry ring, a live publish, and a
    batched insert per second (`net/events.ts:59-120`). Keep it, but: the 500-row
    ring does `splice(0, …)` per request (`events.ts:63`), each SSE subscriber
    re-stringifies every event (`events.ts:53-57`, `api/http.ts:46-48`), and
    terminal pages subscribe to the full stream just for approvals
    (`web/net-asks.js:106`). The flush is one synchronous transaction (measured
    ~35 ms for 20 k rows) and the hourly prune is one unbounded `DELETE` on the
    event loop (`events.ts:104-120`, `182-185`). Chunk the prune, cap the queue,
    and publish pre-encoded bytes once. `hostSummary()` (7-day Activity) runs
    `GROUP BY host` plus a correlated subquery per host over up to a week of
    rows (measured ~6.3 ms at 20 k rows, ~300 ms at 1 M) and is refreshed at most
    every 5 s while the Activity tab is open; maintain incremental per-host
    counters or a rollup table.
11. **`ctxByPort` is keyed only by the loopback source port** (`proxy.ts:80`,
    `218`, `461`) while several per-host servers listen on different loopback
    ports; two simultaneous connections to different host servers can share a
    source port and be attributed to the wrong project/host. Key on the socket
    object (WeakMap) or `remoteAddress:remotePort`. This is a correctness risk,
    not a speed one.

The **request/response body redaction** is necessarily per-request (it must see
the bytes), but it is only active when the project has proxy secrets and the
content type is textual (`proxy.ts:386-392`). The expensive part is the
*decryption and DB reads before knowing whether anything matches*.

### 4.5 Port forwards, named routes, project links

All three carry a connection into the guest with the same primitive:

```ts
// forwards.ts:80
tunnel = driver.stream(ref, guestConnectCmd(guestPort));  // exec + `bun connect.js` in the guest
```

So **every TCP connection** to a forwarded port, named route or project link:

- starts an exec into the VM (90 ms+ on macOS),
- starts a **Bun process in the guest** (`net/guest.ts:60-86`), and
- pipes the bytes over that process's stdin/stdout.

A page load with 6 parallel connections = 6 execs + 6 Bun processes; a Vite/HMR
WebSocket is another; a project-to-project API call is another (and links force
`Connection: close` per HTTP request, `links.ts:221`, so every request gets a new
process). The sign-in gate keeps an HTTP agent with keep-alive for ordinary
forwarded HTTP (`httpgate.ts:82-85`), which mitigates the steady state, but not
page loads, WebSockets or links. A named-route request also pays three
synchronous queries before any bytes move — resolve the route, check `isOpen`,
and validate the pass (`routes.ts:113,155`, `auth.ts:128-136`) — and these are
hot for every asset in a page. Backpressure is absent across the family:
`tunnel.onData(c => client.write(c))` and `client.on("data", … tunnel.write)`
ignore the return value (`forwards.ts:68,81`, `links.ts:167,183`,
`container.ts:352`), and there is no cap on concurrent bridges per project.

**Opportunity (P0/P1):** one persistent per-VM relay, like the proxy's
`relay.js` carrier model: the guest relay accepts a target (port) header and
splices, the host keeps a few carriers dialed in, and no process is spawned per
connection. For vsock drivers, a small range of host→guest vsock ports could map
to guest ports directly. Expected: per-connection overhead ≈100 ms + ~50 ms Bun
start → ~1 ms.

Also: named routes are bound to `SADBOX_ROUTE_DOMAIN`; when a route is created,
the VM is told about it (`syncProjectRouteHosts`). That path is fine.

### 4.6 Files, editor, sync, history

**Editor operations are exec-per-request** (`core/files.ts`): list dir, read,
head, stage, commit, stash, branch — each is one `container exec`/agent exec,
which is fine at 1.7 ms and acceptable at 90 ms for a human click. The polling is
the problem:

- Editor polls `/files/status` **every 5 s while visible** (`web/editor.html:1120-1123`).
  `gitStatus()` runs `git status --porcelain --ignored` over the whole workdir
  (`files.ts:108-155`). With `node_modules` present, `--ignored` enumerates tens
  of thousands of paths; this can take seconds in the guest, every 5 s, while an
  agent is working.
- On any status change, `loadGit()` calls `loadBase(t)` for **every open tab**
  (`editor.html:992`), each a `/file/head` request returning up to **two** 2 MB
  blobs (`files.ts:188-221`). Ten tabs = tens of MB every 5 s under agent churn.
- `refreshTree()` re-reads every expanded folder (`/files?path=`), each an exec,
  and re-runs all of them whenever status changes (`editor.html:1040-1046`).
- Quick-open re-indexes the whole workdir on every ⌘P (`editor.html:1175`,
  `files.ts:77-93`) instead of caching for a few seconds. The index is unbounded
  at the source (`git ls-files -co` over a 1M-file repo transfers everything,
  then caps at 20k), and the non-repo branch runs `find … -exec test -e {}/.git`
  — **one process per directory** (`files.ts:81-85`).
- `checkDisk` re-reads the whole file (up to 2 MB) on every tab activation and
  window focus (`editor.html:646,712-724`), and `readFile` decodes and hashes
  the bytes again on the host (`files.ts:158-178`).
- `stageFile` sends the **whole file** for a single-hunk stage
  (`files.ts:237,251`), and `writeFile` SHA-256s the existing file even when
  `force` makes the answer irrelevant (`files.ts:521`).

Fix: status on a 10–15 s cadence (or on demand/invalidation), drop `--ignored`
for the colour pass (use `.gitignore` knowledge or `git status` without ignored
unless the user asks), fetch HEAD blobs lazily per active tab and cache by blob
oid, cache `/files/index` for ~10 s, limit the index at the source, and skip the
pre-write hash when `expect = any`.

**Sync** (`core/sync.ts`) is well designed: a throwaway-index snapshot commit,
an incremental `git bundle` over exec, a private mirror repo, then `read-tree -m
-u` into the folder. Costs are proportional to the change set, not the repo, in
the normal case. Caveats:

- The snapshot runs `git add -A` over the whole workdir (`sync.ts:72-87`), which
  stats every file; on a huge tree this is seconds (but it is user-initiated and
  not on a timer).
- The planning step lists the **entire index** (`git ls-files -s -z`) and, when
  the folder is a repo, the **entire `HEAD` tree** (`git ls-tree -r -z HEAD`),
  then builds two maps of every path (`sync.ts:123-141`, `93-103`) — O(files)
  per sync even when one file changed. Restrict `ls-tree` to the `touched` paths
  via a pathspec file.
- `driver.execCaptureBytes` buffers the whole bundle in memory and its frame
  reassembly is O(n²) (§4.1.2), then writes it to a temp file for `git fetch`
  and deletes it (`sync.ts:185-199`). Fine for small incremental bundles; stream
  the bundle to disk (or `git index-pack --stdin`) and fix the buffer before
  large ones.
- The host side spawns ~13–18 sequential `git` processes per sync, and
  `hostGit` has no timeout (`sync.ts:42-53`), unlike the guest side.

**History** copy-out happens only on destroy/rebuild for old VMs
(`history.ts:128-176`) and is a one-off. The size walks are not: `historyOf()`
recursively `lstat`s a whole store on **every create** (`projects.ts:599`) and
`listHistory()` does it for every project on `/api/agents` and `/api/history`
(§4.3); cache sizes by mtime/TTL.

### 4.7 SQLite, API server and startup

- **WAL is on, `synchronous` is not.** `db.ts:7-8` sets `journal_mode = WAL` and
  `foreign_keys = ON` only. SQLite's default is `synchronous = FULL`, so every
  commit fsyncs. `logOutput()` (`projects.ts:249-256`) inserts **one row per log
  line**, up to 500 lines per command, outside a transaction — up to 500 WAL
  commits/fsyncs for a verbose create step. Set `PRAGMA synchronous = NORMAL`
  and wrap multi-line logs in one transaction (or insert a batch).
- **Query cache thrash is real but small.** Bun caches 20 compiled statements
  and the codebase has ~220–240 distinct SQL strings, so hot statements are
  recompiled often. Measured execute cost is sub-microsecond and a cache miss
  adds only a prepare, so this is hygiene, not a bottleneck: raising
  `Database.MAX_QUERY_CACHE_SIZE` in `db.ts` or hoisting the ~20 hottest
  statements is cheap, but the win is elsewhere (query count).
- **Unbounded, unindexed `events`.** No index on `(project_id, id)` and no
  pruning; `destroyProject` never deletes them. `projectEvents()` filters by
  `project_id` and `id > ?` and the tail form sorts by `id` (`projects.ts:223-232`),
  which degrades to a scan as the table grows (create logs add hundreds of rows
  per project). `logOutput` adds up to 500 rows × 8 KB per provisioning step.
  Add the index and a retention policy (30 days or N per project).
- **Missing indexes on lookups that run per item/request:**
  `project_secrets(secret_id)` and `vault_fetch_grants(secret_id)` (vault views
  query by secret), `port_forwards(project_id)`, `forward_sessions(forward_id)`,
  `project_links(to_project)` (`db.ts:134,235,345-352,379-385,427-435`). Small
  tables today; they grow with use.
- **Vault N+1.** `listItems()` calls `view()` per item, and each does
  `listBindings` + `projectsOf` + `listFetchGrants` (`vault.ts:89-113`), so
  `GET /api/vault` (loaded on every UI boot, `app.js:3168`) is 3N queries.
  `projectVaultView()` repeats it (`vault.ts:326-337`). Use three bulk queries
  and group in memory.
- **`resource_samples` has a redundant index**: the composite primary key
  already covers `(project_id, ts)`, and a second identical index is created
  (`db.ts:327-340`). Drop one; the hourly prune filters on `ts` alone
  (`resources.ts:29-33`), which has no index, so it scans the table.
- **Migrations run as unversioned side effects on import**: ~30 DDL statements,
  each its own commit, ~25 `PRAGMA table_info` calls, and `migrateToVault()` —
  a correlated `DELETE … EXISTS` plus a full `UPDATE secrets` — on **every**
  boot (`db.ts:10-185`). Gate with `PRAGMA user_version` and wrap the DDL in one
  transaction.
- **Static responses have no caching or compression.** `api/http.ts:576-578`
  returns `new Response(Bun.file(...), { headers: { "content-type" } })` for
  `/app.js` (152 KB), `/style.css` (45 KB), `/index.html` (40 KB),
  `/vendor/xterm.js` (**488 KB**), `/editor.html` (67 KB), HTML pages, etc. No
  `Cache-Control`, `ETag`, `Last-Modified`; no gzip/brotli. Only `/vendor/ace/*`
  gets `max-age=3600` (`http.ts:571`). Every navigation re-downloads the UI and
  every terminal tab re-downloads xterm; over a LAN/Tailscale that is the
  dominant page-load cost. Add `no-cache` + ETag (or content-hashed URLs) and
  compression; `immutable` for vendor files.
- **`/api/projects` ships every column** including `git_token_enc` and the raw
  `apps` JSON (`projects.ts:189-192`, `1278`), several times per minute per tab.
  Select only the fields the UI uses.
- **`/api/fs/dirs` does a synchronous per-child stat storm**: `readdirSync` +
  `statSync` + one `existsSync(.git)` per directory (`http.ts:450-459`), on the
  event loop, with no result cap.
- **Long-running handlers hold the HTTP connection** for the whole operation:
  create (includes image resolve and provisioning), rebuild, sync, push,
  start/stop, vault POST/PATCH (which reinjects into every running VM
  sequentially), and `/api/agents/apply` (`http.ts:167-178,227-241,486,520-548`).
  There is no 202/job model even though the `events` table already carries
  progress. `/api/agents/claude/refresh` calls an outbound `fetch` with no
  timeout (`claudeoauth.ts:171-190`).
- **`signedIn` does SHA-256 + a DB lookup per API request** (`auth.ts:83-88`);
  cheap, but an in-memory token→expiry map invalidated on logout/password change
  removes a query from every poll.
- **SSE has no backpressure**: `netStream` enqueues without checking
  `desiredSize` (`http.ts:44-58`), so a stalled reader accumulates strings; each
  subscriber re-stringifies every event.
- **Startup is not free**: the DDL/`migrateToVault` work above runs on every
  boot, `startRequestLog()` runs `pruneRequests()` immediately (a potentially
  large `DELETE`), and `startResourceSampler()` runs its first tick at once —
  `inspect` + `stats` + `df` for every running VM in a burst. Delay the first
  sampler tick a few seconds and chunk the prune.

### 4.8 Frontend (`web/`)

The vanilla-JS approach is a reasonable trade-off (no build step, one file), but
its rendering strategy and polling amplify the server costs:

- **Full `innerHTML` replacement** on every poll: the project cards every 5 s,
  the whole detail stats/actions panel every 4 s, the resource chart buttons
  every 1.5 s, the sidebar every 5 s, and the whole network table on (rAF-batched)
  request events. This destroys focus/selection/scroll state and burns CPU.
  `paintResourceGraph` also redraws four canvases on every `pointermove`
  (`app.js:1956-1960`) — 240–480 redraws/s on a fast mouse.
- **No `visibilityState` pause** in the main app (`app.js:1973`, `1990`, `3169`,
  `3173`); background tabs keep polling. Only `vm-warn.js` and the editor check
  visibility.
- **Duplicate `/api/projects` calls**: the nav tree fetches it every 5 s, and
  `refreshProjects` fetches it again on the projects view. `route()`,
  `refreshVault()`, `openItemDialog` and `openLinks` also fetch it. A shared
  2–5 s cache (or one store) collapses these.
- **No in-flight guard / stale-response guard** on `renderDetail`: a slow
  response for project A can paint after the user opened B. Server-side
  `detailsInFlight` dedupes only identical concurrent calls.
- **Network panel**: each request event rebuilds a table of up to 500 rows plus
  all paged-in history; the filter is un-debounced and re-aggregates on every
  keystroke (`app.js:2819-2845`, `3098`). `netModel.older` grows without bound.
  Every terminal tab also runs `net-asks.js`, which opens a **second** SSE
  subscription to the same stream and ticks a **1 s** interval forever
  (`net-asks.js:80,106`) even when there are no approvals.
- **Create/destroy progress**: a 600–700 ms recursive poll plus a 500 ms clock
  tick, and the log is appended as `textContent +=` with no cap
  (`app.js:1143-1184`, `1276-1305`) — O(n²) string growth for a verbose image
  build/apt install, and the pollers are not cleaned up if the user navigates
  away mid-create.
- **Opening a detail view fires ~9 requests at once** (details, resources,
  routes, forwards, links, two vault/projects refreshes, nav tree, tools/latest),
  and `paintDetail` re-serialises the stats and tools panels in full every 4 s
  (`app.js:2224-2281`, `2136-2141`).
- **Terminal**: xterm without the WebGL addon (DOM renderer), no explicit
  scrollback, no `ResizeObserver` (only window resize), no auto-reconnect, and
  no WebSocket backpressure check (`ws.send(chunk)` in `api/http.ts:600`) — a
  slow client under `yes`/heavy build output can grow the socket buffer.
- **Editor**: `useWorker: false`, a full-file Myers diff on every typing pause
  (up to ~18 MB of transient allocation per diff at the 1,500-edit cap), and
  per-keystroke re-renders of the commit list/palette/branch list
  (`editor.html:818-886`, `571`, `1159-1160`).
- **Assets**: ~500 KB of Ace (`ace.js` 475 KB + three others) loaded as four
  blocking `<script>` tags before the editor can paint (`editor.html:270-273`),
  `xterm.js` 488 KB per terminal tab, `app.js` 152 KB, `style.css` 45 KB — all
  uncached and uncompressed (§4.7). The 40 KB Help text is embedded in
  `index.html` even when hidden.

### 4.9 Cross-cutting

- **Single event loop, but mostly I/O-bound.** Bun handles the load at tens of
  VMs. The synchronous calls that *do* block it are `Bun.spawnSync` in the vz
  driver (`ps`) and `history.ts` (tar), plus sync `fs` reads in request paths
  (`auth.ts` password check, `ca.ts` on start, `settings`/DB are sync but fast).
  Fix the `ps` calls; the rest are negligible.
- **The guest agent does per-exec work that could be cached**: `lookupUser`
  re-reads `/etc/passwd` and the user's groups on every exec (and reads
  `/etc/passwd` a second time for the shell), `lookPath` stats PATH entries, and
  every non-PTY exec allocates two 128 KiB pump buffers (`exec.go:71-99`,
  `154-171`, `226-239`; `proto.go:104-123`). At 1.7 ms/exec the cost is masked,
  but under the telemetry load it is pure waste; cache the account and pool the
  buffers.
- **Agent output is copied 3–4 times on the host** (`Buffer.from` per chunk,
  `Buffer.concat`, `toString`, then a re-encode), which matters for bulk reads,
  sync bundles and history copy-out (`agent.ts:249-259`, `282-291`).
- **Fixed sleeps**: boot readiness (500 ms × 30), `allGone`/`exitedWithin` (50 ms),
  `settledOff` (100/400 ms), relay wait (50 × 100 ms). Fine individually; the
  hung-VM path is intentionally slow.
- **Leaks/unbounded maps**: `branchAsked` (`projects.ts:1230`), `lastRecorded`
  (`resources.ts:26`), `installed` (`net/guest.ts:143`), `hostServers`/`certCache`
  (`proxy.ts:442`, `ca.ts:80`) are never pruned on destroy/rebuild.
  `destroyProject` computes `forgetVitals(refFor(getProject(id)?.name ?? ""))`
  (`projects.ts:999`), which on a missing row forgets the key `"sadbox-"` and
  leaks the real entry.
- **Orphaned children**: `container`'s `orTimeout` SIGKILLs the CLI but not the
  runtime's children (`container.ts:23-25`); kvm boot failure leaves virtiofsd
  running (§4.1.4).

---

## 5. Is the stack sufficient? Layer-by-layer

| Layer | Verdict | Headroom | When it stops being enough | In-stack path forward |
|---|---|---|---|---|
| **Bun runtime** | ✅ Sufficient | High. Tens of I/O-bound VMs, hundreds of req/s | A single event loop saturating under very high proxy throughput or many TLS handshakes | Move the proxy data plane to a `Worker` (Bun supports workers) and keep control plane in the main thread. Not needed today. |
| **Bun.serve API** | ✅ Sufficient | Very high (~160k req/s simple) | Not the bottleneck | Add caching/compression, route table (`routes:`) if desired. |
| **node:http proxy** | ✅ Sufficient, ⚠️ unoptimized | Medium | Sustained multi-hundred req/s across many VMs | Upstream keep-alive is already on (Bun global agent); add DNS/rule/credential caches, bound per-host servers, and move the data plane to a worker only if measured CPU saturates. |
| **SQLite (bun:sqlite)** | ✅ Sufficient | High for single-user | Multi-million-row `net_requests`/`events`, heavy write bursts (one connection, sync API) | `synchronous=NORMAL`, indexes, batched writes, retention/rollup; collapse the vault N+1. Litestream still optional. |
| **Vanilla JS UI** | ✅ Sufficient | Medium | Many tabs / very large Activity tables | Poll coordinator + in-place DOM updates + caching; no framework required. |
| **MicroVM drivers** | ✅ Right abstraction, ⚠️ Apple path slow | High after agent | Hundreds of VMs per host (not the target) | Use the existing agent over a published socket on macOS; qcow2 overlays on ext4. |
| **Go guest agent** | ✅ Sufficient and fast | High | Bulk transfers (fix O(n²) reassembly) | Keep; add multiplexing for forwards if desired. |
| **Per-connection guest Bun** | ❌ Wrong shape for forwards | Low | Any real page load through a forward | Persistent relay/carrier model (already used by the proxy relay). |

**Would Go/Rust help?** Only for the proxy data plane at sustained high
throughput, and only if measurements show the Bun loop saturating. The measured
bottlenecks today are *redundant work* and a *90 ms CLI*, not JavaScript
throughput. Building a second service now would add operational surface for no
demonstrated gain. The driver/agent boundary already provides the escape hatch.

**Would a framework (React/Svelte) help?** Not materially. The renders are small
except the Activity table; a 20-line poll coordinator and targeted DOM updates
solve it. A build step would cost the current zero-build simplicity.

**Scaling envelope.** After the P0 fixes, a 32–64 GB host with 1–10 projects and
a handful of browser tabs is comfortable: telemetry drops below a few percent of
a core, guest work is the agent's, and the proxy handles normal agent traffic
without tuning. At ~25–50 projects, revisit three things: run the proxy (and
forwards) on a `Worker` if CPU or handshake latency shows up, roll up
`net_requests`/`events` instead of querying raw rows, and make telemetry push-based
(SSE per project) rather than per-tab polling. Beyond that — hundreds of VMs, or
multiple users — the product changes shape (multi-tenant auth, per-tenant data,
a sharded data plane) and *then* a Go/Rust data plane or Postgres would be
justified. That is not the current target.

**What would justify changing the stack?** Only measurements: (a) the proxy
sustaining >60 % of a core at the expected peak after caching, (b) a need for
100+ concurrently active VMs on one host, (c) multi-user/multi-tenant
requirements, or (d) a native Windows (WHP) driver that Bun cannot host. None of
these is true today; the driver/agent boundary and the worker-thread escape
hatch cover (a) and (b) without a rewrite.

---

## 6. Recommendations, in order

Effort: S (<1 day), M (1–3 days), L (a week+). Impact is on perceived
responsiveness, supervisor CPU and guest CPU stolen from the agent.

**At a glance:**

| # | Change | Effort | Impact |
|---|---|---|---|
| 1 | Telemetry TTLs + split `/details` + stats floor | S | Very high — one page 230 → <20 ops/min |
| 2 | Fast guest agent on Apple silicon | L | Very high on macOS — ~50× per guest op |
| 3 | Persistent relay for forwards/routes/links | M | High — no process per connection |
| 4 | Proxy DNS/rule/credential caches + cert fix | S–M | High — per-request overhead → ~0; no 5 s first-host stall |
| 5 | Event-log index/retention + DB pragmas | S | Medium-high — create latency, long-term growth |
| 6 | Static caching + compression | S | High over LAN/Tailscale; 489 KB xterm per tab |
| 7 | Stream copy-in/push, incremental push | M | High for large repos (RAM and time) |
| 8 | Editor cadence + head-blob fan-out | M | Medium-high on big repos |
| 9 | Frontend in-place renders + visibility pause | M | Medium — client CPU, idle tabs |
| 10 | Proxy on a worker / Go data plane | L | Only if measurements show saturation |

### P0 — do these first (high impact, low risk)

1. **Kill the telemetry fan-out.**
   - Cache the `GUEST_PROBE` slow fields (`du`, `git status`, tmux) for ≥30 s;
     only recompute on explicit refresh or after git-affecting actions. Split
     `/details` into cheap state/resources and a slow "workdir" section. (S)
   - Remove the 1 s retry-on-`partial` loop (`web/app.js:2019-2022`) or back it
     off to ≥10 s. (S)
   - Point `vm-warn.js` at `/resources`, not `/details`; share one poller per
     project across tabs. (S)
   - Raise the branch TTL from 5 s to 30–60 s, or invalidate on git/branch
     actions (`core/projects.ts:1229-1251`). (S)
   - Add a per-ref stats sampling floor (3–5 s) and a 2–5 s `inspect` cache.
     Reuse the sampler's `df` for `/resources` instead of a second exec. (S)
   - Jitter and cap the 30 s sampler; skip a VM sampled <20 s ago. (S)
   - Batch `hasGitToken` into one query; coalesce `/api/projects` for 1–2 s.
   Expected: one open page from ~230 to <20 mixed ops/min; guest CPU returned to
   the agent.

2. **Fix the event log and SQLite write amplification.**
   - `PRAGMA synchronous = NORMAL`; add `events(project_id, id)`; prune `events`
     (30 days or N per project); batch `logOutput` lines in one transaction. (S)
   - Set `PRAGMA busy_timeout`; wrap the remaining multi-row loops
     (`updateSettings`, `setSeen`, purge loops) in transactions. (S)
   - Drop the redundant `resource_samples` index and index its `ts` for the
     prune. (S)
   - Collapse the vault N+1 (3N queries per `/api/vault`) into three bulk
     queries; add the missing `secret_id`/`project_id`/`forward_id` indexes. (S)

3. **Use the fast agent on Apple silicon.** Bake `sadbox-agent` into the base
   image and publish its socket (or vsock) the way the proxy relay is published;
   implement `exec`/`stream`/`terminal` in `driver/container.ts` over
   `driver/agent.ts`. Keep the CLI for lifecycle. Expected: ~90–300 ms → ~2–10 ms
   per guest op; create, editor, sync, probes all improve; parity with Linux.
   (L, but the highest ceiling.)

4. **Fix the proxy hot path.**
   - TTL cache for `resolveTarget` (30–60 s, negative too), keeping check and
     connect on the same address; evaluate rules **before** resolving; cache
     `ownAddresses()` for ~30 s. (S)
   - Cache rules and header rules with a version counter bumped on every CRUD;
     memoize `projectCredentials`/`loginCredentials` **per request**; skip the
     redaction machinery when a project has no redactable secrets. (M)
   - Single-flight `projectForIp` and lengthen its TTL (the legacy TCP path can
     spawn `container list` per concurrent request). (S)
   - Read back the persisted leaf cert on restart, or pre-mint for known hosts;
     remove the 5 s settle where an OpenSSL with `-not_before` is available.
     (M)
   - Set an explicit upstream `https.Agent` (Bun's global agent does keep-alive,
     but with a 5 s idle timeout and no retry on a stale socket). Keep the pool
     keyed by host or make address changes safe. (S)
   - Cap/evict `hostServers` and `certCache`; consider one TLS front end with
     `SNICallback` if Bun's support is fixed (verify). (M/S)
   - Key the loopback context by socket, not source port only (§4.4.11). (S)

5. **One persistent guest relay for forwards, routes and links.** Replace
   `driver.stream(guestConnectCmd(port))` per connection with a carrier model
   (host dials in, guest relay splices to the target port; a small header names
   the port). Stop forcing `Connection: close` on links. Add backpressure and a
   per-project bridge cap. Expected: page loads and HMR stop spawning a Bun
   process per asset. (M)

6. **Static delivery.** Add `Cache-Control` + `ETag`/`Last-Modified` (or a build
   hash in the URL) and gzip/brotli for HTML/JS/CSS/vendor; `immutable` for
   xterm/Ace; `defer` the Ace scripts. Expected: first load ~237 KB → ~60 KB; no
   488 KB xterm download per tab; ~500 KB Ace deferred to editor open. (S)

### P1 — clear wins, low risk

7. **Copy-in/push streaming.** Stream `tarSource` into `execWithStdin` instead of
   buffering the archive (and stop shipping a multi-GB `.git` verbatim where
   possible); honour `.gitignore` for plain folders with an async walk; make
   push compare stat/size/mtime before hashing every byte on both sides. (M)

8. **Editor cadence and fan-out.** Poll git status every 10–15 s; drop
   `--ignored` from the colour pass (or make it opt-in); fetch HEAD/index blobs
   lazily for the active tab and cache by oid; cache `/files/index` for ~10 s and
   cap it at the source; refresh tree folders only when the file set changed;
   skip the pre-write hash when `expect = any`. (M)

9. **Pause polling when hidden** in `app.js` (`visibilitychange` + resume on
   show), and guard every timer with `document.hidden`. (S)

10. **Frontend render discipline.** Update detail fields in place instead of
    replacing `#detail-stats`/`#detail-actions`; throttle the Activity table to
    250–500 ms and append rows; debounce the filter; cap `netModel.older`; rAF
    the chart hover and redraw only the hovered canvas; guard `renderDetail`
    against stale responses; drop the second SSE/1 s tick in `net-asks.js` when
    there are no approvals. (M)

11. **Background loops.** Capture logins on start + on demand (not every 30 s for
    every VM), or cheap-stat the credential files first; probe the toolchain less
    often and fewer tools; cache `historyOf`/`listHistory` by mtime/TTL. (S)

12. **Batch provisioning.** Combine chown/history/shell hooks/net.env/vault writes
    into one guest script; one `apt-get install` for all extras; parallel
    optional apps; `Promise.all` the post-boot mounts; one history share instead
    of seven. (M)

13. **Agent robustness/perf.** Chunk-list frame assembly; fix the timeout socket
    leak; exponential backoff in `waitForAgent`; cache the guest user lookup and
    pool/shrink per-exec buffers; async `ps` (or `/proc`/`libproc`) in the vz
    driver; give `hostGit` a timeout. (M)

14. **Image/disk costs.** Pin the base-image installers and use BuildKit cache
    mounts; avoid a full disk copy where reflink is unavailable (overlay/qcow2);
    cache optional-app packages instead of downloading Blender per VM; check the
    toolchain cache before `resolveBaseImage()`. (M/L)

15. **Long-running requests.** Return 202 + progress for create/rebuild/sync/
    push/apply (the `events` table already carries progress) instead of holding
    the HTTP connection; add a timeout to the Claude refresh fetch. (M)

### P2 — polish and scaling

16. Gate migrations with `PRAGMA user_version` and run them in one transaction;
    delay the first sampler tick; chunk `pruneRequests` and `resource_samples`
    deletes. (S)
17. Remove the redundant start-readiness exec poll; use the agent ping. (S)
18. Cache `recipeHash`/`diskMeta` per process and the image probe briefly. (S)
19. Kill virtiofsd on a failed KVM boot; prune per-project maps on destroy; fix
    the `forgetVitals("")` key. (S)
20. xterm: add `@xterm/addon-webgl`, explicit `scrollback`, `ResizeObserver`, and
    a WebSocket backpressure guard (`bufferedAmount`) with auto-reconnect. (S)
21. Editor: `useWorker: true`, cap the diff trace, move the diff off keystrokes,
    clear `tab.diffTimer` on close. (M)
22. Add SSE-side limits: cap the snapshot (`CAP=500`), send a smaller initial
    snapshot and let the UI page, avoid re-sending 100–200 KB on reconnect, and
    publish pre-encoded bytes once per event. (S)
23. Serve `/api/projects` with only the fields the UI uses; make `/api/fs/dirs`
    async and capped; cache session validity in memory. (S)
24. On ext4, use a qcow2 overlay or reflink-capable FS for per-project disks;
    on Linux, CH snapshots for instant resume (already planned). (L)

### What not to do

- **Do not rewrite the supervisor in Go/Rust.** The measured cost is redundant
  work and CLI process spawns; both are fixable in place, and the driver/agent
  boundary already isolates the hot guest path.
- **Do not add a frontend framework/build step** to fix rendering. A poll
  coordinator, in-place updates and a smaller table solve it without losing the
  zero-build model.
- **Do not replace SQLite.** It is not the bottleneck; the schema/pragma issues
  are mechanical.
- **Do not poll faster to feel "live".** Push state (SSE/WS) and cache slow
  facts; the current 1.5 s/4 s cadence is already faster than a human can read.

---

## 7. Risk notes for the optimizations

- **Caching DNS** must keep resolve-then-connect on the *same* cached address;
  never re-resolve between the classification and the socket connect. Cache
  negative answers briefly to avoid hammering a broken resolver.
- **Caching rules/credentials** must invalidate on every mutation path (CRUD,
  approvals that create bindings, vault access changes, project destroy). A
  monotonically increasing `rulesVersion`/`vaultVersion` per project is simplest
  and cheap.
- **Caching decrypted secrets** is not recommended beyond the request; cache the
  encrypted rows and decrypt per use (AES-GCM is microseconds). The DB reads are
  the cost, not the crypto.
- **Cert pre-minting** should only cover hosts the project is known to use
  (bindings, git remote, agent hosts), not arbitrary hosts; otherwise it creates
  an unbounded workload.
- **Telemetry TTLs** must be invalidated by the actions that change the value
  (branch switch, sync, push, app install, memory/CPU change, start/stop) so the
  UI never shows stale state after a click.
- **`synchronous = NORMAL`** trades the last few committed transactions on a
  power loss for a large write-speed win; it cannot corrupt the database. That is
  acceptable for logs, samples and settings; a user can sign in again if a
  session write is lost.

---

## 8. Measurement plan (do this before/after each change)

Add a small dev-only timing layer (behind an env flag) so improvements are
provable, then run:

1. **UI/server**: with 1, 5 and 10 projects, record p50/p95 for
   `GET /api/projects`, `/resources`, `/details`, `/api/system/status`; count
   guest execs and subprocess spawns per endpoint; measure supervisor CPU and
   guest CPU at idle, with a detail page open, and with three tabs.
2. **Guest control plane**: time `exec true` p50/p95 per driver (expect ~1.7 ms
   on the agent, ~90 ms on the container CLI); time the full create chain.
3. **Proxy**: requests/s and p50 latency through the proxy to a local origin,
   with and without keep-alive/DNS cache; time the first request to a new host
   (expect the 5 s stall today); measure supervisor CPU during `bun install` in a
   VM.
4. **Forwards**: time a 100-asset page load and an HMR WebSocket through a
   forward, before/after the persistent relay; count guest processes spawned.
5. **Editor**: time `/files/status` and `/file/head` on a repo with
   `node_modules`; measure editor CPU typing in a 2 MB file.
6. **Copy/sync**: time create and push for a 1 GB repo (with a large `.git`);
   watch host RSS (should not equal repo size) and guest RSS (per-connection Bun
   processes). Time sync-back for 1, 100 and 1,000 changed files; count host git
   spawns.
7. **DB growth**: seed 1 M `net_requests` and 100 k `events`, then time the
   Activity summary, event tail poll, and hourly prune; confirm the new indexes
   are used (`EXPLAIN QUERY PLAN`).
8. **Soak**: 24 h with 5 projects, one detail tab, one terminal, one editor;
   watch RSS/fds, SQLite/WAL size, `events`/`net_requests` growth, and supervisor
   CPU. This is also the check for the socket leak and O(n²) buffering.

Success criteria for the P0 set: one open detail page <20 mixed ops/min and <10
guest execs/min; idle supervisor CPU <2 %; `/details` p95 <150 ms warm; first
request to a new host no longer stalls 5 s; forwarded page load spawns zero
guest processes after the first; create/push RSS does not scale with repo size.

---

## Appendix A — cost model (order of magnitude)

| Operation | macOS `container` | vz/KVM agent |
|---|---|---|
| exec / probe | 90–300 ms + guest command | 1.7–5 ms + guest command |
| `container stats` | 1–2 s | n/a (guest `/proc` exec) |
| `inspect` | ~30–100 ms spawn | ~0.3–2 ms unix HTTP |
| guest Bun start (per forward connection, login probe) | ~50–100 ms inside guest | same |
| DNS lookup (proxy) | ~1 ms warm, up to ~140 ms cold (uncached) | same |
| SQLite execute (hot) | ~0.3–0.5 µs | same |
| SQLite prepare (cache miss) | ~10–50 µs | same |
| AES-GCM decrypt (small secret) | ~1–5 µs | same |

## Appendix B — file:line index of the hot paths

| Concern | Location |
|---|---|
| Project list + branch execs | `src/core/projects.ts:1229-1281` |
| Resource poll (`inspect`+`stats`+`df`) | `src/core/projects.ts:677-719` |
| Heavy guest probe (`du`, `git status`) | `src/core/projects.ts:628-641`, `750-842` |
| Stats cache/floor | `src/core/vitals.ts:74-96` |
| 30 s sampler | `src/core/projects.ts:729-748` |
| Provisioning chain | `src/core/projects.ts:332-512` |
| `tarSource` buffers archive | `src/core/projects.ts:124-156` |
| Login loop (30 s/VM) | `src/core/logins.ts:246-265` |
| Editor git status | `src/core/files.ts:108-155` |
| Editor HEAD/index fan-out | `web/editor.html:974-993`, `src/core/files.ts:188-221` |
| `fileIndex` unbounded / `find -exec` | `src/core/files.ts:77-93` |
| Push hashes every byte twice | `src/core/push.ts:54-92` |
| Sync snapshot/bundle | `src/core/sync.ts:72-200` |
| Agent framing (O(n²)) | `src/driver/agent.ts:88-98` |
| Agent request socket leak | `src/driver/agent.ts:231-247` |
| Guest agent per-exec lookup/buffers | `guest/agent/exec.go:71-99,154-171,226-239`, `proto.go:104-123` |
| macOS CLI per exec | `src/driver/container.ts:50-62`, `330-338` |
| vz blocking `ps` | `src/driver/vz/index.ts:64-84`, `240-245` |
| vz/kvm mount replay | `src/driver/vz/index.ts:204-206`, `src/driver/kvm/index.ts:174-176` |
| Disk clone / reflink fallback | `src/driver/vm.ts:82-90` |
| Image build layers | `images/base/Dockerfile:21-41`, `images/disk/Dockerfile:33-39` |
| Proxy request path | `src/net/proxy.ts:216-429` |
| DNS + `networkInterfaces` per request | `src/net/proxy.ts:103-107`, `141-158`, `269-272` |
| `projectForIp` herd | `src/net/proxy.ts:52-74` |
| Per-host TLS server + loopback | `src/net/proxy.ts:442-469` |
| Cert mint + 5 s settle / no disk reuse | `src/net/ca.ts:33-45`, `80-110` |
| Rule query per request | `src/net/rules.ts:215-237`, `241-270` |
| Credential decrypt per request | `src/net/credentials.ts:69-85`, `132-176`, `197-264` |
| Forward per connection | `src/net/forwards.ts:59-88` |
| Route per connection (+3 queries) | `src/net/routes.ts:113-145`, `155` |
| Link per connection | `src/net/links.ts:160-196` |
| DB pragmas | `src/db.ts:6-8` |
| `events` schema / unindexed queries | `src/db.ts:242-249`, `src/core/projects.ts:209-232` |
| Per-line log inserts | `src/core/projects.ts:242-256`, `src/db.ts:444-448` |
| Migrations on every boot | `src/db.ts:10-185` |
| Vault N+1 | `src/core/vault.ts:89-113`, `326-337` |
| Static asset serving | `src/api/http.ts:569-578` |
| Frontend polling | `web/app.js:1969-1992`, `3169-3173` |
| vm-warn heavy poll | `web/vm-warn.js:54-85` |
| Editor polling/N+1 | `web/editor.html:974-993`, `1120-1123`, `1175` |
| Terminal | `web/terminal.html:81-97`, `175-225` |

## Appendix C — intervals and budgets

| Loop | Interval | Scope |
|---|---|---|
| Project cards | 5 s | visible projects view |
| Nav tree (`/projects` + `/net/pending`) | 5 s | every page, every tab |
| Service status | 5 s | home |
| Detail `/details` | 4 s (+1 s on partial) | one project per tab |
| Detail `/resources` | 1.5 s | one project per tab |
| Resource sampler | 30 s | every running VM |
| Login capture | 30 s | every running VM |
| Claude refresh | 60 s | one login |
| Toolchain probe | 5 min | cached per VM |
| Create/destroy progress | 600–700 ms + 500 ms clock | during create/destroy |
| Editor git status | 5 s | visible editor |
| Editor net/ask tick | 1 s | every terminal/editor tab |
| vm-warn `/details` | 15 s | every terminal/editor tab |
| Net log prune | 1 h | global |
| SSE heartbeat | 25 s | each open net panel |

## Appendix D — references

- `spikes/e-cloud-hypervisor/README.md` — agent vs `container exec` timings.
- `spikes/d-credential-proxy/README.md` — per-request swap cost (~40–480 µs).
- `docs/ROADMAP.md` — lifecycle timings, Linux create/start/stop.
- `docs/research/06-workdir-sync.md` — sync design and why it is incremental.
- `docs/research/07-supervisor-stack.md` — stack rationale and the Go escape hatch.
- Bun docs — `bun:sqlite` statement cache and `PRAGMA synchronous = NORMAL`;
  `Bun.serve` API.
