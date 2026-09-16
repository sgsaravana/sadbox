# sadbox — Research Summary

> **Terminology (2026-09-16):** a microVM instance is now a **project** (these
> research docs predate the rename and say "worker"); the base VM image is the
> **base image** (was "worker image"). See `00-requirements.md`.


> Synthesized 2026-09-15 from seven parallel research threads. Each section links
> to the full doc; read `00-requirements.md` first for scope and vocabulary.

## Executive summary

sadbox is buildable today on the M1 Max with **no exotic engineering**: Apple's
open-source Containerization stack (`container` CLI) already provides the exact
worker model we need — one lightweight VM per worker, sub-second boot, a
gRPC-over-vsock exec agent (vminitd) in every guest, persistent ext4 rootfs, and
per-VM routable IPs on macOS 26. The supervisor is mostly orchestration glue:
a Bun/TypeScript web app that shells out to `container`, bridges PTYs to
WebSockets, and runs git/tar plumbing for workdir sync.

The docker-compose portability goal is real but **platform-shaped**: on Linux it
works cleanly (microVM managers run unprivileged in containers with `/dev/kvm`
passthrough), while on macOS the supervisor must run natively — microVMs inside
Docker are impossible on M1/M2 (no nested virtualization) and still impractical
on M3+. The design answer is a `WorkerDriver` abstraction: same supervisor,
swappable per-platform backends.

## The converged architecture

```
┌────────────────────────── Browser ──────────────────────────┐
│  Dashboard (worker list, secrets, sync)   Terminal tabs     │
│  React + Vite            xterm.js 6 ⇄ WebSocket (per tab)   │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP + WS
┌──────────────────────────────┴──────────────────────────────┐
│  Supervisor — Bun + TypeScript, single process              │
│  API · SQLite (bun:sqlite + Drizzle, libsodium-encrypted    │
│  secret columns) · PTY bridge (Bun.Terminal) · sync engine  │
│                    WorkerDriver interface                   │
│   ┌─────────────────────┴─────────────────────┐             │
│   │ driver/vz (macOS, native)                 │             │
│   │   shells out to `container` CLI           │             │
│   │ driver/kvm (Linux, docker-compose-able)   │             │
│   │   Cloud Hypervisor REST over unix socket  │             │
│   └─────────────────────┬─────────────────────┘             │
└──────────────────────────────┼──────────────────────────────┘
                               │ vsock (exec, secrets, sync)
        ┌──────────────────────┴──────────────────────┐
        │  Worker microVM (Debian bookworm-slim OCI)  │
        │  vminitd · tmux session "main" · Claude Code│
        │  rootfs (shared, RO) + workdir ext4 (RW)    │
        └─────────────────────────────────────────────┘
```

## Key decisions (with pointers)

