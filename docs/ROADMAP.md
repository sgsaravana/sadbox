# sadbox — Roadmap

> What has shipped, what is next, and the plan for Linux support.
> Last updated 2026-11-04. Design background lives in [`research/`](research/README.md).

## Shipped (v0, macOS)

All on Apple silicon + macOS 26, through the Apple `container` driver
(`src/driver/container.ts`).

| Area | What works |
|---|---|
| De-risk spikes | A (terminal), B (image/workdir), C (sync): all passed 2026-09-15 (`spikes/`) |
| Supervisor | Bun + TypeScript single binary, SQLite, REST + WS API, `ProjectDriver` boundary |
| Guest image | One Dockerfile (Debian trixie), toolchain baked in (Bun, node + npm via nvm, Claude Code, omp, opencode, tmux), toolchain shown on the detail page; rebuilt automatically when its recipe changes |
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

## Current: credential proxy + network controls — built on `feature/proxy-credentials`, not merged

Remaining before merge: Spike D **round 2** with real, short-lived tokens
(create them as *proxy* vault items in the UI; see the spike README), and a
real Claude `/login` + refresh through the proxy (Agent logins, below).
Both are **ready to run** (prepared 2026-11-04): the step-by-step procedure,
`round2-vm.sh` (VM checks) and `round2-report.ts` (request log + leak scan)
are in [`spikes/d-credential-proxy/`](../spikes/d-credential-proxy/README.md#vm-experiments-round-2-real-tokens).
Only the tokens and the run are left.
Merge `feature/proxy` into `main` first, then this branch. In `acceptClient`,
the cutoff check must stay before link handling.

**Goal:** a secret can be delivered *via the proxy*. The VM only holds a
placeholder (in its env / `.env`); the supervisor's MITM proxy swaps the
placeholder for the real token on requests to the hosts that secret is bound to
(exact or pattern match), and swaps real values back to the placeholder in
response headers. Real secrets never enter the VM.

Design: [`research/11-credential-proxy.md`](research/11-credential-proxy.md).

| Phase | Scope |
|---|---|
| Spike D ✓ | **Passed round 1 (2026-10-14)**; real-token round 2 pending. Placeholder-only env with real clients (git, gh, Claude Code, SDKs) through a hacked proxy: client acceptance, header encodings (incl. git's `Basic`), response redaction, overhead (`spikes/d-credential-proxy/`) |
| C1 ✓ | Schema: `secrets.delivery`, per-project `secret_placeholders`, `secret_bindings` (detailed tasks in `research/11` § Build plan) |
| C2 ✓ | Proxy: substitution (incl. Basic), unbound placeholder → approval prompt, response-header redaction, 🔑 in the request log |
| C3 ½ | Env file writes placeholders ✓ (done in C1). Not built, moved to the backlog: switching an existing secret between env ⇄ proxy, and a workdir `.env` writer |
| C4 ✓ | UI: delivery toggle, bindings editor with presets, placeholder display |
| C5 ✓ | README (Secrets, API, Known limitations), `research/05` §(e) marked built, spike harness retired |

### Also on this branch: network panel and controls

| Item | What it does |
|---|---|
| Network panel redesign ✓ | Project details → Network has three tabs: **Activity** (by host or all requests, filter, blocked-only), **Rules** (this project / all projects, expired hidden by default) and **Header rules**. Counts sit on the tabs, and the tab and view choices are remembered |
| Rule actions from activity ✓ | Allow / block / unblock a host from the activity list, for this project or all projects |
| Move rules between scopes ✓ | Move a rule between *this project* and *all projects* (`PATCH /api/projects/:id/net/rules/:rid`). If the target scope already has the same rule, the moved copy is dropped instead of duplicated |
| Internet cutoff ✓ | One-click switch on the project page that blocks all egress for the VM: CONNECT and HTTP are refused before rules are checked, and pending approvals are denied. Persisted (`projects.net_cutoff`), shown as "internet off" on the status card (`PUT /api/projects/:id/network`) |
| Persistent request log ✓ | Requests are stored in SQLite `net_requests` (metadata and secret names only, never headers, bodies or values), batched every second and flushed on shutdown. Kept for **≥ 7 days** (`SADBOX_NET_LOG_DAYS`), pruned hourly. Activity can show the last 24 hours or 7 days by host, and "Load older requests" pages back through history. The log survives restarts and rebuilds |

### Also on this branch: Vaults and agent sessions (built 2026-11-04)

Design: [`research/12-vaults.md`](research/12-vaults.md),
[`research/13-agent-sessions.md`](research/13-agent-sessions.md).

| Item | What it does |
|---|---|
| Vaults ✓ | Secrets replaced by one list of **variables** and **secrets**, typed string / number / json, per-item project access, eye-icon reveal (logged), editable |
| Proxy mode ✓ | Placeholder in the VM; swap in headers, and opt-in URL and body (typed in JSON); response headers **and bodies** redacted; the VM can never reach sadbox's own API |
| Fetch at runtime ✓ | `sadbox-vault get NAME` / `http://vault.sadbox.internal/v1/NAME`, answered by the proxy; a secret's first fetch asks; every read logged |
| Agent history ✓ | Claude / omp / opencode history kept under `~/.sadbox/agents/history/<name>`, mounted into the VM, kept across rebuild and destroy, back for a new project of the same name |
| Agent logins ✓ | Claude's login owned and refreshed by sadbox, VMs hold placeholders; omp / opencode API keys captured and copied in; **Agents** page |
| Env files ✓ | `.env` / `.env.*` never copied into a VM (create, rebuild, push) |
| Push to VM ✓ | Copy the folder's changed files into a running VM |
| Service status ✓ | Home page shows whether Apple's container service is up, and why not |

## Then: Linux support

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

**L0 — Spike E: CH + guest agent (de-risk)**
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
| 3 | **Vault KEK in Keychain** | Replace the data-dir keyfile on macOS (`research/05`); it now also protects the agent logins. Pairs with L4 on Linux. |
| 4 | **Non-git local folders** | tar-in copy + tar-out sync-back with `git diff --no-index` preview and backed-up apply (`research/06`). |
| 5 | **Live env-file / proxy-env rotation** | Items still written to the env file, and the proxy env, reach new shells only. |
| 6 | **Workdir `.env` writer** | Write a project's placeholder lines into `~/workdir/.env` for apps that read `.env` directly (sadbox-managed keys only). |
| 7 | **DB backup** | Litestream (or periodic snapshot) of the SQLite file (`research/07`). |
| 8 | **Scale measurements** | RAM/balloon behavior with 10+ idle VMs; workdir copy-in throughput for 1–2 GB repos (open questions #4, #5). |
