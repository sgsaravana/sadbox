# 07 — Supervisor Tech Stack

Status: research complete, recommendation made. Verified against live sources September 2026.

## Context

sadbox's supervisor is a self-hosted web app for a single developer. It deploys/destroys
microVM "workers", lists them in a dashboard, serves many concurrent browser terminals
(xterm.js over WebSocket, attached to tmux inside each VM), manages per-worker secrets,
and runs on-demand workdir sync (rsync/git).

Host today: macOS 26 on Apple M1 Max, driving Apple's `container` CLI / Containerization
framework. Future: Linux with Firecracker or Cloud Hypervisor, ideally docker-compose
deployable. Nothing is built yet; stack is an open choice.

The supervisor is fundamentally a **subprocess orchestrator with a real-time web face**:
almost all VM control happens by shelling out to CLIs (`container`, `ssh`, `rsync`, `git`,
`tmux`) or calling small REST APIs, and almost all user value is delivered through
WebSocket-bridged PTYs and a live dashboard.

## Requirements the stack must satisfy

1. **PTY bridging** — spawn `container exec -it <id> tmux attach` (or `ssh`) under a real
   pseudo-terminal, stream bytes bidirectionally to xterm.js over WebSocket, handle
   resize/raw-mode, survive dozens of concurrent tabs. This is the core loop; it must be rock
   solid.
2. **Subprocess orchestration** — run and supervise `container`, `rsync`, `git`, `ssh` with
   streamed output, timeouts, cancellation, and parseable (JSON) results where available.
3. **The Swift wall** — Apple's Containerization framework is Swift-only; the stack must
   drive it from outside Swift without pain (see analysis below).
4. **Portability** — runs natively on macOS arm64 today (the VM driver *cannot* live inside
   a container on macOS — it needs XPC access to `container-apiserver`); later runs on
   Linux x64/arm64, ideally as one artifact in docker-compose with `/dev/kvm`.
5. **Embedded state** — SQLite as system of record (workers, secrets, event log) with
   migrations and cheap streaming backup; YAML/JSON worker recipes on disk.
6. **Solo-dev velocity** — one person builds and maintains this. Shared types between the
   live dashboard and the server, minimal glue code, and a small deploy story matter more
   than raw throughput. Concurrency scale is tens of terminals, not thousands.

## Option analysis

### Option A: Bun + TypeScript

