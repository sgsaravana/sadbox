# sadbox — Roadmap

> What has shipped, what is next, and the plan for Linux support.
> Last updated 2026-11-11. Design background lives in [`research/`](research/README.md).

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
| Git remote tokens in the vault ✓ | The token given for a project's remote becomes a proxy vault item (`GITHUB_TOKEN` with GitHub's hosts, `GITLAB_TOKEN`, or `GIT_TOKEN`), reused by name + value; the VM gets a placeholder via git's credential helper. Older projects' `~/.git-credentials` (a real token in the VM) are moved over and deleted on the next supervisor start |
| `vault.sadbox.internal` vs links ✓ | The proxy took the vault's own name for a link to a project called "vault", so `sadbox-vault`, `/v1/NAME` and git's credential helper got a 403 inside VMs. Fixed in `linkTarget`; covered by e2e.ts |
| Forwarded ports behind sign-in ✓ | A forward is HTTP for a browser signed in to sadbox by default: the UI hands out a one-time ticket, the forward trades it for a cookie for that port only (ends with the UI session), and sadbox's cookies never reach the app. WebSockets included. A forward can be opened to anyone (raw TCP) for non-HTTP servers. Existing forwards move behind sign-in |
| Bindings allow their hosts ✓ | A project with access to a proxy item is allowed to the item's bound hosts (host, path, method, expiry) without a network rule, so the first, unauthenticated `git clone` request isn't held. Derived at request time, shown read-only in Rules (🔑 vault · NAME); a block rule still wins |

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

**L0 — Spike E: CH + guest agent (de-risk)** — done on `feature/linux`
([`spikes/e-cloud-hypervisor/`](../spikes/e-cloud-hypervisor/README.md)). The guest
agent is chosen (option 2, a Go PID 1) and passes all 15 protocol checks
locally. Under CH on GitHub's x86_64 KVM runner (`spike-e.yml`) it passes all
15 too, Claude Code's TUI included: exec p50 1.7 ms, ping 0.7 ms. Boot time is
still to be measured cleanly. GitHub's arm64 runner has no KVM, so arm64 waits for other hardware.
- Boot the sadbox image under Cloud Hypervisor on an x86_64 and an arm64 KVM host.
- Pick the guest agent:
  1. Run Apple's `vminitd` under CH (one protocol on both platforms; open question #2 in `research/README`), or
  2. A small sadbox agent (Bun or Go) as PID 1 / init service.
- Prove the terminal chain end-to-end over vsock: PTY, resize, stdin streaming, byte streams.
- Measure cold boot and create→ready time against the macOS ≈ 1.2 s.
- Exit criterion: Claude Code TUI usable in the browser through a CH guest.

**L1 — Guest agent** — in progress on `feature/linux`. The agent lives in
[`guest/agent/`](../guest/agent/README.md) and its host client in
`src/driver/agent.ts`. Both are tested on macOS and Linux (`guest-agent.yml`),
the client against the real agent.
- Implement the operations the driver needs over vsock: `exec`, `execWithStdin`,
  `execCaptureBytes`, `stream`, `terminal` (PTY + resize), plus a
  host-dials-in socket channel for the proxy carriers (replaces `--publish-socket`).
  Done, with timeouts (exit 124) that hang up and kill the process.
- Readiness: the agent announces itself on a vsock port (`sadbox.announce=`), so
  the host needs no polling. Still to be confirmed under CH (`spike-e.yml`).
- Shutdown: processes get SIGTERM and up to 2 s to exit, instead of a flat 1 s.
- Linux-only: the macOS driver keeps `vminitd`. L2 bakes the agent into the
  Linux disk image, not into `images/base`.

**L2 — Image pipeline** — built on `feature/linux`; `sadbox setup` builds the disk on GitHub's KVM runner (`kvm.yml`)
- Dockerfile → OCI → ext4 rootfs + a guest kernel, multi-arch. Built: Docker builds
  the image, then [`images/disk`](../images/disk/Dockerfile) turns it into ext4
  with BuildKit alone (a bind mount of the image, `mkfs.ext4 -d`, output to a
  folder). It compiles the agent from the source embedded in the binary, so the host
  needs neither root nor Go. Checked on arm64 with Apple's builder: owners, setuid
  bits and the agent intact, `e2fsck` clean. The kernel is CH's pinned build, fetched by `sadbox setup`.
- Store under the data dir, versioned like the macOS image; replaces `container build` on Linux.
  Built: `~/.sadbox/kvm/images/<image>/` with the image's recipe hash, so
  `ensureBaseImage` rebuilds it when the Dockerfile changes, as on macOS.
