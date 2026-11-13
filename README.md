# sadbox

Supervisor for **microVM AI-agent sandboxes** on Macs (Apple silicon and Intel)
and on Linux hosts with KVM (see [Supported platforms](#supported-platforms)). Spin up
isolated Linux microVMs — each one a **project** — with a copy of a source
folder and Claude Code + toolchain baked in; watch and steer the agent through
a browser terminal attached to tmux inside the VM; give it vault variables and
secrets it can use but never read; keep agents' logins and history across VMs;
copy the agent's work back into your folder on demand, as uncommitted changes
for you to review, without the agent ever touching your original folder.

Projects are real VMs (own kernel, own memory) — not shared-kernel containers:
Apple's Virtualization.framework through the open-source
[`container`](https://github.com/apple/container) CLI on an Apple silicon Mac,
through [`vfkit`](https://github.com/crc-org/vfkit) on an Intel Mac, and
[Cloud Hypervisor](https://www.cloudhypervisor.org) on KVM on Linux.

## Index

- [Status](#status)
- [Releases](#releases)
- [Supported platforms](#supported-platforms) — [EC2 and other clouds](#ec2-and-other-clouds)
- [Requirements](#requirements)
- [Install](#install)
  - [Option 1 — install script (prebuilt binary)](#option-1--install-script-prebuilt-binary)
  - [Option 2 — download the binary yourself](#option-2--download-the-binary-yourself)
  - [Option 3 — from source](#option-3--from-source)
  - [Installing a beta (pre-release)](#installing-a-beta-pre-release)
    - [Intel Mac (macOS 15+) — beta](#intel-mac-macos-15--beta)
    - [Apple silicon and Linux — beta](#apple-silicon-and-linux--beta)
    - [Or download the pre-release binary by hand](#or-download-the-pre-release-binary-by-hand)
    - [What a beta is, and is not](#what-a-beta-is-and-is-not)
  - [Linux, with docker compose](#linux-with-docker-compose)
  - [Updating](#updating)
- [First run](#first-run)
  - [Sign-in password](#sign-in-password)
  - [CLI](#cli)
- [Building & releasing](#building--releasing)
- [How it works](#how-it-works)
  - [Source, folder and sync](#source-folder-and-sync)
  - [Terminal and editor](#terminal-and-editor)
  - [Git in the editor](#git-in-the-editor)
  - [Approvals while you work](#approvals-while-you-work)
  - [Agents baked in](#agents-baked-in)
  - [Vaults](#vaults)
  - [Agent logins and history](#agent-logins-and-history)
  - [Git setup and sync-back](#git-setup-and-sync-back)
  - [Project detail view](#project-detail-view)
  - [Network proxy and isolation](#network-proxy-and-isolation)
  - [Port forwards and project links](#port-forwards-and-project-links)
  - [Sign-in and sessions](#sign-in-and-sessions)
- [API](#api)
- [Deploying](#deploying)
  - [Linux: run at boot (systemd)](#linux-run-at-boot-systemd)
  - [macOS: run at boot (launchd)](#macos-run-at-boot-launchd)
  - [The container image](#the-container-image)
  - [Serving to the LAN behind Caddy (Mac mini home server)](#serving-to-the-lan-behind-caddy-mac-mini-home-server)
- [Known limitations (v0)](#known-limitations-v0)

## Status

v0 — the full vertical slice works: create → browser tmux terminal →
vault → agent logins & history → git sync-back → destroy, with a browser editor that can stage,
commit, push, switch branches, stash and discard inside the VM. The web UI opens on a **Home** overview
(intro, feature tour, and quick-start) and has a side nav with a nested
project list, Vaults, Agents, and Settings (default VM CPU/memory/disk for new projects),
plus a per-project detail view with live CPU/memory/disk/network usage and
tmux state. Every VM's egress is routed through the supervisor as a **filtering
MITM proxy** — block-by-default with interactive, time-boxed approvals, allow/
block + header-rewrite rules (global or per-project), and a live request log on
the detail view. **Vaults** hold variables and secrets that a VM can use but
not read: a *proxy* item is only ever a placeholder in the VM, swapped for the
real value on the way out to the hosts it may reach; a *fetch* item is read on
demand (`sadbox-vault get`), and a secret asks you first. **Agents**: sadbox
keeps the agents' logins (Claude's it owns and refreshes, handing VMs
placeholders) and each project's agent history, which a new VM of the same
name picks up. See `docs/research/` for the design research and `spikes/` for
the de-risk experiments behind each piece, and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for what's next. It runs on Apple silicon and Intel Macs, and on Linux hosts
with KVM (see [Supported platforms](#supported-platforms)).

## Releases

<!-- LATEST_RELEASE:START -->
**Latest release: [v0.5.1](https://github.com/sgsaravana/sadbox/releases/tag/v0.5.1)** · published 2026-11-13 · [release notes →](https://github.com/sgsaravana/sadbox/releases/tag/v0.5.1)
<!-- LATEST_RELEASE:END -->

Every release ships prebuilt binaries for macOS/Linux (arm64/x64) plus
`SHA256SUMS`, built by [`release.yml`](.github/workflows/release.yml). Cut one
either way:

- **push a tag** — `git tag vX.Y.Z && git push origin vX.Y.Z`; or
- **publish a release in the GitHub UI** — the tag can be created there, and the
  build attaches the binaries to the release while keeping the notes you wrote.

Both paths run the same build. A tag with a dash (`vX.Y.Z-beta.1`) is published
as a **pre-release** either way: never `/releases/latest`, no version bump on
`main`, no Homebrew update. If an event is missed, the workflow's manual run
takes the tag as input.

[`release.yml`](.github/workflows/release.yml) and
[`update-readme-release.yml`](.github/workflows/update-readme-release.yml)
rewrite the line above either way — on a tag push, and when a release is
published from the UI. Pre-releases are ignored.
Browse them all on the [releases page](https://github.com/sgsaravana/sadbox/releases).

## Supported platforms

Every project is a real microVM. sadbox makes them with Apple's
[`container`](https://github.com/apple/container) tool on an Apple silicon Mac,
with [`vfkit`](https://github.com/crc-org/vfkit) (Virtualization.framework) on an
Intel Mac, and with [Cloud Hypervisor](https://www.cloudhypervisor.org) on KVM on
Linux. The rest (the proxy, vaults, agents, the UI) is the same everywhere.

| Platform | Project VMs | Notes |
|---|---|---|
| **Mac, Apple silicon (M1 or later), macOS 26+** | ✅ **Supported** | Through Apple's `container` CLI. |
| **Linux x86_64 with KVM** (bare metal, a home server, a cloud VM with nested virtualization) | ✅ **Supported, new** | Cloud Hypervisor microVMs. Tested on Ubuntu 24.04 in CI on real VMs. Runs natively or [in docker compose](#linux-with-docker-compose). |
| Linux arm64 with KVM (e.g. Graviton `.metal`) | ⚠️ Untested | Built for it, but not yet run on an arm64 KVM host. |
| Linux without `/dev/kvm` | ❌ | No hardware virtualization: see [EC2 and other clouds](#ec2-and-other-clouds). |
| **Mac, Intel (2018+, macOS 15+)** | ✅ **Supported, new in 0.5.0** | Virtualization.framework through `vfkit`, so `container` is not needed; Docker is. Tested by hand on an Intel Mac with v0.5.0. |
| Mac, Apple silicon, macOS 15 | ⚠️ Opt-in | Apple's `container` CLI needs macOS 26; `SADBOX_DRIVER=vz` uses the same vfkit driver as Intel (arm64 guest), with Docker. |
| Mac, macOS 14 or earlier | ❌ | Below vfkit's supported macOS floor (15) and Apple `container`'s (26). |
| Docker on a Mac | ❌ | A container there cannot reach the Mac's hypervisor; run sadbox natively. See [Deploying](#deploying). |
| Windows | ❌ | No build, none planned. |

### EC2 and other clouds

A cloud VM needs KVM inside it (`ls /dev/kvm`):

- **AWS:** nested virtualization on the Intel C8i / M8i / R8i families, or any
  `.metal` instance (the only way on Graviton).
- **GCP / Azure:** instance types with nested virtualization enabled.
- **GitHub Actions:** the x86_64 Ubuntu runners have `/dev/kvm` (sadbox's own CI
  uses them); the arm64 ones do not.

## Requirements

On a Mac:

- **Apple silicon, macOS 26+**: Apple's
  [`container`](https://github.com/apple/container) CLI — `brew install container`
- **Intel (2018 or later), macOS 15+**: [`vfkit`](https://github.com/crc-org/vfkit)
  (`brew install vfkit`; `sadbox setup` also fetches a pinned build) and
  Docker installed **and running** — [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/),
  or [colima](https://github.com/abiosoft/colima) with the docker CLI and its
  buildx plugin (`brew install docker docker-buildx colima`) — `sadbox setup`
  builds the guest kernel and the VM disk with it (BuildKit is required).
  Supported since 0.5.0; see [Supported platforms](#supported-platforms)
- **Apple silicon, macOS 15**: Apple's `container` CLI needs macOS 26; use the
  vfkit path instead by setting `SADBOX_DRIVER=vz` on every command (see
  [First run](#first-run)), with `vfkit` and Docker as above
- `git`, and `openssl` on PATH (both ship with macOS / the Xcode command line
  tools) — the egress proxy uses openssl to mint its CA and certificates
- [Bun](https://bun.com) ≥ 1.3.5 — only if you run from source

On Linux:

- `/dev/kvm`, usable by your user (`sudo usermod -aG kvm $USER`, then log in again)
- [Docker](https://docs.docker.com/engine/install/), usable by your user, with
  the buildx plugin (`docker-buildx-plugin` from that repository): it builds
  the VM image and disk (`sudo usermod -aG docker $USER`)
- `git`, `openssl`, `curl`
- optional: `virtiofsd` 1.11 or later (or your user being uid 1000), so agent
  history is kept on the host. Without it the history stays in each VM and is
  copied out before the VM is destroyed.
- Cloud Hypervisor and its guest kernel are fetched by `sadbox setup` (pinned
  versions, into `~/.sadbox/kvm`)

## Install

### Option 1 — install script (prebuilt binary)

On an Apple silicon Mac (macOS 26+):

```sh
brew install container
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh
```

On an Intel Mac (macOS 15+), or Apple silicon on macOS 15 with
`SADBOX_DRIVER=vz`:

```sh
brew install vfkit
# Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/),
# or colima: brew install docker docker-buildx colima && colima start
# Install/start one of them once before running sadbox setup.
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh
```

On Linux, install `/dev/kvm` access and Docker first (see
[Requirements](#requirements)).

This downloads the latest release binary for your platform into
`~/.local/bin/sadbox`; the script then checks the tools that host needs
(`container`, or `vfkit` + Docker; `/dev/kvm` + Docker + virtiofsd) and says how
to fix what is missing. If the script says that directory is not on your `PATH`,
add it as shown. To pin a version or change the location:

```sh
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh \
  | SADBOX_VERSION=v0.5.1 SADBOX_BIN_DIR=/usr/local/bin sh
```

For a pre-release, see
[Installing a beta (pre-release)](#installing-a-beta-pre-release) — the plain
command above always installs the last stable release.

### Option 2 — download the binary yourself

Grab `sadbox-darwin-arm64` (Apple silicon) or `sadbox-darwin-x64` (Intel) from
the [releases page](https://github.com/sgsaravana/sadbox/releases/latest), check
it against `SHA256SUMS`, and put it on your `PATH`:

```sh
bin=sadbox-darwin-arm64                 # Intel Macs: sadbox-darwin-x64
shasum -a 256 "$bin"                    # compare with the line in SHA256SUMS
chmod +x "$bin"
xattr -d com.apple.quarantine "$bin" 2>/dev/null   # browser downloads only
mv "$bin" ~/.local/bin/sadbox
```

The binary is not signed or notarized, so a copy downloaded with a browser is
quarantined by macOS; the `xattr` line clears that. (`curl` downloads, including
the install script, are not quarantined.)

This only installs the supervisor: on Intel (or with `SADBOX_DRIVER=vz`) also
install `vfkit` and Docker, as in [Requirements](#requirements).

On Linux, take `sadbox-linux-x64` (or `-arm64`) the same way, with
`sha256sum` to check it and no `xattr` step.

### Option 3 — from source

For development, or to run changes that are not in a release yet:

```sh
git clone https://github.com/sgsaravana/sadbox.git && cd sadbox
bun install
bun run setup      # same as `sadbox setup`
bun run start      # same as `sadbox serve`  (bun run dev to reload on change)
```

On an Intel Mac this uses the vfkit driver automatically; on Apple silicon with
macOS 15, prefix both with `SADBOX_DRIVER=vz` (see [Requirements](#requirements)).
Docker must be running for `bun run setup`. `bun run compile` builds the same
single-file binary into `dist/sadbox`; the web UI and base-image recipe are
embedded, so it runs without the checkout.

A Homebrew formula is kept in `packaging/homebrew/sadbox.rb`, but it is not
published to a tap yet, so `brew install` of sadbox itself is not available.

### Installing a beta (pre-release)

A tag with a dash — `vX.Y.Z-beta.1` — is published as a GitHub **pre-release**.
It is not `/releases/latest`, so:

- the plain install script keeps installing the last **stable** release;
- the Homebrew formula and the README's "latest release" line stay on stable;
- the beta is only reachable by its tag, from the
  [releases page](https://github.com/sgsaravana/sadbox/releases) under
  **Pre-releases**.

In the commands below, replace the `X.Y.Z-beta.1` placeholder with the tag of
the beta you are installing.

#### Intel Mac (macOS 15+) — beta

Install it beside your stable copy, with its own state directory, so the two
never share a database or VM disks:

```sh
# once: Docker Desktop installed and running, and vfkit
brew install vfkit

# the beta binary, in its own bin dir
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh \
  | SADBOX_VERSION=vX.Y.Z-beta.1 SADBOX_BIN_DIR="$HOME/.local/bin-beta" sh

export PATH="$HOME/.local/bin-beta:$PATH"
sadbox version                      # X.Y.Z-beta.1

export SADBOX_DATA="$HOME/.sadbox-beta"
export SADBOX_DRIVER=vz             # the default on Intel; explicit is fine
sadbox setup                        # builds the Debian kernel + VM disk (Docker)
sadbox serve                        # http://localhost:7070
```

`sadbox setup` takes a few minutes the first time (guest kernel + base image
disk); later betas reuse Docker's build cache. Keep `SADBOX_DATA` and
`SADBOX_DRIVER` set for every beta command — `doctor`, `serve`, a service, and
so on. When you are done, open a new shell (or drop `~/.local/bin-beta` from
`PATH` and unset both variables), then remove `~/.sadbox-beta` and
`~/.local/bin-beta` to clean up.

To move to a newer beta, rerun the install script with the new
`SADBOX_VERSION` and the same `SADBOX_BIN_DIR`; the data dir is kept.

#### Apple silicon and Linux — beta

Same idea; only the backend differs (Apple `container` on Apple silicon,
Cloud Hypervisor + `/dev/kvm` + Docker on Linux). On Apple silicon running
macOS 15, also `export SADBOX_DRIVER=vz` — there is no Apple `container` there.

```sh
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh \
  | SADBOX_VERSION=vX.Y.Z-beta.1 SADBOX_BIN_DIR="$HOME/.local/bin-beta" sh

export PATH="$HOME/.local/bin-beta:$PATH"
export SADBOX_DATA="$HOME/.sadbox-beta"
sadbox version
sadbox setup
sadbox serve
```

#### Or download the pre-release binary by hand

```sh
ver=vX.Y.Z-beta.1
mkdir -p "$HOME/.local/bin-beta"
curl -fLO "https://github.com/sgsaravana/sadbox/releases/download/$ver/sadbox-darwin-x64"
curl -fLO "https://github.com/sgsaravana/sadbox/releases/download/$ver/SHA256SUMS"
shasum -a 256 sadbox-darwin-x64    # compare with its line in SHA256SUMS
chmod +x sadbox-darwin-x64
xattr -d com.apple.quarantine sadbox-darwin-x64 2>/dev/null   # browser downloads only
mv sadbox-darwin-x64 "$HOME/.local/bin-beta/sadbox"
```

Use `sadbox-darwin-arm64` on Apple silicon, `sadbox-linux-x64`/`-arm64` on
Linux. The binaries are unsigned like the stable ones; the `xattr` line is only
needed for a browser download.

`gh release download "$ver" -p 'sadbox-darwin-x64'` does the same if you have
the GitHub CLI.

#### What a beta is, and is not

- It reports the pre-release version (`sadbox version` → `X.Y.Z-beta.1`).
- `install.sh` without `SADBOX_VERSION` still gives you stable; a beta never
  becomes `/releases/latest`.
- It may migrate `~/.sadbox` forward. That is why the steps above use
  `SADBOX_DATA`; a beta pointed at your stable data dir can leave the stable
  binary unable to open it.
- Betas can be deleted later:
  `gh release delete vX.Y.Z-beta.1 --cleanup-tag` (or the releases page).

### Linux, with docker compose

The supervisor runs in a container. Each project is still its own Cloud
Hypervisor microVM on the host's KVM, with its own kernel. Only the Cloud
Hypervisor processes that run the VMs live in the container, alongside the
supervisor:

```sh
git clone https://github.com/sgsaravana/sadbox.git && cd sadbox
docker compose build
docker compose run --rm sadbox sadbox setup   # builds the VM image (a few minutes, once)
SADBOX_PASSWORD='choose-a-password' docker compose up -d   # http://localhost:7070
```

- Without `SADBOX_PASSWORD`, the first start generates a password: it is in
  `docker compose logs sadbox` and in `/data/initial-password` in the container.
- It uses the host's network, so port forwards listen on the host directly, and the
  UI stays on localhost unless you set `SADBOX_HOST`.
- The host's docker socket is mounted in to build the VM image. Whoever controls the
  container controls the host.
- Local folders to create projects from must be under `SADBOX_PROJECTS` (default
  `/srv/sadbox/projects`), which is mounted at the same path inside. Projects
  cloned from a git URL need nothing.
- The VMs' Cloud Hypervisor processes live in the container, so the VMs stop when it
  does (an upgrade, `docker compose down`). Their disks are kept in the `sadbox-data` volume:
  start them again from the UI. A native install, below, keeps VMs running
  across supervisor restarts.

### Updating

Your projects, vault, agent logins and history live in `~/.sadbox` and are
kept across updates; nothing there needs to be exported or migrated by hand.

1. **Stop the supervisor**: Ctrl-C on `sadbox serve` (or unload its launchd
   job — see [macOS: run at boot](#macos-run-at-boot-launchd); on Linux,
   `systemctl --user stop sadbox`). Running VMs keep running — agents and
   terminals in them carry on — and reconnect when the supervisor is back.
   (Not under docker compose: there the VMs stop with the container and are
   started again from the UI.)
2. **Install the new version** the way you installed it:
   - install script: run the same command again —
     `curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh`
     (add `SADBOX_VERSION=vX.Y.Z` before `sh` for a given release);
   - downloaded binary: replace it with the new one, as in
     [Option 2](#option-2--download-the-binary-yourself);
   - from source: `git pull && bun install`.
3. **Start it again** — `sadbox serve` (or load the launchd job, or
   `systemctl --user start sadbox`) — and check `sadbox version`. With docker
   compose: `git pull && docker compose build && docker compose up -d`.

What happens on its own:

- The database is migrated when the new version starts.
- If the release changed the **base image** (new tools in the VM), it is
  rebuilt before the next project is created or rebuilt — that one create
  takes a few minutes longer. No `sadbox setup` is needed.

What does not:

- **Existing VMs stay on the image they were built from.** **Rebuild** a
  project to give it the new base image; a create or rebuild also brings
  Claude Code, omp and opencode to their latest releases. Rebuild keeps the
  project's vault access, network rules, agent history and logins, but
  replaces the VM's disk — sync back or push what you want to keep first.
- The programs sadbox puts in a VM (`sadbox-vault`, git's credential helper,
  the proxy relay) are rewritten when the VM starts, not while it keeps
  running across the update: **Stop** then **Start** a project to give it
  the new ones without a Rebuild.

Pre-releases are installed and updated on their own track — see
[Installing a beta (pre-release)](#installing-a-beta-pre-release).

## First run

```sh
sadbox setup     # checks dependencies, starts the VM backend, builds the base image (a few minutes, once)
sadbox serve     # http://localhost:7070
```

What `sadbox setup` does per backend:

- **Apple silicon**: starts Apple's `container` service and builds the base
  image.
- **Intel** (the default there): builds the guest kernel + initramfs and the
  base image's disk with **Docker, which must be running**.
- **Linux**: fetches Cloud Hypervisor and its kernel, and turns the base image
  into the disk VMs boot from with Docker.

Run it as yourself, not with `sudo`: the supervisor's state (database, vault,
agent logins, VM disks) lives in `~/.sadbox`. Expect a few GB for the base
image in Docker and its disk under `~/.sadbox` (project disks are sparse and
grow as they are used).

On Apple silicon running macOS 15, no Apple `container` exists; use the vfkit
backend explicitly — the same two commands, and the same prefix for anything
that runs the supervisor:

```sh
SADBOX_DRIVER=vz sadbox setup
SADBOX_DRIVER=vz sadbox serve
```

To keep sadbox running in the background and start it at boot, use
`sadbox service install` on Linux (a systemd user unit) or a launchd job on a
Mac; both are in [Deploying](#deploying).

The first `sadbox serve` generates a sign-in password, prints it once, and
saves it in `~/.sadbox/initial-password` (see [Sign-in password](#sign-in-password)
below). Use it to sign in, or set your own with `sadbox passwd`. Then, in the
browser:

1. **Create a project** under **Projects**: give it a name and either a local
   folder that is a git repository with at least one commit, or a git URL to
   clone. Tick any **vault** items it should use (add them under **Vaults**
   first — API keys, tokens, settings).
2. Open **Terminal ↗** and run `claude` (or `omp`, `opencode`). The first time,
   `/login` in Claude: sadbox keeps that login and every VM after this one is
   logged in already (see [Agent logins](#how-it-works)). The first
   requests to each new host wait for your approval — a popup appears right
   in the terminal and editor tabs (and in the **Network** panel on the
   project's page).
   Egress is blocked by default.
3. When you like the result, **Sync back**: the VM's workdir is copied into
   your folder as ordinary, uncommitted file changes — review them with
   `git diff` and commit what you want. Nothing is committed for you, in the VM
   or in your repo, and uncommitted work of yours in the folder is never
   overwritten: the sync stops and lists what is in the way.

`sadbox doctor` reports what is missing if something does not start. sadbox
listens on localhost only by default; see [Deploying](#deploying) before
exposing it to other machines.

To update, see [Updating](#updating). To uninstall, remove the binary and
`~/.sadbox`.

### Sign-in password

The web UI and API need a password (one user). How it is set up:

- **First start**: when no password exists yet, `sadbox serve` generates a
  random one, prints it once in the terminal, and writes it to
  `~/.sadbox/initial-password` (mode `0600`, readable only by you — reading it
  is the proof that you own this machine). Read it with
  `cat ~/.sadbox/initial-password` and sign in. With `SADBOX_DATA` set, the
  file is in that directory instead.
- **That file is only a copy for you to read.** sadbox checks a hash stored in
  `~/.sadbox/auth.json`, never the file, so editing `initial-password` does not
  change the password.
- **Set your own**: run `sadbox passwd` (at least 8 characters; asks twice on
  a terminal). It replaces the password, deletes `initial-password`, and signs
  every browser out. A running supervisor does not need a restart.
- **From the environment**: `SADBOX_PASSWORD=…` makes that the password for as
  long as it is set (for launchd or containers), overriding the stored one —
  `sadbox passwd` warns when it is set. No file is generated then.
- **Forgot it**: run `sadbox passwd` on the machine to set a new one. Or
  delete `~/.sadbox/auth.json` and restart `sadbox serve`: a new password is
  generated and written to `initial-password` again.
- **Off**: `SADBOX_AUTH=off` disables sign-in entirely — only sensible when
  something in front of sadbox authenticates every request.

### CLI

```
sadbox serve     start the supervisor (default)
sadbox setup     check deps, start the VM backend, build the base image
sadbox doctor    report environment health
sadbox service   install | uninstall | status — run at boot (Linux: a systemd user unit)
sadbox passwd    set the sign-in password
sadbox version
```

State lives in `~/.sadbox` (override with `SADBOX_DATA`).

## Building & releasing

```sh
bun run compile          # dist/sadbox for this platform
bun run compile:all      # darwin+linux × arm64+x64
```
Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which
cross-compiles all four binaries and attaches them (plus `SHA256SUMS`) to a
GitHub Release. The tag is the version: the workflow stamps it into
`src/config.ts` and `package.json` before building (via
`scripts/set-version.sh`) and commits the same bump to `main`, so there is no
version to edit by hand. The same commit updates the README's pin examples and
"latest release" line (`scripts/set-readme-release.sh`) and points
`packaging/homebrew/sadbox.rb` at the new release (version, download URLs and
sha256s, via `scripts/set-formula.sh`); if you publish a tap, copy that file
into it.

## How it works

```
Browser (dashboard + xterm.js tabs)
   │ REST + WebSocket
Supervisor (Bun/TS, this repo) ── SQLite state, AES-GCM vault + agent logins
   │ ProjectDriver interface
   ├─ macOS (Apple silicon): Apple container CLI ── one microVM per project
   ├─ macOS (Intel): vfkit + Virtualization.framework ── one microVM per project
   │         │ vsock (container exec / sadbox-agent)
   └─ Linux: Cloud Hypervisor on KVM ── one microVM per project
             │ vsock (sadbox-agent, the guest's init: guest/agent)
Guest: Debian + tmux + Bun + node (nvm) + Claude Code + omp + opencode, agent user,
       workdir = your repo copy
```

Everything below works the same on all three. Where this section says `container
exec` (how the supervisor runs a command in a VM), Linux and Intel Macs use the guest agent
over vsock instead.

### Source, folder and sync

- **Two source modes** at create: **(a) local folder** — `git ls-files
  --exclude-standard` → tar over exec stdin (only gitignored paths excluded, full
  history included; ~2 s for a 100 MB repo), with an optional git remote for
  push/sync; or **(b) git repository** — omit the folder and give a remote URL
  (+ token for private) and the VM **clones** it into the workdir. A cloned
  project starts with no local folder, so it pushes to the remote from inside
  the VM — or you **connect a local folder** to it later (detail page → Folder
  & git → *Connect a folder…*) and use **Sync back** like any other project.
  The folder can be a git repository or any other folder.
- **Env files never enter a VM**: `.env` and `.env.*` (`.env.local`,
  `.env.production`, …) at any depth, and anything under a `.env` directory,
  are left out of every copy into a VM — create, rebuild and push. Put what
  they hold in a vault.
- **Push to VM** (the other way from Sync back): copies the folder's changed
  files into a running VM as uncommitted changes, the same files a create
  would copy. Only files whose content differs travel; a file the folder no
  longer has stays in the VM; uncommitted work in the VM that exists nowhere
  else is not overwritten unless you say so.
- **Sync back** makes the folder's files match the VM's workdir — committed
  or not, minus gitignored files — and commits nothing: not in the VM (the
  agent's branch, index and loose changes stay as they are) and not in your
  folder (its own `.git` is never written to). You review and commit.
  - Only files that changed since the last sync are written; files the project
    deleted are removed; files it never had are left alone.
  - A file with uncommitted edits in the folder that the VM also changed — or
    a file of yours sitting where a new project file would go — is **not**
    overwritten: the sync stops, lists those files, and offers to overwrite
    them. A file your repository has committed is replaced by the VM's version
    (it shows up in `git diff`; your version stays in the history).
  - What the folder was last given is tracked in `~/.sadbox/sync/<id>.git`.

  A connected folder is only where work goes: **Rebuild** still re-clones the
  remote.

### Terminal and editor

- **Terminal**: xterm.js ⇄ WS ⇄ a PTY in the VM running `tmux new -A -s main`
  (on a Mac, `container exec -it` under `Bun.spawn({terminal})`; on Linux, the
  guest agent's PTY over vsock). Sessions live in the VM and
  survive supervisor restarts. **🔗 Links** in the toolbar lists every link
  currently on the terminal with **Open** and **Copy** buttons — use it for
  sign-in URLs (e.g. when authorizing an agent's provider): a long URL that a
  full-screen program wraps over several rows, often inside a drawn panel, is
  put back together, which selecting it by hand does not do reliably (a URL
  copied with its tail missing fails with errors like *"Invalid
  code_challenge_method: missing"*). tmux runs with `mouse on`, so to select
  other text hold **⌥ and drag** — this forces a native selection despite
  mouse-reporting mode, and finishing the drag copies it. A selection that is
  just one URL — broken over several rows, panel borders included, or only
  its first row — is copied as the complete link. **⌘C**/**⌘V** (or
  Ctrl+Shift+C/V) copy the selection and paste.
- **Editor**: **Editor ↗** opens the project's workdir in its own tab — a
  file tree, tabs, syntax highlighting (One Dark, ~55 languages), find
  (**⌘F**), go-to-file (**⌘P**, over everything git tracks or would add), save
  (**⌘S**), and new/rename/delete. Like the terminal it needs nothing running
  in the VM: each read or save is a short command run in the VM. The agent edits the
  same files, so a save is refused if the file changed in the VM since you
  opened it (reload, or overwrite deliberately), and an unedited tab picks up
  the agent's changes when you return to it. It is an editor, not an IDE — no
  language server, debugger or project-wide search — and it handles UTF-8 text
  files up to 2 MB.

### Git in the editor

- **Git in the editor**: everything below runs `git` inside the VM, on the
  VM's repository, as the VM's git identity (`sadbox project <name>`). Nothing
  here touches your local folder — that is still **Sync back**.
  - **Colours**: the tree is coloured by git state as in Zed — green for new
    files, amber for changed ones, blue for renamed, red for conflicts, grey
    for ignored, with folders taking the colour of what changed inside them —
    and follows the agent's work as it happens (checked every 5 s). Tab labels
    carry the same colours; a tab whose file changed in the VM under your
    unsaved edits is amber and italic.
  - **Changed lines**: the gutter marks every line that differs from the last
    commit, as you type — green bar = added, amber bar = modified, red wedge =
    lines removed there. Click a mark to see what the lines were, and
    **Restore** them.
  - **Staging**: the same panel has **Stage**, which puts just that change in
    the next commit; a staged change's mark is hollow, and clicking it offers
    **Unstage**. **Stage file** / **Unstage file** in the status bar does the
    whole open file. Staging saves the file first, so what is staged is what is
    on disk.
  - **Commit**: ✓ above the tree opens the commit box — every changed file
    with a checkbox (ticked = staged, a dash = partly staged), **Stage all** /
    **Unstage all**, a message, and **Commit** (⌘↵). Only what is staged is
    committed. **Amend last commit** rewrites the previous commit instead:
    what is staged joins it and its message is replaced (with nothing staged
    it only rewords).
  - **Push**: for a project with a git remote, **Push** in the commit box
    sends the VM's branch to `origin` from inside the VM — with the VM's
    credentials and through the proxy, so your network rules and approval
    popups apply. A push the remote rejects (it has moved on, or you amended a
    pushed commit) can be repeated with `--force-with-lease` after a
    confirmation.
  - **Branches**: the branch name at the left of the status bar opens a
    picker — the VM's branches, the ones only on the remote (picking one
    creates a local branch tracking it), or type a new name to create a branch
    from where the VM is. Uncommitted changes come along as with `git switch`;
    if they would be overwritten git refuses and nothing is lost. Tabs with
    unsaved edits must be saved or closed first.
  - **Stash**: **Stash** in the commit box puts every uncommitted change away
    (new files too, unsaved tabs are saved into it) and leaves the workdir at
    the last commit. Stashes — including ones made in the terminal — are
    listed there with **Pop** (bring back and remove; kept if it does not
    apply cleanly) and **Drop**.
  - **Discard**: ↶ on a file's row in the commit box puts that file back as
    last committed (a new file is deleted); **Discard all** does it for the
    whole workdir. Both ask first and cannot be undone; ignored files are
    never touched.

  Not there: stashing or pushing a selection, "apply" without removing a
  stash, merge/rebase, history, word-level diff. Use the terminal for those.

### Approvals while you work

- **Approve where you are working**: when something in the VM asks for a host
  no rule covers, the proxy holds the request and a popup appears on the
  terminal and editor tabs with the method, URL and a countdown. **Allow** it
  for just that request, 1 / 5 / 30 minutes, an hour, or always — or **Deny**
  it (once, or "always block"). The command is waiting meanwhile and continues
  as soon as you answer; unanswered requests are denied after 2 minutes. The
  same prompts still appear on the project's detail page, and answering in one
  place clears the other.

### Agents baked in

- **Agents baked in**: Claude Code, [omp](https://omp.sh), and
  [opencode](https://opencode.ai) are installed in the base image (plus Bun +
  git + ripgrep + jq). Run `claude`, `omp`, or `opencode` in the terminal. The
  new-project form lists what a VM ships with and their versions (probed from
  the base image via `/api/toolchain`); the detail view's **Installed tools**
  panel probes the *running VM* itself, so an older VM correctly shows which
  tools it's missing.

### Optional apps

- **Blender** can be installed in a VM, on top of the base image, from the new
  project form or later from the project's detail view (start the VM first).
  The detail view probes the running VM, so it shows whether Blender is there
  and which version. Removal is on the same panel.
  - The VM has no desktop, so Blender is for headless work — render, bake or
    run Python from the terminal, for example `blender -b scene.blend -f 1`.
  - The choice is kept on the project: **Rebuild** installs it again in the
    fresh VM. Packages come from Debian (4.3.2 on the current trixie image) and
    apt runs through the proxy with the provisioning window open, so no
    approval prompt appears mid-install.
  - The catalog lives in `src/core/apps.ts`; adding an app there puts it on the
    create form and every project page.

### Vaults

- **Vaults** (*Vaults* tab): one list of **variables** and **secrets**, typed
  `string` / `number` / `json`, encrypted at rest (AES-256-GCM) in SQLite. A
  variable's value shows in the list; a secret's shows `••••` and an eye icon
  that reveals it (each reveal is logged). Each item is given to the projects
  you tick — on the item, on the create form, or from a project's **Vault…**
  button — and has a **mode**:
  - **proxy**: the VM holds a **placeholder** shaped like the token
    (`ghp_sbx…`, same prefix and length), different in every VM and stable
    across restarts. The item lists the hosts it may be sent to (**bindings**:
    `api.github.com`, `*.example.com`, optionally a path like `/v1/*`, a method,
    a header; presets for GitHub, Anthropic, OpenAI). When a request carries the
    placeholder in a header — `Bearer`, `token`, `x-api-key`, or inside git's
    `Basic` auth — over https to a bound host, the proxy swaps in the real
    value; opt in per item to have it swapped in the **URL** and the **body**
    too (JSON, forms, text; up to 1 MiB; a `number` / `json` item becomes a
    typed JSON value). A real value coming back is swapped to the placeholder in
    response headers **and bodies** (streamed, so SSE is not delayed). Sending a
    placeholder to any other host **asks first** (🔑 approval: allowing for a
    window or always adds a binding); over plain http it is refused. Changing
    the value takes effect on the next request. A project with access to a
    proxy item is also **allowed to its bound hosts** (same host, path, method
    and expiry), so `git clone` works without adding network rules; these
    allows show read-only under Network → Rules (🔑 vault · NAME) and go with
    the binding or the access. A block rule still wins over them.
  - **fetch at runtime**: nothing is in the VM until a program asks —
    `sadbox-vault get NAME` (`--json` for the typed value; `sadbox-vault list`
    shows what the VM may use, without values), or
    `http://vault.sadbox.internal/v1/NAME`. The proxy answers that itself, for
    projects ticked for the item only. A **secret's** first fetch from a project
    waits for your answer (once / a window / always, like network approvals;
    "always" can be taken back on the item's card); a variable is served without
    asking. Every read is in the project's request log (name, never the value).
    A proxy item is never served this way.

  Secrets created before Vaults were migrated: proxy ones kept their bindings;
  ones that were written into the VM's env file became fetch items that keep
  being written there (`~/.sadbox/env`, readable in the VM) until you turn
  **+ env file** off on the item. A VM can never reach sadbox's own API — the
  proxy refuses this machine before any rule — so the reveal endpoint is out of
  its reach.

### Agent logins and history

- **Agent logins** (*Agents* tab): sadbox keeps the agents' logins and puts them
  into each VM at create, rebuild and start, so you log in once.
  - **Claude Code** (claude.ai login): run `/login` in any VM. sadbox makes the
    token exchange itself and keeps the tokens; the VM's
    `~/.claude/.credentials.json` holds **placeholders** with an expiry years
    away. The proxy swaps in the real access token only in the `Authorization`
    header and only to `api.anthropic.com`. sadbox refreshes the login ahead of
    expiry; a refresh a VM asks for is answered by sadbox (at most one real
    refresh a minute), so no VM ever holds a real token or can invalidate the
    others' by rotating it. A VM that already had a real login is taken over
    within about 30 s. If a refresh is refused, the Agents page says so — log in
    again in any VM. **Refresh now** and **Forget** are on the page.
  - **API keys** you enter in `omp` or `opencode` are captured from running VMs
    (about every 30 s) and copied into the others — these are readable in the
    VM, like a key you typed there. Their **OAuth** logins are not shared (a
    copy stops working once another VM refreshes it): log in per VM.
  - **Apply to running VMs** copies the current logins in now.
- **Agent history**: Claude's projects, file history and prompt history, omp's
  sessions and history, and opencode's database and snapshots live on this
  machine under `~/.sadbox/agents/history/<project name>/`, mounted into the
  VM. They survive **Rebuild** and **Destroy**, and a new project with the
  same name gets them back (the create form says so). A VM created before
  this has its history copied out on its first rebuild. On Linux the mount
  needs virtiofsd (see [Requirements](#requirements)); without it the history
  stays on the VM's disk and is copied out to the same place before a rebuild
  or destroy, but a new VM starts without it. Stored history is
  listed on the Agents page with **Delete** (not while a project of that name
  exists). Logins are never part of it.

### Git setup and sync-back

- **Git setup** (optional, at create or later from the project page): give a
  remote URL + access token and the project's `origin` is pointed there. The
  token becomes a **proxy vault item** the project is given — `GITHUB_TOKEN`
  bound to `github.com`, `api.github.com` and `uploads.github.com`;
  `GITLAB_TOKEN` to `gitlab.com`; `GIT_TOKEN` to any other remote's host —
  so the VM holds only its placeholder: git's credential helper signs in with
  it and the proxy swaps in the real token (and `gh` finds the placeholder in
  `GITHUB_TOKEN`). An item with the same name and value is reused; a new token
  updates the project's own item, or moves the project to a new one when the
  item is shared. Projects from before this had the token in the VM's
  `~/.git-credentials`: it moves to the vault, and the file is deleted, at the
  supervisor's next start (a stopped VM: when it starts).
- **Sync-back**: the guest records its workdir as a snapshot commit on a hidden
  ref (throwaway index — branch and working state untouched) → `git bundle`
  over exec stdout → fetched into a private repo whose work tree is the folder
  → `git checkout` there writes the changed files; a diffstat is returned to
  the UI.

### Project detail view

- **Detail view**: per project, live CPU %/memory/disk/network/process usage
  (from the VM backend — `container stats` on a Mac, Cloud Hypervisor's
  counters and the guest agent on Linux — plus in-guest probes), workdir size, tmux session/window
  counts and attached-terminal count, the branch the VM has checked out now
  and its dirty state (the projects list shows the live branch too; for a
  stopped VM it is the last one seen, kept in the database), folder/remote
  info, and the installed-toolchain probe — plus the live **Network** panel
  (below). The buttons along the top are **Terminal**, **Editor**, **Sync
  back** / **Push to VM** (once a folder is connected), **Vault…**, **Stop** / **Start**,
  **Rebuild** and **Destroy**; the project cards on the list carry the same
  ones. **Stop** (solid red) shuts the VM down and keeps its disk — files,
  installed packages and logins — while agents and terminals in it end;
  **Start** (blue) boots it again. **Change…** next to Memory gives that one VM more (or less) memory:
  a running VM is shut down and booted again with the new size, so agents and
  terminals in it end, while its files, installed packages and logins stay.
  A **Rebuild** action destroys the VM and recreates it from the
  project's original source (local folder re-copied at its current HEAD, or the
  git remote re-cloned), keeping the project's vault access, network rules,
  agent history and logins; unsynced work inside the old VM is lost. Rebuild uses the **current** base
  image, so a project created before a tool was baked in (e.g. opencode) picks
  it up on rebuild.

### Network proxy and isolation

- **Network proxy** (egress control): every VM routes its HTTP(S) through the
  supervisor. The proxy MITM-terminates TLS with a per-supervisor CA that each
  VM trusts (installed into the guest trust store + `NODE_EXTRA_CA_CERTS` at
  create), so it sees full URLs, headers, and bodies. It is **block-by-default**:
  a request with no matching rule is *held* while the detail view prompts for
  approval — **Allow once / 1m / 5m / 30m / 60m / forever**, or **Block**. Timed
  and forever answers persist as rules so the host isn't re-prompted. Rules
  (allow/block by host `*.example.com`/`*`, optional path glob + method) and
  header rewrites (set/remove on request or response) are **global** (all VMs)
  or **per-project**. A `set` value can be a literal or drawn from a **vault
  item** (one the project may use) — so a real token can be injected per-host (e.g.
  `Authorization` for `api.anthropic.com`) while never living inside the VM. The
  detail view's **Network** panel streams activity live over SSE, in tabs:
  **Activity** (grouped by host — requests, results, which rule lets it through,
  vault items used, one-click allow/block; or every request, filterable),
  **Rules** (this project's and all projects', each movable to the other side
  in one click; expired timed rules folded away) and **Header rules**. An
  **Internet on/off** switch in the panel's header cuts the VM off completely:
  every request and CONNECT is refused before rules, approvals or vault items are
  looked at, held approvals are denied, and it stays off across restarts.
  Every request is also **stored** (SQLite `net_requests`, written in 1-second
  batches) and kept for **7 days** — `SADBOX_NET_LOG_DAYS` keeps it longer,
  never shorter; older rows are pruned at startup and hourly. Activity's by-host
  view can span the last 24 hours or 7 days, "All requests" pages back through
  it, and the live view refills from it after a restart. Stored: method, host,
  path, status, decision, sizes, timing, and the *names* of vault items used — no
  headers or bodies, and never a secret value. Wiring: guest tools honor
  `HTTP(S)_PROXY` → `net` proxy on the host catches `CONNECT`, MITMs via a
  per-host `https` server, filters/rewrites, forwards upstream, logs.
  **Isolated, not advisory:** a VM has **no network interface at all** — only
  its own loopback. It cannot reach the internet, this machine, your LAN or
  another VM, whatever runs in it and as whichever user (root included); there
  is nothing to route around. Its single way out is a private socket to the
  proxy: a small relay on the VM's loopback (what `HTTP(S)_PROXY` points at)
  hands each connection to one the supervisor has dialed in, so the proxy
  always knows exactly which project is asking. The proxy then decides
  everything:
  - **the internet** — by your rules and approvals, as above;
  - **this machine** (loopback or any of its addresses) — never, whatever the
    rules say;
  - **your LAN** (private and link-local ranges) — only with a rule or approval
    that names that host; a catch-all `*` rule does not cover it.

  Destinations are judged by the address they resolve to, and the connection
  is made to that same address, so a hostname cannot be used to dodge this.
  Only HTTP(S) leaves a VM — no DNS, SSH or other protocols (use `https://`
  git remotes). A VM that cannot be wired to the proxy fails to create. The
  supervisor's own setup traffic (cloning the repo, extra apt packages and
  optional apps) goes
  through the proxy too, is logged, and skips the prompt only while setup
  runs. If the supervisor restarts, running VMs wait and carry on; if the
  relay in a VM dies, it is restarted within about half a minute. On a Mac,
  projects created before this still sit on Apple's NAT network with direct
  internet — the detail view marks them **not isolated** — until you
  **Rebuild** them, and `SADBOX_NETWORK=default` opts new projects out. Linux
  VMs are always isolated: the KVM driver has no VM networks to opt into.

### Port forwards and project links

- **Port forwards** (inbound): on the detail view, map a port on the supervisor
  host to a port inside the VM (e.g. host `8080` → VM `8000`) and open the app
  the agent is running at `<supervisor-host>:8080`. Since a VM has no network
  address, each connection is carried into the VM by the supervisor (over
  `container exec` on a Mac, the guest agent on Linux) and connected to the
  VM's own loopback — so it reaches whatever listens on that
  port, bound to `127.0.0.1` or `0.0.0.0` alike, for HTTP, WebSockets or any
  other TCP. Forwards persist across supervisor restarts and rebuilds and are
  removed with the project. They listen on all interfaces of the host, so a
  forward is reachable on the **same domain as the web UI** with just the port
  changed (`http://sadbox.internal.example.com:8080`), even when the UI itself
  is on localhost behind a reverse proxy. Set `SADBOX_FORWARD_HOST=localhost`
  to keep forwards on this machine only. A forward is one of two kinds:
  - **🔒 sign-in** (the default): HTTP, for a browser signed in to sadbox
    only. Open it from its link on the detail view: the UI hands your browser
    a one-time ticket, which the forward trades for a cookie good for that
    port alone, ending when you sign out of sadbox (or the password changes).
    A page loaded without one is sent to the UI to get it (signing in first if
    need be); other requests get 401, WebSockets included. sadbox's own
    cookies are removed from every request before it reaches the app, and the
    app cannot set them. The path `/__sadbox/auth` is sadbox's, not the app's.
  - **🔓 anyone**: raw TCP for anyone who can reach the host — for a database
    or another non-HTTP server, or an API that another forward's browser code
    calls (a `fetch` from one port to another sends no cookies). Click the
    lock on a forward to switch it.
  Either way the port is plain HTTP/TCP, not behind a reverse proxy's TLS.
- **Project links** (VM to VM): VMs cannot reach each other or the host, so
  one project calling another — a UI's server-side code calling an API in
  another VM — needs a link. On the calling project's detail view, under
  **Links to other projects**, pick the target project and **one port**. From
  inside the calling VM the target is then
  `http://<target-name>.sadbox.internal:<port>/…`; for example, a UI project
  linked to `api` on 3000 uses `API_URL=http://api.sadbox.internal:3000`.
  - The request goes through the calling VM's proxy, which checks for a link
    naming exactly that project and port, then carries the connection into the
    target VM (as a port forward does) onto its own loopback (as a port forward
    does). The host's network and the host's own ports are never involved, and
    the target needs no port forward.
  - The target app sees an ordinary local caller (`Host: localhost:<port>`,
    with the name used in `X-Forwarded-Host`), so it can listen on
    `127.0.0.1`.
  - Anything else is refused with 403: another port, another project, the
    reverse direction (a link is one-way), or a caller with no link. Every
    attempt, allowed or refused, appears in the caller's live network log.
  - Links are listed on both projects (**Can be reached from** on the target),
    can be removed from either end, and are deleted with either project.
  - It works for clients that use the proxy (`HTTP_PROXY`): curl, Bun and
    Node `fetch`, axios, Vite's dev-server proxy, Next.js server code.
    `https://` and other `CONNECT` clients get a raw tunnel to that one port.
    Clients that ignore the proxy — database drivers, raw TCP — cannot use a
    link.
  - If the UI's **browser** code calls the API, the request comes from your
    browser on the host, not from the VM: give the API a port forward open
    to anyone and point the UI at that (e.g. `http://localhost:3000`). No
    link needed.

### Sign-in and sessions

- **Sign-in**: the UI and API require a password (one user). A session is an
  HttpOnly, `SameSite=Strict` cookie, valid 30 days; only the login page and
  static scripts are served without one, and that includes the terminal
  WebSocket, the editor and the file API. Requests carrying another site's
  `Origin` are refused outright, so a web page you happen to visit cannot drive
  a sadbox on your localhost. `sadbox passwd` changes the password and signs
  every browser out; repeated wrong passwords are throttled. `SADBOX_PASSWORD`
  sets the password from the environment instead; `SADBOX_AUTH=off` disables
  sign-in (only sensible when something in front authenticates every request).

## API

| Method | Path | |
|---|---|---|
| GET/POST | `/api/projects` | list (with live VM state and each VM's current `branch`) / create (`{name, sourcePath?, apps?, optionalApps?, secretIds?: vault item ids, git?: {remote, token?}}` — omit `sourcePath` to clone `git.remote` in the VM) |
| GET | `/api/projects/:id/details` | full detail: resources, tmux, git, folder, optional apps (installed + versions) |
| GET | `/api/projects/:id/events?after=` | the project's event log, oldest first — the create form's progress |
| DELETE | `/api/projects/:id` | destroy VM |
| POST | `/api/projects/:id/start`, `…/stop` | boot a stopped VM / shut a running one down (its disk is kept) |
| POST | `/api/projects/:id/sync` | sync-back (`{force?: bool}` overwrites files changed in the folder) |
| GET | `/api/projects/:id/term/links` | links currently on the project's terminal (wrapped URLs re-joined) |
| POST | `/api/projects/:id/rebuild` | destroy + recreate the VM from the project's original source (keeps vault access, net rules, agent history) |
| GET | `/api/apps` | optional apps a VM can be given (`{apps}` — Blender) |
| POST/DELETE | `/api/projects/:id/apps`, `…/apps/:appId` | install an optional app into the running VM (`{id}`) / remove it |
| POST | `/api/projects/:id/push` | copy the folder's changed files into the VM, never env files (`{force?: bool}` overwrites uncommitted work in the VM) |
| GET | `/api/projects/:id/net/requests?before=&limit=` | stored request log, paged back from a timestamp (without `before`: the live view's recent requests + pending approvals) |
| GET | `/api/projects/:id/net/hosts?since=` | requests per host since a timestamp (default 24 h) |
| GET | `/api/projects/:id/sync/status` | count of uncommitted files in the VM |
| PUT | `/api/projects/:id/memory` | `{memoryMB}` — change this VM's memory; a running VM is restarted to take it (disk kept) |
| PUT/DELETE | `/api/projects/:id/sync-folder` | connect (`{path}`) / disconnect a local folder for a project cloned from a git URL |
| GET/PUT | `/api/projects/:id/vault` | the items a project may use, with the placeholder its VM holds for each / set them (`{itemIds}`) |
| GET/POST | `/api/vault` | list items (no secret values) / create (`{name, value, kind?: "secret"\|"variable", type?: "string"\|"number"\|"json", mode?: "proxy"\|"fetch", inEnv?, askOnFetch?, swapUrl?, swapBody?, bindings?, projectIds?}`) |
| GET/PATCH/DELETE | `/api/vault/:id` | one item / change it (an empty `value` keeps the old one) / delete it |
| GET | `/api/vault/:id/value` | reveal the value (the eye icon; logged) |
| PUT | `/api/vault/:id/projects` | `{projectIds}` — the projects that may use the item |
| POST/DELETE | `/api/vault/:id/bindings`, `/api/vault/:id/bindings/:bid` | add (`{host, path?, method?, header?, expiresAt?}`) / remove a host a proxy item may be sent to |
| DELETE | `/api/vault/:id/grants/:projectId` | take back a project's "fetch without asking" |
| GET | `/api/agents` | `{logins, history, liveNames}` — the logins sadbox keeps (never their values) and stored history per project name |
| POST | `/api/agents/apply`, `/api/agents/claude/refresh` | copy the logins into every running VM now / refresh the Claude login now |
| DELETE | `/api/agents/logins/:tool/:provider`, `/api/agents/history/:name` | forget a login / delete a name's history (refused while that project exists) |
| GET | `/api/history` | stored agent history per project name |
| GET | `/api/system/status` | whether the VM backend is ready (Apple's `container` service on a Mac; KVM, Cloud Hypervisor and its kernel on Linux), and why not |
| PUT | `/api/projects/:id/network` | `{cutoff: true\|false}` — cut the VM off from every network, or let it out again |
| PATCH | `/api/projects/:id/net/rules/:rid` | `{scope: "global"\|"project"}` — move a rule between this project and all projects (a `source: "vault"` allow, id `vault-…`, is read-only: 409) |
| GET/PUT | `/api/settings` | default VM resources (CPUs, memory, disk) for new projects |
| GET | `/api/toolchain` | agents/tools + versions baked into the base image (`?refresh=1` to re-probe) |
| GET | `/api/fs/dirs?path=` | folder picker (lists subdirs, flags git repos) |
| WS | `/projects/:id/term?cols&rows` | terminal (binary = bytes, text = JSON control) |
| GET | `/api/projects/:id/net/stream` | SSE live feed: snapshot + request/pending/resolved events |
| GET | `/api/projects/:id/net/requests` | recent requests + pending approvals (non-SSE) |
| POST | `/api/projects/:id/net/approvals/:aid` | resolve a held request (`{action, duration}`) |
| GET/POST | `/api/projects/:id/net/rules`, DELETE `…/:rid` | per-project allow/block rules |
| GET/POST | `/api/projects/:id/net/headers`, DELETE `…/:hid` | per-project header rewrites |
| GET/POST | `/api/projects/:id/files?path=` | list a workdir folder / create a folder (`{path}`) |
| GET | `/api/projects/:id/files/status` | git state per path (`new`/`modified`/`deleted`/`renamed`/`conflict`/`ignored`) behind the editor tree's colours, which files are staged (`all`/`some`), and the branch, its upstream and ahead/behind counts |
| GET | `/api/projects/:id/file/head?path=` | the file as last committed (what the editor's changed-line marks are measured against) and as staged |
| POST | `/api/projects/:id/files/stage` | `{paths: [...] \| "all", on}` — stage or unstage whole files/folders |
| POST | `/api/projects/:id/files/commit` | `{message, amend?}` — commit what is staged, in the VM (`amend`: rewrite the last commit) |
| GET | `/api/projects/:id/files/commit` | the last commit's short sha and message |
| GET | `/api/projects/:id/files/branch` | the VM's current branch and the ones it could switch to |
| POST | `/api/projects/:id/files/branch` | `{name, create?}` — switch the VM to a branch, or create one |
| POST | `/api/projects/:id/files/discard` | `{paths: [...] \| "all"}` — throw away uncommitted changes (new files are deleted) |
| GET | `/api/projects/:id/files/stash` | the VM's stashes |
| POST | `/api/projects/:id/files/stash` | `{action: "push" \| "pop" \| "drop", index?, message?}` |
| POST | `/api/projects/:id/files/push` | `{force?}` — push the VM's branch to its `origin` (`force`: `--force-with-lease`) |
| PUT | `/api/projects/:id/file/index` | `{path, content, expect?}` — set what is staged for the file (`content: null` = nothing staged); the workdir file is untouched |
| GET | `/api/projects/:id/files/index` | every non-ignored file (editor quick-open) |
| POST | `/api/projects/:id/files/rename` | rename or move (`{from, to}`) |
| GET/PUT/DELETE | `/api/projects/:id/file?path=` | read / save (`{path, content, baseHash, force?}` — 409 if it changed in the VM) / delete |
| GET/POST | `/api/projects/:id/links`, DELETE `…/:lid` | project links: `{outgoing, incoming}` / allow this VM to reach another project's port (`{to, port}`, `to` = id or name) / remove (from either end) |
| GET/POST | `/api/projects/:id/forwards`, PATCH/DELETE `…/:fid` | port forwards (`{hostPort, guestPort, access}`) — host port → VM port; `access` is `signin` (default) or `open`, and PATCH `{access}` switches it |
| GET | `/forwards/:fid/open?next=/path` | open a forward in the browser: a sign-in forward gets a one-time ticket at its own address |
| GET/POST | `/api/net/rules`, DELETE `/api/net/rules/:id` | global allow/block rules |
| GET/POST | `/api/net/headers`, DELETE `/api/net/headers/:id` | global header rewrites |
| GET | `/api/net/pending` | `{projectId: count}` pending approvals (nav badges) |
| GET | `/api/net/ca` | download the proxy CA (`.crt`) |
| POST | `/api/auth/login`, `/api/auth/logout` | sign in (`{password}` → session cookie) / sign out |
| GET | `/api/auth/status` | `{enabled, signedIn}` |

Every endpoint except `/api/auth/login` and `/api/auth/status` needs the session
cookie (`401` otherwise). Inside a VM, `http://vault.sadbox.internal/v1/` and
`/v1/NAME` are answered by the proxy (see Vaults), never by this API.

## Deploying

Where the supervisor can run, and whether it can make project VMs there:

| Where | Project microVMs? |
|---|---|
| **Mac, native** (`sadbox serve`, under launchd for boot) | ✅ Apple `container` on Apple silicon; `vfkit` (Virtualization.framework) on Intel |
| **Linux with KVM, native** (`sadbox serve`, or `sadbox service install`) | ✅ Cloud Hypervisor; VMs keep running across supervisor restarts |
| **Linux with KVM, docker compose** ([above](#linux-with-docker-compose)) | ✅ Cloud Hypervisor, its processes in the container; VMs stop with it |
| **Mac, in Docker/`container`** | ❌ web UI loads, but project create fails: no path to Virtualization.framework |

### Linux: run at boot (systemd)

```sh
sadbox service install            # writes ~/.config/systemd/user/sadbox.service, enables and starts it
sudo loginctl enable-linger $USER # so it starts at boot, before you log in
journalctl --user -u sadbox -f    # its log
sadbox service uninstall
```

The unit runs the same `sadbox` you installed it with, carrying your current
`SADBOX_*` settings and `PATH`, but not `SADBOX_PASSWORD` (a unit file is
readable by anyone; the service uses the stored password from `sadbox passwd`).
It stops only the supervisor (`KillMode=process`): the VMs keep running across a
restart or an upgrade, and the supervisor finds them again.

### macOS: run at boot (launchd)

`sadbox serve` runs in the foreground; a LaunchAgent is what keeps it in the
background — it starts at login, restarts it if it exits, and writes its output
to a log. These are the steps for an **Intel Mac** (the default `vz` backend);
the Apple silicon differences are at the end.

First make sure sadbox works from a terminal:

```sh
sadbox setup
sadbox doctor                 # everything ✓, including "VM disk built"
command -v sadbox             # the absolute path the job will run
```

On an Intel Mac, Docker must be running: the `vz` backend uses it to build the
guest kernel and project disks, and to rebuild the base image when its recipe
changes. If you use **colima** instead of Docker Desktop, have it start at login
too, or the first project create or rebuild after a reboot will fail while
Docker is down:

```sh
brew services start colima
```

Write `~/Library/LaunchAgents/dev.sadbox.supervisor.plist`, replacing
`/Users/YOU` with your home directory (launchd does not expand `~`), and the
binary path with the one `command -v sadbox` printed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.sadbox.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.local/bin/sadbox</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SADBOX_HOST</key>
    <string>127.0.0.1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/sadbox.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/sadbox.log</string>
</dict>
</plist>
```

Load it and watch the log:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.sadbox.supervisor.plist
launchctl kickstart -k gui/$(id -u)/dev.sadbox.supervisor   # start (or restart) now
tail -f ~/Library/Logs/sadbox.log
```

Open <http://localhost:7070>. On the first run the generated sign-in password
is in that log and in `~/.sadbox/initial-password`; change it with
`sadbox passwd`. From then on the job keeps sadbox running across logins and
restarts it if it exits.

To check it, restart it after updating the binary, stop it, or remove it:

```sh
launchctl print gui/$(id -u)/dev.sadbox.supervisor | head -20   # status
launchctl kickstart -k gui/$(id -u)/dev.sadbox.supervisor        # restart (after an update)
launchctl bootout gui/$(id -u)/dev.sadbox.supervisor             # stop (running VMs keep running)
rm ~/Library/LaunchAgents/dev.sadbox.supervisor.plist            # remove for good
```

The commands are long enough to deserve aliases. Put these in `~/.zshrc`, then
`source ~/.zshrc` (or open a new terminal):

```sh
# launchd supervisor: start / stop / restart / status / logs
alias sadbox-start='launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.sadbox.supervisor.plist 2>/dev/null || launchctl kickstart -k gui/$(id -u)/dev.sadbox.supervisor'
alias sadbox-stop='launchctl bootout gui/$(id -u)/dev.sadbox.supervisor 2>/dev/null || true'
alias sadbox-restart='launchctl kickstart -k gui/$(id -u)/dev.sadbox.supervisor 2>/dev/null || launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.sadbox.supervisor.plist'
alias sadbox-status='launchctl print gui/$(id -u)/dev.sadbox.supervisor | head -20'
alias sadbox-logs='tail -f ~/Library/Logs/sadbox.log'
```

`sadbox-start` also works when the job is already loaded (it restarts it), and
`sadbox-restart` starts it when it was stopped. Stopping or restarting the
supervisor leaves running VMs alone — only the UI, egress proxy, approvals and
port forwards go down.

- Keep the `PATH` line: a LaunchAgent does not inherit your shell's environment,
  and `docker`, `colima`, `vfkit` and `openssl` are looked up on it. On an Intel
  Mac Homebrew is in `/usr/local/bin`; `/opt/homebrew/bin` only matters if this
  Mac also runs an Apple silicon setup.
- Keep `SADBOX_HOST` at `127.0.0.1` when anything proxies to this Mac over
  IPv4 — Caddy (native or in Docker/colima), another reverse proxy. Bun binds
  `localhost` to **`::1` only** on macOS, so a proxy dialling
  `127.0.0.1:7070` gets `connection refused`; `SADBOX_HOST=127.0.0.1` makes
  sadbox listen on IPv4 (and `http://localhost:7070` still works).
- Do not put `SADBOX_PASSWORD` in the plist (it is world-readable). The job uses
  the stored password (`sadbox passwd`).
- For a **beta**, put the beta binary in `ProgramArguments` and add its state
  dir to `EnvironmentVariables` — otherwise the job falls back to `~/.sadbox`,
  the stable install's state:
  `<key>SADBOX_DATA</key><string>/Users/YOU/.sadbox-beta</string>`. Add
  `<key>SADBOX_DRIVER</key><string>vz</string>` too if you want it explicit, and
  `SADBOX_PORT` if the stable and beta supervisors run at the same time.
- On Apple silicon running macOS 15, add
  `<key>SADBOX_DRIVER</key><string>vz</string>` to `EnvironmentVariables`.
  Intel Macs do not need it (vz is their default).
- This runs at login. To run before anyone logs in, install the same file as a
  LaunchDaemon in `/Library/LaunchDaemons` (owned by root, with a `UserName`
  key); it is not needed for a normal desktop Mac.
- Once the Homebrew formula is published, `brew services` writes this job for
  you (see [Option 3](#option-3--from-source)).

### The container image

`Dockerfile` builds the supervisor image for Linux hosts with KVM: the compiled
binary on Debian, with Cloud Hypervisor, its kernel, virtiofsd and the docker
CLI. `scripts/push-ecr.sh` builds and pushes it to ECR (defaults to
`linux/arm64`):

```sh
AWS_REGION=ap-southeast-1 AWS_ACCOUNT_ID=1234... ./scripts/push-ecr.sh vX.Y.Z
```

On a Mac, run sadbox natively instead: a container there cannot reach
Virtualization.framework, and Apple silicon has no nested virtualization
(`docs/research/02`, `docs/research/09`).

### Serving to the LAN behind Caddy (Mac mini home server)

sadbox speaks plain HTTP on **`127.0.0.1:7070`** — set `SADBOX_HOST=127.0.0.1`
(the launchd section does), because Bun's `localhost` binds `::1` only on
macOS, which an IPv4 reverse proxy cannot reach. The right shape is: run sadbox
natively, leave it on loopback, and let the Caddy already on your Mac mini be
the only network-facing piece — it terminates TLS and reverse-proxies to
`127.0.0.1:7070`. sadbox's own sign-in still applies behind it; Caddy's
`basic_auth` is an optional second layer. A ready-to-adapt block is in
[`packaging/caddy/Caddyfile.example`](packaging/caddy/Caddyfile.example).

If Caddy runs in a **container** (Docker Desktop or colima) instead of natively,
`127.0.0.1` in `reverse_proxy` is Caddy's own loopback, not the Mac. On Docker
Desktop use `host.docker.internal:7070`. With **colima** that name resolves to
the host address (usually `192.168.5.2`), which maps to the Mac's **IPv4**
loopback — so sadbox must listen on `127.0.0.1`, not `::1`. If the name does not
resolve inside the container, pin it in the Caddy service:

```yaml
extra_hosts:
  - "host.docker.internal:192.168.5.2"
```

Keep the other upstreams (`dockge:5001`, …) as container names.

If you already terminate a **wildcard** cert (e.g. Cloudflare DNS challenge),
route sadbox by host inside that block so it reuses the real, browser-trusted
cert — then `wss://` (terminal) and SSE work with no client cert-trust steps:

```caddy
*.internal.example.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }

    @sadbox host sadbox.internal.example.com
    handle @sadbox {
        basic_auth {                 # optional — sadbox has its own sign-in
            admin $2a$14$…           # caddy hash-password
        }
        reverse_proxy 127.0.0.1:7070 {
            flush_interval -1        # stream the SSE network feed unbuffered
        }
    }
    # …your other per-host handle blocks…
}
```

(For a standalone hostname without a wildcard, give the block its own `tls`
directive — real certs, or `tls internal` plus `caddy trust` on each client.)

The `dns cloudflare` challenge needs a Caddy built with
[`caddy-dns/cloudflare`](https://github.com/caddy-dns/cloudflare): the official
`caddy` Docker image and Homebrew's `caddy` do not include it. Build one with
`xcaddy build --with github.com/caddy-dns/cloudflare`. The `zone_id` option
some examples show is not supported; the API token's scope picks the zone.

Notes:
- **WebSocket** (the browser terminal) is upgraded automatically by Caddy v2 —
  no extra config. The terminal picks `wss://` on an HTTPS page, so it works
  through TLS. `flush_interval -1` is what keeps the live **network feed** (SSE)
  streaming instead of buffering.
- **Keep sadbox on loopback.** Since Caddy is on (or can reach) this host you
  don't need `SADBOX_HOST=0.0.0.0`; `127.0.0.1` means the only way in is through
  Caddy (and so over TLS — the sign-in password should never cross the network
  in plain HTTP). Set `SADBOX_HOST` to another address only if Caddy runs on a
  different machine.
- **A 502 from Caddy** means it reached the Mac but sadbox is not listening on
  the address it dialled: `lsof -nP -iTCP:7070 -sTCP:LISTEN` should show
  `127.0.0.1:7070` (not `[::1]`), and
  `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7070/` should
  print `200`. If Caddy exits instead of starting, run
  `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`; an empty
  `CLOUDFLARE_API_TOKEN` fails at config load with
  `API token '' appears invalid`.
- **Only route 7070.** Port 7071 is the egress proxy for older VMs that still
  sit on a network (new ones use a private socket instead); it refuses any
  client that is not a project VM and must not be proxied.
- Use a **dedicated hostname** (or the root), not a subpath — sadbox serves its
  assets and API from `/`.
- Run it under **launchd** so it survives reboots (or `brew services` once the
  formula is in use; on Linux, `sadbox service install`); Caddy keeps proxying
  to the same localhost port.

## Known limitations (v0)

- A **local-folder** source must be a git repo with ≥ 1 commit (tar-out fallback
  for non-git folders is designed in `docs/research/06`, not built); or create
  from a **git URL** and the VM clones it instead.
- The web UI speaks plain HTTP. It is password-protected, but to reach it from
  other machines put a TLS reverse proxy in front (see the Caddy setup under
  [Deploying](#deploying)) rather than exposing `SADBOX_HOST=0.0.0.0` directly,
  or the password and session cookie cross the network unencrypted.
- **Forwarded ports are plain HTTP**: a sign-in forward's cookie crosses the
  network unencrypted when it is opened from another machine, and a forward
  opened to anyone is raw TCP that anyone who can reach this machine can use.
- Platforms: Apple silicon Macs on macOS 26+, Intel Macs (built, see
  [Supported platforms](#supported-platforms)), and Linux with KVM. On Linux:
  - Creating a project copies the image's disk (about 2 GB), which takes a few seconds on ext4.
    btrfs or xfs clone it instantly.
  - The disk size in Settings caps the whole VM, not only its workdir.
  - Agent history is mounted from the host only with virtiofsd 1.11+ (or as
    uid 1000); otherwise a new VM of the same name starts without it.
  - Under docker compose, the VMs stop when the container does.
  - The new-project form reads tool versions from the Docker image, so keep it.
  - arm64 hosts are untested.
- A change to an item still written to the env file reaches new shells/panes
  only — proxy items take effect on the next request, fetch items on the next
  read.
- Proxy items protect the **value**, not its use: the agent can still call the
  bound hosts with it, so prefer narrow bindings and least-privilege tokens.
  Response redaction covers string values of 8+ characters in textual bodies;
  a value echoed back encoded some other way (base64, split up) is not caught.
  Token-creation APIs other than Claude's login hand the VM real tokens.
  Bindings belong to the item, so a binding added from one project's approval
  applies wherever that item is used.
- A fetched value is in the VM once read — that is the point — so give fetch
  mode only to what a program must have locally, and leave secrets asking.
- Egress is HTTP(S)-only, through the proxy; tools find it via
  `HTTP(S)_PROXY` (curl, git, bun, pip do; Node's built-in `fetch` does with
  `NODE_USE_ENV_PROXY=1`, which is set). A program that ignores those variables
  has no network at all. WebSockets *out of* a VM are not supported by the
  proxy. On a Mac, projects created before isolation stay on the NAT network
  until rebuilt. Proxy env + CA reach new shells only (same env-file semantics as
  env-file items).
- VMs must be started by sadbox. On a Mac, one started by hand with
  `container start` comes up without its proxy relay; sadbox restarts the relay
  within about half a minute while the supervisor is running.
- Claude Code auth: `/login` once in any VM (see Agent logins). A
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`
  proxy item with the Anthropic preset still works instead. omp and opencode
  OAuth logins are per VM; their API keys are copied in readable.
- Agent history is matched by exact project name: renaming means starting
  fresh (the old name's history stays until deleted). Two agents writing the
  same history at once is not possible, since a name is one live project.
