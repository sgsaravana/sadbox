# sadbox

Supervisor for **microVM AI-agent sandboxes** on macOS. Spin up isolated Linux
microVMs ("workers"), each with a copy of a source folder and Claude Code +
toolchain baked in; watch and steer the agent through a browser terminal
attached to tmux inside the VM; manage per-worker secrets; pull the agent's
work back into your repo as git commits — on demand, with a diff preview,
without the agent ever touching your original folder.

Workers are real VMs (own kernel, own memory, Apple Virtualization.framework
via the open-source [`container`](https://github.com/apple/container) CLI) —
not shared-kernel containers.

## Status

v0 scaffold — the full vertical slice works: create → browser tmux terminal →
secrets → git sync-back → destroy. See `docs/research/` for the design
research and `spikes/` for the de-risk experiments behind each piece.

## Requirements

- macOS 26+, Apple silicon
- Apple `container` CLI: `brew install container`
- (dev only) [Bun](https://bun.com) ≥ 1.3.5

## Install

sadbox ships as a **single self-contained binary** (Bun-compiled; the web UI
and worker-image recipe are embedded — no repo checkout or `node_modules`
needed at runtime).

**Homebrew (recommended on macOS):**
```sh
brew install OWNER/tap/sadbox   # pulls in the `container` dependency
sadbox setup                    # starts container system + builds worker image
sadbox serve                    # http://localhost:7070
# or run at login:  brew services start sadbox
```

**Install script:**
```sh
curl -fsSL https://raw.githubusercontent.com/OWNER/sadbox/main/install.sh | sh
sadbox setup && sadbox serve
```

**From source (dev):**
```sh
bun install
bun run src/index.ts setup      # or: bun run setup
bun run start
```

### CLI

```
sadbox serve     start the supervisor (default)
sadbox setup     check deps, start container system, build the worker image
sadbox doctor    report environment health
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
GitHub Release. Update `packaging/homebrew/sadbox.rb` (version + sha256s) in
your tap to point at the new release.

Create a worker from the dashboard (name + path to a local git repo), click
**Terminal ↗** for its tmux in a new tab, run `claude` in it, and use
**Sync back** when you like what you see — the worker's commits land in
`refs/remotes/sadbox/<name>` in your repo, ready to `git merge` (your worktree
is never touched by sync).

## How it works

```
Browser (dashboard + xterm.js tabs)
   │ REST + WebSocket
Supervisor (Bun/TS, this repo) ── SQLite state, AES-GCM secrets
   │ WorkerDriver interface
Apple container CLI ── one microVM per worker
   │ vsock (exec)
Guest: Debian + tmux + Bun + Claude Code, agent user, workdir = your repo copy
```

- **Copy-in**: `git ls-files --exclude-standard` → tar over exec stdin — only
  gitignored paths are excluded, full history included. ~2 s for a 100 MB repo.
- **Terminal**: xterm.js ⇄ WS ⇄ `Bun.spawn({terminal})` PTY ⇄
  `container exec -it <w> tmux new -A -s main`. Sessions live in the VM and
  survive supervisor restarts.
- **Secrets**: encrypted (AES-256-GCM, keyfile in `data/`) in SQLite; injected
  as a 0600 env file in the guest before tmux starts; values are write-only in
  the API/UI.
- **Sync-back**: guest autocommit → incremental `git bundle` over exec stdout →
  host `git fetch` into `refs/remotes/sadbox/<name>` → commits + diffstat
  returned to the UI.

## API

| Method | Path | |
|---|---|---|
| GET/POST | `/api/workers` | list (with live VM state) / create |
| DELETE | `/api/workers/:id` | destroy VM |
| POST | `/api/workers/:id/sync` | sync-back (`{autocommit?: bool}`) |
| GET | `/api/workers/:id/sync/status` | dirty/ahead counts |
| GET/PUT | `/api/workers/:id/secrets` | assigned secrets / assign + inject |
| GET/POST | `/api/secrets`, DELETE `/api/secrets/:id` | secret store |
| WS | `/workers/:id/term?cols&rows` | terminal (binary = bytes, text = JSON control) |

## Deploying

`Dockerfile` builds the supervisor image; `scripts/push-ecr.sh` builds and
pushes it to ECR (defaults to `linux/arm64` for Apple-silicon / Graviton):

```sh
AWS_REGION=ap-southeast-1 AWS_ACCOUNT_ID=1234... ./scripts/push-ecr.sh v0.1.0
```

**But read this before deploying to the Mac mini.** A container cannot create
worker microVMs on a macOS host — containers on macOS run inside a Linux VM
that has no access to the host's Virtualization.framework, and Apple silicon
has no nested virtualization (`docs/research/02`, `docs/research/09`). So:

| Where the supervisor runs | Worker microVMs? |
|---|---|
| **Mac mini, native** (`bun run start` under launchd) | ✅ via Apple `container` |
| **Mac mini, in Docker/`container`** | ❌ web UI loads, but worker create fails — no path to Virtualization.framework |
| **Linux server, in Docker** with `/dev/kvm` | ✅ *once the `kvm` driver ships* (not built yet) |

For your Mac mini today, run sadbox **natively**, not from the ECR image:

```sh
git clone <repo> && cd sadbox && bun install
bun run build:image          # bake the worker image
bun run start                # or a launchd plist for boot persistence
```

The ECR image is still worth pushing — it's the artifact for the Linux
deployment path once the `kvm` driver lands, and it runs the UI/API anywhere.

## Known limitations (v0)

- Source folder must be a git repo with ≥ 1 commit (tar-out fallback for
  non-git folders is designed in `docs/research/06`, not built).
- Web UI has no auth — localhost use only.
- macOS/`container` driver only; the Linux/Cloud Hypervisor driver and
  docker-compose packaging are designed (`docs/research/02`) but not built.
- Secret rotation reaches new shells/panes only (env-file semantics).
- Claude Code auth: create a `CLAUDE_CODE_OAUTH_TOKEN` secret (from
  `claude setup-token` on the host) and assign it to workers — or an
  `ANTHROPIC_API_KEY`. See `docs/research/05`.