- Per-project disk: copy-on-write clone of the base rootfs (reflink / qcow2 overlay) + workdir.
  Built: `cp --reflink=auto` (a sparse full copy on ext4), grown sparsely by
  the project's disk size, and the agent grows the filesystem at boot. One disk,
  not a separate workdir volume: the size caps the whole VM.
- Image operations (build, recipe, toolchain probe) moved behind the driver (`driver.images`).

**L3 — `driver/kvm`** — built on `feature/linux` ([`src/driver/kvm/`](../src/driver/kvm/index.ts)).
First run on real VMs (`kvm.yml`, GitHub x86_64, 2026-11-10): every check
passes on CH. Create → ready takes 7.0 s (most of it copying the 2.3 GB
disk onto ext4), a restart of a stopped VM 0.18 s, stop 0.05 s, destroy
0.13 s. Shared folders went untested there: Ubuntu 24.04's virtiofsd can't map
ids, and the runner's user is uid 1001.
- Full `ProjectDriver` over the CH REST API: create / destroy / start / stop /
  `setMemory` / inspect / list / stats. Built. Picked on Linux, or with `SADBOX_DRIVER=kvm`.
- One CH process per VM, supervised by sadbox; state reconciled on supervisor restart.
  Built: CH runs detached, a VM is a folder (`~/.sadbox/kvm/vms/<ref>`), and
  "running" means its API answers, so VMs outlive a supervisor restart.
  Stop asks the agent to power off, then CH, then kills it.
- `network: "none"` + vsock socket channel, so the existing proxy, approvals and
  port forwards work unchanged. Built: the host socket is served in the supervisor
  and spliced onto the agent's `connect`, and it survives the VM stopping.
- Stats from CH counters + the VMM's cgroup. Built: CH's disk counters, the VMM's
  CPU time, and the guest's memory and process count through the agent.
- Capability flags: `snapshot: true` (CH supports it), `sharedMount` optional (virtiofs).
  `sharedMount` when virtiofsd is installed and the guest user can write what it shares:
  virtiofsd 1.11+ maps ids, or the host user is uid 1000 like the image's.
  There is one virtiofsd per shared folder (a file is shared through its folder),
  bind-mounted by the agent. Without virtiofsd, agent history stays on the
  VM's disk and is copied out before the VM is destroyed, but it isn't copied
  into a new project of the same name. `snapshot` is still false (L7).
- Tested on any machine with a stand-in VMM (`test/fake-ch.ts`, which runs the real
  agent): create, exec, the socket, stats, stop / start, `setMemory`, destroy, and a
  VMM that fails to start. Real VMs: `kvm.it.test.ts`, run by `kvm.yml` after a
  `sadbox setup`.
- `sadbox setup` / `doctor` on Linux: they check `/dev/kvm` and docker, fetch CH
  and the kernel, build the image and its disk, and report virtiofsd.

**L4 — De-macOS the rest of the supervisor**
- Driver selection in `src/driver/index.ts` by platform / `SADBOX_DRIVER`.
- Move `container`-CLI assumptions behind the driver: toolchain probe
  (`src/core/toolchain.ts`, uses `container run`), base-image build context
  (`src/assets.ts`), `config.containerBin`.
- Secrets KEK: compose `secrets:` file on Linux (and Keychain on macOS), replacing the v0 keyfile (`src/crypto.ts`).
- Settings / vitals text that says "container" where it means "VM".

**L5 — Packaging & install** — built on `feature/linux-packaging`
- docker-compose: uncomment `/dev/kvm`, `/dev/net/tun`, `NET_ADMIN`; ship CH and kernel in the image.
  Built: a multi-stage `Dockerfile` (the compiled binary on Debian trixie, with CH, the
  kernel, virtiofsd 1.13 and the docker CLI). The compose file passes `/dev/kvm` only:
  VMs have no network, so `/dev/net/tun` and `NET_ADMIN` are not needed. It uses the
  host's network, so port forwards listen on the host, and the host's docker socket
  for image builds. `kvm.yml` runs the end-to-end test against the container too.
- Native install: `install.sh` on Linux fetches CH + kernel and checks `/dev/kvm`;
  optional systemd unit (counterpart of launchd). Built: `install.sh` checks `/dev/kvm`,
  docker, git, openssl and virtiofsd, says how to fix each, and points to `sadbox setup`
  (which fetches CH and the kernel). `sadbox service install` writes a systemd user unit
  with `KillMode=process`, so VMs survive supervisor restarts.
- README: supported-platforms table, Linux quick start, EC2 notes
  (nested virt on Intel C8i/M8i/R8i; Graviton needs `.metal`). Built.

**L6 — Testing & CI**
- A driver contract test suite run against both drivers (lifecycle, exec, PTY,
  stream, socket channel, stats).