| # | Decision | Rationale | Doc |
|---|---|---|---|
| 1 | **macOS backend: Apple `container` / Containerization** | VM-per-container is exactly the worker model; vminitd exec agent, ext4 persistence, routable IPs; Apache-2.0, fast release cadence. Raw Virtualization.framework would mean rebuilding all of that; Tart (OpenAI-acquired, FSL) and Lima are pet-VM shaped. | 01 |
| 2 | **Linux backend (later): Cloud Hypervisor** | REST API over UDS, vsock + virtiofs + snapshots, arm64; it's the VMM Apple's own framework uses on Linux. Kata Containers is a pragmatic first Linux milestone; Firecracker only if we pivot to mass snapshot-restored ephemeral workers. | 01, 02 |
| 3 | **`WorkerDriver` interface with capability flags** | create/destroy/start/stop/exec-as-PTY/copyIn/copyOut/address/events; flags for snapshot, sharedMount, routableIp. Lets compose-on-Linux and native-on-macOS coexist. | 01, 02 |
| 4 | **Packaging: native (brew/launchd) on macOS, docker-compose on Linux/EC2** | Nested virt absent on M1/M2 and unexposed by Docker Desktop/OrbStack even on M3+; on Linux, compose needs only `/dev/kvm`, `/dev/net/tun`, `NET_ADMIN` — no privileged mode. EC2 nested virt now works on Intel C8i/M8i/R8i virtual instances (2026); Graviton still needs `.metal`. | 02 |
| 5 | **Guest image: Debian bookworm-slim, one Dockerfile → all backends** | OCI consumed directly by Apple Containerization; `docker export` + `mkfs.ext4 -d` derives the Firecracker/CH rootfs. glibc keeps arbitrary npm/pip toolchains working; Alpine optional later. Multi-arch (arm64 + x86_64) from day one because EC2 Intel workers are on the roadmap. | 03, 02 |
| 6 | **Bake apps into the image; no cloud-init** | curl/bun/tmux/Claude Code (native binary, apt stable channel) prebaked, `DISABLE_AUTOUPDATER=1`, nightly rebakes. Boot-time installs would dominate create latency. | 03 |
| 7 | **vsock is the control plane everywhere** | Apple ships vminitd (gRPC over vsock); Linux needs a small PID-1 twin. No sshd required in guests; SSH becomes an opt-in extra. | 03, 04, 05, 06 |
| 8 | **Workdir: per-worker ext4 block device built on host** | True copy semantics (agent can't touch the source), portable to Firecracker (which rejects virtiofs), faster than virtiofs for small files. Exclude `node_modules`/`.venv`/`target` — macOS-built natives are broken in Linux anyway; reinstall inside. | 03, 06 |
| 9 | **Terminal chain: xterm.js 6 ⇄ WS ⇄ Bun PTY ⇄ `container exec -it … tmux new -A -s main` ⇄ vsock** | Zero guest daemons; auth collapses into supervisor session auth; one WS + tmux client per browser tab; `new -A` kills creation races; sessions survive supervisor restarts (tmux lives in-guest). xterm.js 6 + tmux ≥ 3.4 synchronized output fixes Claude Code's flicker. Fallback: ttyd in-guest, reverse-proxied. | 04 |
| 10 | **Secrets: SQLite + libsodium column encryption; delivery as tmpfs files over vsock** | KEK in macOS Keychain (via Bun.secrets) or compose `secrets:` file on Linux; DEK-envelope scheme. Nothing hides secrets from the agent itself — design for per-worker blast radius, image/log hygiene, rotation. `delivery='proxy'` reserved for a future egress credential-injection proxy. | 05 |
| 11 | **Claude Code auth: host-minted `claude setup-token` OAuth token as a built-in secret** | Documented headless path (Pro/Max, 1-year token). N workers share one subscription's rate buckets — support optional `ANTHROPIC_API_KEY` for burst; never copy `.credentials.json`. | 05 |
| 12 | **Sync-back: git-native primary, tar-out fallback** | Guest autocommits to `sadbox/<worker>` branch, exports incremental `git bundle` over vsock; host fetches into a remote-tracking ref. Preview is free, source worktree untouched until explicit apply. Non-git folders: tar-out to staging + `git diff --no-index` preview + backed-up apply. Mutagen (stale), Unison, raw rsync (openrsync limitations) rejected. | 06 |
| 13 | **Stack: Bun + TypeScript; Vite + React; bun:sqlite + Drizzle; Litestream backup** | Bun ≥ 1.3.5 has first-party PTY (`Bun.spawn({terminal})`), native WS server, `$` shell, single-file cross-compiled binaries. The Swift-only Apple framework forces CLI shell-out for *every* non-Swift stack, neutralizing Go's usual edge; Firecracker/CH REST-over-UDS works with Bun `fetch({unix})`. Go is the named runner-up; escape hatch: rewrite only the PTY bridge in Go if the 48 h / 20-terminal soak fails. | 07 |

## Tensions & judgment calls across threads

- **Virtiofs**: the portability thread liked Cloud Hypervisor partly for virtiofs,
  but the provisioning and sync threads rejected virtiofs for the workdir (absent
  in Firecracker, slow for small files, and live-mount semantics contradict the
  "copy, not mount" isolation requirement). Resolution: workdir is a block
  device; virtiofs stays a *capability flag* for optional shared mounts.
- **No memory snapshots on macOS**: `saveMachineStateToURL` needs a private
  entitlement. Accept cold boots (sub-second) + APFS clones on macOS; CH
  snapshots become a Linux-only capability.
- **One vsock agent protocol**: Apple's vminitd on macOS vs. a to-be-written
  PID-1 twin on Linux. Worth a spike: run vminitd itself under Cloud
  Hypervisor/Firecracker to unify the protocol (flagged in 03).
- **Shared rate limits**: many concurrent workers on one Max subscription will
  hit 5-hour/weekly buckets; the secrets model supports per-worker API-key
  override for exactly this.

## Consolidated open questions

1. ~~`container exec -it` resize relay under a supervisor-owned PTY~~ —
   **closed 2026-09-15 by Spike A** (`spikes/a-terminal/`): resize propagates,
   ~20 ms redraw, ~140 ms attach over vsock. See spike README for gotchas
   (pin TERM, `terminal.close()`, guest terminfo).
2. Containerization's Linux port maturity — could it become the Linux driver
   too, unifying everything? (01, 03)
3. `container` CLI JSON output stability across majors — pin versions, wrap in
   one module (01, 07).
4. Balloon/RAM behavior with 10+ idle workers on a 32 GB host (01).
5. Workdir ext4 build throughput for 1–2 GB repos — measure `mkfs.ext4 -d` and
   ContainerizationEXT4 (03, 06).
6. Whether `container` on macOS 26 exposes enough network info for the
   supervisor to reach guest ports without exec-based proxying (03).

## Suggested next steps

1. ~~**Spike A (de-risk terminal)**~~ — **passed 2026-09-15**
   (`spikes/a-terminal/`): full chain works incl. live resize; gotchas
   documented (pin TERM, `terminal.close()`, guest terminfo).
2. ~~**Spike B (de-risk workdir/image)**~~ — **passed 2026-09-15**
   (`spikes/b-image/`): one Dockerfile → full toolchain image (trixie, not
   bookworm — tmux ≥ 3.4); warm create→ready ≈ 1.2 s; tar-over-exec is the
   copy-in (`container cp` breaks ownership); Claude Code TUI renders through
   the bridge.
3. ~~**Spike C (de-risk sync)**~~ — **passed 2026-09-15** (`spikes/c-sync/`):
   incremental bundles of a few hundred bytes over exec stdout, sub-second
   fetch + preview, host worktree untouched; exclusion-vs-committed-paths
   edge case documented.
4. Then scaffold the supervisor: WorkerDriver interface, SQLite schema
   (workers, secrets, worker_secrets, events), REST + WS API, dashboard.
   **← current step.** All three de-risk spikes passed on the first day.

## Doc index

| Doc | Topic |
|---|---|
| [00-requirements.md](00-requirements.md) | Requirements, constraints, vocabulary |
| [01-virtualization-backends.md](01-virtualization-backends.md) | MicroVM/VM tech per platform, driver abstraction |
| [02-deployment-portability.md](02-deployment-portability.md) | docker-compose story on macOS / Linux / EC2 |
| [03-guest-image-provisioning.md](03-guest-image-provisioning.md) | Guest images, app baking, boot, networking |
| [04-tmux-web-terminal.md](04-tmux-web-terminal.md) | Browser ⇄ tmux terminal architecture |
| [05-secrets-management.md](05-secrets-management.md) | Secret storage, injection, Claude Code auth |
| [06-workdir-sync.md](06-workdir-sync.md) | Copy-in and on-demand sync-back |
| [07-supervisor-stack.md](07-supervisor-stack.md) | Supervisor tech stack recommendation |