State as of September 2026 (Bun v1.4.2, per the [Bun blog](https://bun.com/blog)):

- **PTY — the historical blocker is gone.** `node-pty` still doesn't work on Bun (V8-native
  addon vs JavaScriptCore), but Bun shipped **first-party PTY support in v1.3.5
  (December 2025)**: `Bun.spawn({ terminal: { cols, rows, data(...) } })` attaches a real
  pseudo-terminal with `write()`, `resize()`, `setRawMode()`, and `close()` —
  exactly the surface a WS↔PTY bridge needs
  ([spawn docs](https://bun.com/docs/api/spawn), [v1.3.5 release](https://bun.com/blog/bun-v1.3.5),
  [tracking issue #22468](https://github.com/oven-sh/bun/issues/22468)).
  Fallback if edge cases bite: [`bun-pty`](https://www.npmjs.com/package/bun-pty), a
  Rust/portable-pty implementation over `bun:ffi` designed as a node-pty near-drop-in.
- **WebSockets** — native in `Bun.serve` (uWebSockets-derived), with per-socket
  backpressure and pub/sub built in; no library needed
  ([server docs](https://bun.com/docs/runtime/http/server)).
- **Subprocesses** — `Bun.spawn` plus the `$` shell make `container`/`rsync`/`git`
  orchestration terse; streamed stdout, exit codes, AbortSignal cancellation all native.
- **SQLite** — `bun:sqlite` is built into the runtime; Drizzle ORM supports it with
  `drizzle-kit` migrations. Bun 1.3 also added built-in DB clients and zero-config frontend
  dev ([InfoQ coverage](https://www.infoq.com/news/2026/01/bun-v3-1-release/)).
- **Single-file executable** — `bun build --compile` bundles app + runtime into one binary
  and **cross-compiles** via `--target=bun-darwin-arm64 | bun-linux-x64 | bun-linux-arm64 |
  bun-linux-x64-musl | ...` ([executables docs](https://bun.com/docs/bundler/executables)).
  Binary is ~90 MB (embeds the runtime) — irrelevant for self-hosting.
- **Firecracker/Cloud Hypervisor future** — neither has a JS SDK, but both are driven by
  REST over a unix domain socket, and Bun's `fetch` takes a `unix:` option natively
  ([fetch docs](https://bun.com/docs/runtime/networking/fetch)). No SDK required; a driver
  is ~200 lines of typed fetch calls.
- **Maturity** — ~98% of the top-1000 npm packages work; the remaining risk is V8-native
  addons (avoidable here) and less accumulated operational lore for long-running servers
  than Node/Go ([2026 compatibility overview](https://dev.to/alexcloudstar/bun-compatibility-in-2026-what-actually-works-what-does-not-and-when-to-switch-23eb)).
  Single-threaded event loop is a non-issue at tens of I/O-bound terminal bridges.

**Net:** everything this app needs is now first-party in the runtime (PTY, WS, SQLite,
subprocess, single binary), and the backend shares TypeScript types with the dashboard.
The one genuine weakness: `Bun.Terminal` is ~9 months old vs. a decade of `creack/pty`.

### Option B: Go

- **PTY** — [creack/pty](https://github.com/creack/pty) is the decade-proven standard;
  works on darwin/arm64 and linux.
- **WebSockets** — [coder/websocket](https://github.com/coder/websocket) (formerly
  nhooyr/websocket) is the maintained, context-aware choice; gorilla/websocket is archived
  again and not recommended for new work
  ([websocket.org Go guide](https://websocket.org/guides/languages/go/),
  [benchmarks](https://github.com/gosuda/go-websocket-libraries)).
- **VM control** — [firecracker-go-sdk](https://github.com/firecracker-microvm/firecracker-go-sdk)
  remains the maintained first-class SDK for the Linux future;
  [Code-Hex/vz](https://github.com/Code-Hex/vz) gives direct Virtualization.framework
  bindings (but see the Swift wall — you'd be reimplementing what `container` already does:
  image pulls, vminitd, networking). OCI/containerd clients are best-in-class in Go.
- **Packaging** — single static binary, `embed.FS` for the frontend, trivial cross-compile
  *if CGO-free* (use `modernc.org/sqlite`, shell out to `container` instead of linking vz —
  vz requires cgo + macOS frameworks and would break cross-compilation).
- **Precedent** — coder/coder, gotty, ttyd: browser-terminal bridging is a solved Go
  problem. Goroutines make each bridge a simple blocking loop.
- **Costs** — a second language next to the unavoidable TypeScript frontend; no shared
  types across the wire (codegen or duplication); more boilerplate for JSON plumbing,
  config, and the dozens of small "glue" endpoints this app is made of.

**Net:** the safest possible backend for the PTY/concurrency core, at the price of a
two-language codebase for a one-person project whose surface is mostly UI + glue.

### Option C: Hybrid (Bun/TS control plane + Go terminal daemon)

Split the WS↔PTY bridge into a tiny Go sidecar; keep everything else in TS. Rejected as a
*starting* architecture: two artifacts, two toolchains, and an internal protocol on day one
to hedge a risk that now has two cheaper mitigations (first-party `Bun.Terminal`, then
`bun-pty`). It survives as the **named escape hatch** — the bridge protocol
(`stdin/stdout/resize` frames over WS) is small and frontend-agnostic, so it can be
extracted to Go later without touching the UI.

### The Swift question

Apple's [Containerization framework](https://github.com/apple/containerization) is
Swift-only (each container in its own lightweight VM; `vminitd` exposes gRPC-over-vsock
*inside* the guest; on macOS 26 the VMM layer even drives cloud-hypervisor over
REST-on-UDS — see [Anil Madhavapeddy's teardown](https://anil.recoil.org/notes/apple-containerisation)).
The [`container` CLI](https://github.com/apple/container) (v1.4.x as of Sept 2026) talks to
`container-apiserver` over **XPC**, which is effectively Swift/ObjC-only.

Findings for non-Swift supervisors:

- **The CLI is automation-friendly and is the intended integration surface.**
  `container list --format json|yaml|toml`, `container inspect` (JSON),
  `container system property list --format json`, `container exec -i -t` for TTY sessions,
  `-c/--cpus -m/--memory` resource flags, volume mounts
  ([command reference](https://github.com/apple/container/blob/main/docs/command-reference.md)).
  Apple documents XPC API compatibility guarantees within a major version
  ([releases](https://github.com/apple/container/releases)).
- **Community precedent for going deeper:** [crunchloop/devcontainer](https://github.com/crunchloop/devcontainer)
  drives apple/container from Go via a cgo wrapper around `libACBridge.dylib` — a small
  Swift dylib that imports `ContainerAPIClient` and speaks XPC to the apiserver. So a thin
  Swift shim is the known pattern when the CLI isn't enough.
- **Conclusion:** No, Swift is **not** forced. Shell out to `container ... --format json`
  as a `Driver` implementation; PTY-wrap `container exec -it` for terminals. Keep a
  ~100-line Swift dylib/helper as a *contingency* only if we later need event
  subscriptions or vsock plumbing the CLI doesn't expose. Do not write the supervisor in
  Swift: the web/WS/SQLite ecosystem there is far thinner, and it forfeits Linux.

## Frontend

**Recommendation: Vite + React SPA, statically built, served by the supervisor itself.**
Vite is at v8.x and is the React team's recommended SPA path
([vite.dev/releases](https://vite.dev/releases)); Next.js buys SSR/SEO this
localhost-only, auth-cookie dashboard doesn't need, and its static export fights
long-lived WS pages. Svelte would work but sacrifices the xterm.js/React ecosystem and
type-sharing conventions for no need at this scale. HTMX is wrong here: terminal tabs and
live VM state are exactly the client-heavy, stateful UI HTMX avoids.

- **Terminals:** [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) (0.19.x stable,
  actively maintained) + `@xterm/addon-fit` + `@xterm/addon-webgl` (WebGL renderer keeps
  many visible tabs cheap). One **WebSocket per terminal tab**, binary frames, JSON control
  messages for resize. Browsers cap WS connections per host in the hundreds (not the
  HTTP/1.1 six-connection limit), so per-tab sockets are fine and keep backpressure
  per-terminal.
- **State updates:** one multiplexed **WebSocket** for worker/VM state events (we already
  run a WS server; SSE would add a second transport for no benefit — SSE only wins when you
  want proxy-friendly, auto-reconnecting one-way streams and no WS infra). Snapshot on
  connect, diffs after; TanStack Query or a small store on top.
- Shared `packages/shared` TS types for Worker/Recipe/Event used by both server and UI.

## State & config

- **SQLite as system of record** via `bun:sqlite` (WAL mode), one DB file: `workers`,
  `secrets` (encrypted at rest — see secrets research doc), `events`, `sync_runs`.
- **Migrations:** Drizzle ORM + `drizzle-kit` (plain-SQL migration files, runs on
  `bun:sqlite`). Keeps the schema in TS next to the API types.
- **Backup:** [Litestream](https://litestream.io/) v0.5 sidecar streaming to S3-compatible
  storage — v0.5's LTX format adds point-in-time recovery
  ([Fly.io announcement](https://fly.io/blog/litestream-v050-is-here/)); note early-0.5.x
  had teething issues ([mtlynch's caution](https://mtlynch.io/notes/hold-off-on-litestream-0.5.0/)),
  so pin a recent 0.5.x and test a restore. Optional for a laptop; valuable once on Linux.
- **Worker recipes:** YAML files in `./recipes/*.yaml` (image, cpus, memory, mounts,
  secrets refs, init script), parsed with `yaml` + validated with `zod` — the zod schema
  doubles as the recipe's TS type. DB stores *instances*; files store *templates* (git-
  versionable, hand-editable).

## Recommendation

**Bun + TypeScript backend, Vite + React frontend, SQLite via `bun:sqlite` + Drizzle,
VM control via a `Driver` interface whose macOS implementation shells out to
`container --format json`.** One language, one repo, one ~90 MB self-contained binary per
platform.

Why this stack for *this* app:

1. **The PTY blocker died in Dec 2025.** `Bun.spawn({terminal})` gives first-party PTYs
   with resize/raw-mode; the historical "node-pty doesn't work on Bun" objection no longer
   decides the choice, and `bun-pty` exists as a second net.
2. **The Swift wall neutralizes Go's binding advantage on macOS.** Every non-Swift stack
   ends up shelling out to `container` (JSON output makes this clean); on Linux,
   Firecracker/Cloud Hypervisor are REST-over-UDS, which Bun's `fetch({unix})` speaks
   natively. Nowhere does Go's SDK ecosystem buy a capability TS lacks — only convenience.
3. **This is mostly UI + glue, built by one person.** End-to-end TypeScript means the
   Worker/Recipe/Event types are written once and used by the dashboard, the API, and the
   DB schema. That compounds daily; goroutines would help only at a scale (thousands of
   bridges) a single-user tool never reaches.
4. **Portability is symmetric.** `bun build --compile --target=bun-darwin-arm64` for the
   launchd-managed native macOS binary today; `--target=bun-linux-x64|arm64` (or the
   `oven/bun` image) inside docker-compose with `/dev/kvm` tomorrow.

Concrete bill of materials:

| Layer | Choice |
|---|---|
| Runtime | Bun ≥ 1.4.x |
| HTTP routing | Hono (runs natively on `Bun.serve`) |
| WebSockets | native `Bun.serve` websockets |
| PTY | `Bun.spawn({terminal})`; fallback `bun-pty` |
| Subprocesses | `Bun.spawn` + Bun `$` shell (rsync/git/container) |
| VM driver (macOS) | shell-out to `container` CLI, `--format json` |
| VM driver (Linux, later) | Firecracker/CH REST via `fetch({unix})` |
| DB | `bun:sqlite` (WAL) + Drizzle + drizzle-kit migrations |
| Backup | Litestream 0.5 sidecar (optional on laptop) |
| Recipes/config | YAML + zod schemas |
| Frontend | Vite 8 + React + `@xterm/xterm` (+fit, +webgl addons) |
| Packaging | `bun build --compile` per target; launchd (macOS) / compose (Linux) |

**Architecture shape:** single process now, but structure the code as
`controlplane/` (HTTP/WS/state) + `drivers/` (macos-container, linux-firecracker) +
`bridge/` (PTY↔WS) so the driver+bridge half can be extracted into a native host agent if
the Linux deployment ever wants the UI in compose but VMs on the host. On macOS the whole
binary must run natively on the host regardless — XPC to `container-apiserver` doesn't
traverse containers.

**Thin helpers in other languages, if ever needed:**
- ~100-line **Swift** dylib/CLI (libACBridge pattern) — only if `container`'s CLI proves
  insufficient for event streaming or vsock access.
- **Go** rewrite of `bridge/` behind the same WS protocol — only if `Bun.Terminal` shows
  instability under weeks-long sessions. This is the pre-planned escape hatch, not the plan.

**Choose Go instead** only if, during a week-one spike, `Bun.spawn({terminal})` fails the
soak test below — Go's creack/pty + coder/websocket + firecracker-go-sdk stack is the
proven runner-up and every architectural decision above (shell-out driver, WS protocol,
SQLite schema, Vite frontend) transfers unchanged.

## Open questions

1. **Soak test (do first):** 20 concurrent `Bun.spawn({terminal})` sessions running tmux
   with heavy output (e.g. `yes`, vim, htop) for 48h — watch for fd leaks, memory growth,
   resize glitches. This single spike validates or rejects the whole bet.
2. Does `container exec -it` degrade gracefully when the VM is mid-shutdown, and does
   `container list --format json` include enough state (IP, health) for the dashboard, or
   do we need periodic `inspect` fan-out?
3. Secrets at rest: OS keychain vs. age-encrypted SQLite column — interacts with the
   Linux/compose future (covered by the secrets research topic).
4. Litestream 0.5.x stability on current releases — verify a restore drill before trusting
   PITR.
5. Bun long-session WS memory profile under `permessage-deflate` — disable compression for
   terminal frames?
6. Does apple/container v2.x change the CLI/XPC surface? (Apple guarantees compatibility
   only within a major version.)

## Sources

- Bun.spawn PTY/terminal API — https://bun.com/docs/api/spawn
- Bun v1.3.5 release (Terminal shipped) — https://bun.com/blog/bun-v1.3.5
- Bun native PTY tracking issue — https://github.com/oven-sh/bun/issues/22468
- bun-pty (Rust portable-pty fallback) — https://www.npmjs.com/package/bun-pty
- Bun single-file executables & cross-compile targets — https://bun.com/docs/bundler/executables
- Bun fetch over unix sockets — https://bun.com/docs/runtime/networking/fetch
- Bun HTTP/WS server — https://bun.com/docs/runtime/http/server
- Bun blog (v1.4.x current) — https://bun.com/blog
- Bun 1.3 feature coverage — https://www.infoq.com/news/2026/01/bun-v3-1-release/
- Bun compatibility in 2026 — https://dev.to/alexcloudstar/bun-compatibility-in-2026-what-actually-works-what-does-not-and-when-to-switch-23eb
- apple/container — https://github.com/apple/container
- apple/container command reference (JSON output, exec -it) — https://github.com/apple/container/blob/main/docs/command-reference.md
- apple/container releases (v1.4.x, XPC compat policy) — https://github.com/apple/container/releases
- apple/containerization (Swift framework, vminitd gRPC/vsock) — https://github.com/apple/containerization
- Containerization internals teardown — https://anil.recoil.org/notes/apple-containerisation
- crunchloop/devcontainer (Go→XPC via Swift dylib precedent) — https://github.com/crunchloop/devcontainer
- Code-Hex/vz (Go Virtualization.framework bindings) — https://github.com/Code-Hex/vz
- creack/pty — https://github.com/creack/pty
- coder/websocket — https://github.com/coder/websocket
- Go WebSocket library guidance — https://websocket.org/guides/languages/go/
- Go WebSocket benchmarks — https://github.com/gosuda/go-websocket-libraries
- firecracker-go-sdk — https://github.com/firecracker-microvm/firecracker-go-sdk
- Firecracker vs Cloud Hypervisor — https://northflank.com/blog/firecracker-vs-cloud-hypervisor
- xterm.js — https://github.com/xtermjs/xterm.js
- @xterm/addon-webgl — https://www.npmjs.com/package/@xterm/addon-webgl
- Vite releases (v8.x) — https://vite.dev/releases
- Litestream — https://litestream.io/
- Litestream v0.5 announcement — https://fly.io/blog/litestream-v050-is-here/
- Litestream 0.5.0 caution — https://mtlynch.io/notes/hold-off-on-litestream-0.5.0/
