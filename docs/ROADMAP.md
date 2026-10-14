# sadbox — Roadmap

> What has shipped, what is next, and the plan for Linux support.
> Last updated 2026-10-14. Design background lives in [`research/`](research/README.md).

## Shipped (v0, macOS)

All on Apple silicon + macOS 26, through the Apple `container` driver
(`src/driver/container.ts`).

| Area | What works |
|---|---|
| De-risk spikes | A (terminal), B (image/workdir), C (sync): all passed 2026-09-15 (`spikes/`) |
| Supervisor | Bun + TypeScript single binary, SQLite, REST + WS API, `ProjectDriver` boundary |
| Guest image | One Dockerfile (Debian trixie), toolchain baked in (Bun, Claude Code, opencode, tmux), toolchain shown on the detail page |
| Projects | Create from a local git folder or a git URL; rebuild; stop/start; idle timeouts; per-VM memory change; default CPU/memory/disk in Settings |
| Terminal | xterm.js ⇄ WS ⇄ PTY ⇄ `container exec` ⇄ tmux, one browser tab per project |
| Secrets | Encrypted at rest (AES-256-GCM, data-dir keyfile), assigned per project, delivered as env files |
| Sync-back | git-bundle sync to the source folder, including uncommitted work; GitHub-sourced projects can connect to a local folder |
| Editor | Built-in browser editor with stage / commit / push / branch switch / stash / discard |
| Network | VMs have no NIC; all egress goes through the supervisor's MITM proxy over a published unix socket. Block-by-default with time-boxed approvals, allow/block + header-rewrite rules (global or per-project), live request log |
| Ports & links | Port forwarding into a VM; links section on the detail page |
| UI | Home overview, side nav with project list, live CPU/memory/disk/network vitals |
| Auth | Password sign-in with session cookie |
| Distribution | Release workflow (darwin + linux binaries), `install.sh`, Homebrew formula, version workflow, Caddy LAN deployment guide |

## Next major feature: Linux support

**Goal:** the same supervisor runs on a Linux host with `/dev/kvm` (bare metal,
a home server, or EC2), natively or under docker-compose, and every feature
above works there. Each project is still a real microVM (see the isolation
constraint in `research/00`).

**Decided already** (`research/01`, `02`): Cloud Hypervisor (CH) as the VMM,
driven over its REST API on a unix socket; vsock as the control plane; same
Dockerfile for the guest image; Architecture A (one binary everywhere,
compose is just Linux packaging).

**Why it is tractable:** the macOS coupling is mostly confined to
`src/driver/container.ts`. Only a few call sites outside the driver assume the
`container` CLI (see L4).

### Phases

**L0 — Spike D: CH + guest agent (de-risk)**
- Boot the sadbox image under Cloud Hypervisor on an x86_64 and an arm64 KVM host.
- Pick the guest agent:
  1. Run Apple's `vminitd` under CH (one protocol on both platforms; open question #2 in `research/README`), or
  2. A small sadbox agent (Bun or Go) as PID 1 / init service.
- Prove the terminal chain end-to-end over vsock: PTY, resize, stdin streaming, byte streams.
- Measure cold boot and create→ready time against the macOS ≈ 1.2 s.
- Exit criterion: Claude Code TUI usable in the browser through a CH guest.

**L1 — Guest agent**
- Implement the operations the driver needs over vsock: `exec`, `execWithStdin`,
  `execCaptureBytes`, `stream`, `terminal` (PTY + resize), plus a
  host-dials-in socket channel for the proxy carriers (replaces `--publish-socket`).
- Bake it into the image so both drivers share it, or keep it Linux-only if L0 picks `vminitd`.

**L2 — Image pipeline**
- Dockerfile → OCI → ext4 rootfs (`docker export` + `mkfs.ext4 -d`, or a
  build with buildkit only) + a guest kernel (CH-compatible `vmlinux`), multi-arch.
- Store under the data dir, versioned like the macOS image; replaces `container build` on Linux.
- Per-project disk: copy-on-write clone of the base rootfs (reflink / qcow2 overlay) + workdir.

**L3 — `driver/kvm`**
- Full `ProjectDriver` over the CH REST API: create / destroy / start / stop /
  `setMemory` / inspect / list / stats.
- One CH process per VM, supervised by sadbox; state reconciled on supervisor restart.
- `network: "none"` + vsock socket channel, so the existing proxy, approvals and
  port forwards work unchanged.
- Stats from CH counters + the VMM's cgroup.
- Capability flags: `snapshot: true` (CH supports it), `sharedMount` optional (virtiofs).

**L4 — De-macOS the rest of the supervisor**
- Driver selection in `src/driver/index.ts` by platform / `SADBOX_DRIVER`.
- Move `container`-CLI assumptions behind the driver: toolchain probe
  (`src/core/toolchain.ts`, uses `container run`), base-image build context
  (`src/assets.ts`), `config.containerBin`.
- Secrets KEK: compose `secrets:` file on Linux (and Keychain on macOS), replacing the v0 keyfile (`src/crypto.ts`).
- Settings / vitals text that says "container" where it means "VM".

**L5 — Packaging & install**
- docker-compose: uncomment `/dev/kvm`, `/dev/net/tun`, `NET_ADMIN`; ship CH and kernel in the image.
- Native install: `install.sh` on Linux fetches CH + kernel and checks `/dev/kvm`;
  optional systemd unit (counterpart of launchd).
- README: supported-platforms table, Linux quick start, EC2 notes
  (nested virt on Intel C8i/M8i/R8i; Graviton needs `.metal`).

**L6 — Testing & CI**
- A driver contract test suite run against both drivers (lifecycle, exec, PTY,
  stream, socket channel, stats).
- A Linux KVM CI job (GitHub-hosted Ubuntu runners expose `/dev/kvm`) that runs
  the suite plus a create → terminal → sync-back smoke test.

**L7 — Linux-only extras (after parity)**
- CH snapshot/restore for near-instant resume of stopped projects.
- Optional virtiofs shared mounts.

## Other planned work

Ordered roughly by priority. Each item is independent of Linux unless noted.

| # | Item | Notes |
|---|---|---|
| 1 | **Forwarded ports behind sign-in** | Today they are raw TCP open to anyone who reaches the host. Route through the authenticated HTTP server (or bind to loopback + Caddy). Security gap. |
| 2 | **Outbound WebSockets through the proxy** | Upgrade passthrough in `src/net/proxy.ts`, subject to the same rules/approvals. |
| 3 | **Secrets KEK in Keychain** | Replace the data-dir keyfile on macOS (`research/05`); pairs with L4 on Linux. |
| 4 | **Non-git local folders** | tar-in copy + tar-out sync-back with `git diff --no-index` preview and backed-up apply (`research/06`). |
| 5 | **Live secret / proxy-env rotation** | Today only new shells pick changes up. |
| 6 | **Egress credential injection** | `delivery='proxy'`: the proxy adds API keys to outbound requests so the agent never sees them (`research/05`). |
| 7 | **DB backup** | Litestream (or periodic snapshot) of the SQLite file (`research/07`). |
| 8 | **Scale measurements** | RAM/balloon behavior with 10+ idle VMs; workdir copy-in throughput for 1–2 GB repos (open questions #4, #5). |