- A Linux KVM CI job (GitHub-hosted Ubuntu runners expose `/dev/kvm`) that runs
  the suite plus a create → terminal → sync-back smoke test.

**L7 — Linux-only extras (after parity)**
- CH snapshot/restore for near-instant resume of stopped projects.
- Optional virtiofs shared mounts.

## Then: Intel Mac support — shipped in v0.5.0 (2026-11-12)

**Goal:** the same supervisor runs on an Intel Mac and makes its project microVMs
locally. Intel Macs cannot use Apple's `container` CLI (Apple silicon only,
macOS 26), but **Virtualization.framework runs Linux x86_64 guests on Intel
hosts**, and [`vfkit`](https://github.com/crc-org/vfkit) drives it. Design and
the alternatives that lost: [`research/14-intel-mac.md`](research/14-intel-mac.md).

**Why a third driver:** there is no `vminitd`/OCI stack to reuse on Intel; vfkit
boots a raw ext4 disk and exposes virtio-blk, virtio-vsock and virtio-fs — the
same primitives the KVM driver already speaks. The vz driver is a close sibling
of `driver/kvm`.

**Built** (`src/driver/vz/`, `images/kernel/`):

- create / destroy / start / stop / `setMemory` / inspect / list / stats — one
  vfkit process per VM, detached; a VM is a folder, so it outlives a supervisor
  restart. Liveness is vfkit's REST `GET /vm/state`.
- vsock: agent port 1024 with `connect` (vfkit opens a fresh guest connection per
  host connection, so the agent's one-operation-per-connection protocol is
  unchanged), announcement port 1025 with `listen` onto the host socket the
  supervisor already serves.
- virtio-fs shares straight from Virtualization.framework — no `virtiofsd`;
  `sharedMount: true`. The agent's existing `mount -t virtiofs` works.
- **Kernel: Debian's, built locally with Docker** (`images/kernel`) for the
  host's architecture, with virtio/vsock modules in the initramfs. The Cloud
  Hypervisor kernel the KVM driver uses **does not start under VZ** (VZ refuses
  its arm64 Image before the guest runs; proven 2026-11-11), so the two backends
  have separate kernels.
- Images: the same Docker → `images/disk` pipeline; Docker on an Intel Mac
  builds linux/amd64 natively. Disk clones use APFS `clonefile` (the code the
  KVM driver already had for macOS).
- `sadbox setup` / `doctor`, `SADBOX_DRIVER=vz` (default on Intel), `install.sh`,
  the Homebrew formula (`vfkit` on Intel, `container` on arm), README.
- Shared VM-as-folder code moved to `src/driver/vm.ts` and `src/driver/diskimages.ts`
  so the KVM and vz drivers cannot drift.
- Tests: `vz.test.ts` with `test/fake-vfkit.ts` (runs the real guest agent), and
  `vz.it.test.ts` against real VMs (`SADBOX_VZ_IT=<setup data dir>`). On Apple
  silicon: 12/12 pass, create 0.46–0.99 s, stop 0.05–0.10 s, start 0.42–0.92 s,
  destroy 0.06–0.11 s (with both Apple's Kata kernel and the built Debian one).

Tested by hand on an Intel Mac with v0.5.0 (2026-11-12): the amd64 kernel
and disk boot and projects run.

**Still to do:**
- CI: GitHub's `macos-26-intel` runners have Virtualization.framework but no
  Docker. Build the amd64 disk and kernel on the Linux x86_64 job, pass them as
  artifacts, and run `vz.it.test.ts` there.
- L6's contract suite now has three drivers to cover.

## Other planned work

Ordered roughly by priority. Each item is independent of Linux unless noted.

| # | Item | Notes |
|---|---|---|
| 1 | **Outbound WebSockets through the proxy** | Upgrade passthrough in `src/net/proxy.ts`, subject to the same rules/approvals. |
| 2 | **Vault KEK in Keychain** | Replace the data-dir keyfile on macOS (`research/05`); it now also protects the agent logins. Pairs with L4 on Linux. |
| 3 | **Non-git local folders** | tar-in copy + tar-out sync-back with `git diff --no-index` preview and backed-up apply (`research/06`). |
| 4 | **Live env-file / proxy-env rotation** | Items still written to the env file, and the proxy env, reach new shells only. |
| 5 | **Workdir `.env` writer** | Write a project's placeholder lines into `~/workdir/.env` for apps that read `.env` directly (sadbox-managed keys only). |
| 6 | **DB backup** | Litestream (or periodic snapshot) of the SQLite file (`research/07`). |
| 7 | **Scale measurements** | RAM/balloon behavior with 10+ idle VMs; workdir copy-in throughput for 1–2 GB repos (open questions #4, #5). |
