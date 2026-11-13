# 15 — Docker Sandboxes (`sbx`) vs Apple `container`, and vs sadbox

> **Status: research note, 2026-11-13.** Verified against the live docs and release artifacts of
> Docker Sandboxes **0.53.0** (2026-11-11; 0.54.0-rc4 was the current RC). No code changes follow
> from this doc. Verdict up front: **`sbx` is not a `container` replacement — it is a competing
> product one layer above sadbox — and it does not run on Intel Macs at all** (open request
> [docker/sbx-releases#286](https://github.com/docker/sbx-releases/issues/286), no reply, since
> 2026-06-30). sadbox keeps Apple `container` on Apple silicon, `vfkit` on Intel, Cloud Hypervisor
> on Linux.

## The question

Two questions arrived together:

1. Is Docker Sandbox an alternative — or a better option — instead of `container`?
2. Would that be an option on Intel Macs?

The useful answer is per layer: `container` is a primitive sadbox *drives*; `sbx` is a finished
supervisor-shaped product that sadbox *competes with*. Only the first framing ("swap the driver")
makes `sbx` a candidate, and there it fails on both interface and platform.

## What Docker Sandboxes actually is

A Docker Inc. product (proprietary license; `sbx` CLI + a local daemon) that runs **one AI coding
agent per microVM**, with its own Docker Engine inside, a host-side egress proxy, and credential
injection:

- **Local sandboxes** — a microVM per sandbox on the developer machine. `sbx run claude`,
  `sbx run codex`, `sbx run shell`, or a published kit (`docker.io/sbx/<name>:latest`) as of 0.51.
  Agents work in YOLO mode by default: *the VM is the safety boundary*, not permission prompts.
- **Cloud sandboxes** — the same model on Docker-managed compute, pay-as-you-go.
- **Per-sandbox Docker Engine** — the agent can `docker build`/`compose up` with no path to the
  host daemon. This is the capability sadbox deliberately does not have.
- **Workspace modes** — direct read-write mount (the default; `sbx run` mounts your cwd),
  `--clone` (repo mounted read-only, agent works in a private clone, changes come back over a
  `sandbox-<name>` git remote), or mountless.
- **Network** — every outbound TCP flow crosses a host proxy, deny-by-default, with presets
  (`balanced`, `locked down`) and per-destination rules; approvals exist for new destinations; UDP
  is experimental, ICMP is blocked.
- **Credentials** — the agent sees a *sentinel*; the host proxy swaps in the real value on the way
  out, so API keys never enter the VM. SSH agent forwarding is on by default (sockets only).
- **Surfaces** — CLI, a TUI dashboard (`sbx` with no args), `sbx cp`/`exec`/`ports`, environment
  files (`sbxenv.yaml`), kits, an MCP gateway, and SSH for attaching VS Code/Cursor. **There is no
  browser UI.**
- **Requirements** — macOS 14+ **Apple silicon**, Windows 11 x64 (+ Hypervisor Platform), or
  Ubuntu 24.04+/Rocky 8 with KVM. Docker Desktop/Engine is *not* required. `sbx login` (Docker
  account) is mandatory; local CLI and compute are free including commercial use; telemetry is
  on by default and can be disabled.

Internals, as far as public sources show: it is a **containerd shim running a microVM** — daemon
logs in GitHub issues show `containerd-shim-nerdbox-*`, a `sailor` VMM supervisor, a `vminitd`
guest init and EROFS guest rootfs, with the local daemon (`sandboxd`) talking over a private unix
socket. So it is not a wrapper around Apple's `container`; Docker built its own VM boundary into
the container runtime stack. The code is closed.

## Is it a replacement for `container`?

No — they are different layers, and only one of them is an interface sadbox can call.

| | `container` (Apple) | `sbx` (Docker) |
|---|---|---|
| What it is | container runtime + per-container VM, Apache-2.0 | finished agent-sandbox product, proprietary |
| Shape | create/boot/exec/cp/rm one VM at a time | one agent per sandbox, CLI/TUI, daemon |
| Embedding | CLI (JSON in places), stable-ish, ours to pin | no documented local API; public API/SDK is **cloud-only**, paid |
| sadbox uses it for | `ProjectDriver` (VM, vsock agent, virtiofs, disk) | n/a — it already *contains* a driver, proxy, and policy engine |
| Platform | Apple silicon, macOS 26 | Apple silicon macOS 14+, Windows x64, Linux x64/arm64 |

"Use `sbx` instead of `container`" therefore means **replacing sadbox with `sbx`**, not swapping a
backend. `src/driver/container.ts` is thin because `container` is a primitive; `sbx` would be a
peer, and it would own the two things that are sadbox's whole design: the egress proxy and the
credential model.

### Could sadbox script `sbx` the way it scripts `container`?

Technically yes — `sbx create`/`exec`/`cp`/`stop`/`rm` are CLI verbs, and a `sbx` driver could be
written like the `container` one. It loses on everything else:

- **No local API.** Only the CLI and TUI are documented; the daemon socket is private. A driver
  would be permanently fragile against product-level CLI changes.
- **Two competing proxies.** sadbox's vault/MITM proxy and `sbx`'s policy proxy would both want to
  be the only path out, and `sbx`'s wins (it is inside the VM boundary). Vaults as shipped would
  become unenforceable.
- **No browser terminal.** The tmux-over-WebSocket UI, project detail view and editor are the
  product; `sbx` exposes a TUI and SSH.
- **Account, license, telemetry.** sadbox would inherit Docker sign-in as a hard dependency, plus a
  proprietary runtime in the trust path.
- **Platform.** No Intel Mac (below), so it cannot replace either macOS driver.

Verdict: not a driver. It is the closest thing to "sadbox, but Docker's", and the right response is
differentiation, not adoption.

## So how does sadbox compare?

Honest scoreboard, sadbox 0.5.0 vs `sbx` 0.53:

| | sadbox | Docker Sandboxes |
|---|---|---|
| Isolation | microVM per project | microVM per sandbox — **equal** |
| Egress | MITM proxy, block-by-default, time-boxed approvals, rewrite rules, live log | host proxy, deny-by-default, presets, rules, approvals — **equal** |
| Secrets | vaults: placeholders swapped at the proxy; fetch-at-runtime items; agent logins owned by the supervisor | sentinel swapped at the proxy; `sbx secret`; SSH agent forwarding — **equal** |
| Inner Docker | none (deliberate: no network, no daemon) | per-sandbox Engine — **sbx ahead** |
| Workspace | copy in; sync back as uncommitted changes; source tree never touched | direct RW mount by default; `--clone` for a boundary — **sadbox's default is safer** |
| UI | browser: tmux terminal, editor with git, per-project stats, Home/settings | CLI + TUI + SSH; **no browser** — **sadbox ahead** |
| Multi-project supervisor | yes, one long-lived box, LAN + Caddy + sign-in | one sandbox at a time per invocation (plus cloud) — **sadbox ahead** |
| Agents | Claude Code baked in, logins/history kept per project | many agents as kits; history stays in the sandbox — **sbx ahead on breadth** |
| Enterprise controls | none | org network/filesystem/MCP policy, audit logs (paid) — **sbx ahead** |
| Hosts | Apple silicon, **Intel Mac**, Linux x64 KVM | Apple silicon, Windows x64, Linux x64/arm64, cloud — **sbx ahead on breadth, sadbox on Intel** |
| Dependencies | `container` / `vfkit` / Cloud Hypervisor, all open | Docker account + proprietary `sbx` |
| License / telemetry | Apache-2.0 pieces, no account | proprietary, sign-in required, telemetry opt-out |

### The convergence is the interesting part

Two teams, independently, landed on the same five decisions:

1. **microVM, not shared kernel** — the agent gets root inside and cannot reach the host.
2. **A host-side egress proxy, deny-by-default**, with interactive approval for new destinations.
3. **Credentials as placeholders inside the VM**, real values injected on the wire, never readable
   by the agent.
4. **Explicit workspace modes** — nothing shared, shared in place, or a private clone.
5. **A prebaked agent image** (sadbox bakes Claude Code; `sbx` ships agent kits).

That is a strong signal the design in `docs/research/` is right, and it also means the *sandbox
layer* is no longer differentiation. What is left, and is real:

- **Browser-first, always-on, multi-project** — a box with many projects, one terminal per tab, an
  editor, stats, from any device on the LAN. `sbx` is a local CLI for a developer's laptop and a
  paid cloud for everything else; there is no self-hosted supervisor.
- **Copy, never mount, by default** — `sbx`'s default mode writes the agent's edits straight into
  your working tree, including `.git/hooks` and CI config, which its own docs warn about.
- **No account, no licence, no telemetry** — everything sadbox shells out to is open source.
- **Intel Macs** — see below.
- **Your own Linux host / EC2** — `docker compose up` on a Hetzner box with KVM, no vendor compute.

## Intel Macs

Not an option today, and not plausibly soon:

- The macOS prerequisite is **"Apple silicon"**, macOS 14+. Every macOS artifact is
  `DockerSandboxes-darwin-arm64.*`; there is no `darwin-amd64`. The Homebrew cask pins
  `depends_on arch: :arm64`. Windows and Linux do ship x86_64 builds — macOS does not.
- [docker/sbx-releases#286 — "Add support for Intel-based Macs (x86_64)"](https://github.com/docker/sbx-releases/issues/286)
  was opened 2026-06-30, has **zero maintainer replies**, and is open. Reactions are 👍 6 / ❤️ 1;
  there is no roadmap entry.
- Cloud sandboxes do not rescue it: the CLI itself is arm64-only on macOS.
- Even if Docker built it, they would need what sadbox already has — a Virtualization.framework path
  on Intel (sadbox uses `vfkit`; see [14-intel-mac.md](14-intel-mac.md)) — on a platform whose last
  macOS release is 26.

So the Intel answer is unchanged: `SADBOX_DRIVER=vz` locally, or a Linux/KVM host with the browser
as the client.

## What to watch (and what to borrow)

Watch:

1. **A local API/SDK for `sbx`.** Today the API is cloud-only. A documented local daemon API would
   make a driver possible — and would also let Docker ship an official UI.
2. **A browser surface.** A hosted dashboard over local sandboxes is the one thing that would turn
   this into a direct competitor on sadbox's home turf.
3. **Intel for macOS.** Unlikely, and only relevant to users on 2018–2020 hardware.
4. **`container`'s scope.** If Apple's CLI grows policy/proxy features, the same analysis applies at
   a lower layer.

Borrow, in rough order of value:

1. **Editor attach over SSH** — let a project be opened in the user's own VS Code/Cursor, not only
   the in-browser editor. Small, high user value, no new isolation surface.
2. **Optional inner Docker per project** — agents increasingly need `docker build`; today sadbox
   cannot do it at all. A per-project, network-less daemon inside the VM (as `sbx` does) is the
   clean version of this.
3. **Kit-like environment files** — `sbxenv.yaml` as a checked-in, shareable per-project
   environment declaration maps well onto sadbox's image + tools settings.

## Recommendation

1. **Do not adopt `sbx`** as a driver or as a replacement for `container`. It is a competing
   product, closed, account-gated, without a local API, and Apple-silicon-only.
2. **Keep the current driver split** — `container` (Apple silicon, macOS 26), `vz`/`vfkit` (Intel,
   macOS 15+), Cloud Hypervisor (Linux KVM) — and say in the README that sadbox's isolation choices
   now match the industry consensus, because they do.
3. **Compete on the supervisor, not the sandbox**: browser terminal + editor, always-on
   multi-project box, copy-in/copy-back default, no account, self-hosted, Intel included.
4. **Re-read this doc** if `sbx` grows a local API, a browser UI, or an Intel build.

## Sources

- Docker Sandboxes docs: https://docs.docker.com/ai/sandboxes/
- Install and prerequisites (macOS "Apple silicon", macOS 14+; Windows; Ubuntu/KVM):
  https://docs.docker.com/ai/sandboxes/install/
- Architecture — microVM per sandbox, workspace passthrough, host proxy, credential injection:
  https://docs.docker.com/ai/sandboxes/architecture/
- Security model — trust boundaries, workspace modes, five isolation layers:
  https://docs.docker.com/ai/sandboxes/security/
- Isolation layers — per-sandbox Docker Engine, clone mode, credential isolation:
  https://docs.docker.com/ai/sandboxes/security/isolation
- FAQ — free local use, mandatory sign-in, telemetry, headless Linux secrets:
  https://docs.docker.com/ai/sandboxes/faq/
- Cloud-only API/SDK: https://docs.docker.com/ai/sandboxes-api/
- Releases and artifacts (`darwin-arm64` only, license "Proprietary — Docker Inc."):
  https://github.com/docker/sbx-releases and
  https://github.com/docker/sbx-releases/releases/tag/v0.53.0
- Intel Mac request, open, no maintainer reply:
  https://github.com/docker/sbx-releases/issues/286
- Containerd shim / `sailor` / `vminitd` evidence in public daemon logs:
  https://github.com/docker/sbx-releases/issues/655 and
  https://github.com/docker/sbx-releases/issues/587
- sadbox's own backends: [01-virtualization-backends.md](01-virtualization-backends.md),
  [14-intel-mac.md](14-intel-mac.md), `src/driver/{container,vz,kvm}/`
