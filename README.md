# sadbox

Supervisor for **microVM AI-agent sandboxes** on macOS. Spin up isolated Linux
microVMs — each one a **project** — with a copy of a source folder and Claude
Code + toolchain baked in; watch and steer the agent through a browser terminal
attached to tmux inside the VM; manage per-project secrets; pull the agent's
work back into your repo as git commits — on demand, with a diff preview,
without the agent ever touching your original folder.

Projects are real VMs (own kernel, own memory, Apple Virtualization.framework
via the open-source [`container`](https://github.com/apple/container) CLI) —
not shared-kernel containers.

## Status

v0 scaffold — the full vertical slice works: create → browser tmux terminal →
secrets → git sync-back → destroy. The web UI opens on a **Home** overview
(intro, feature tour, and quick-start) and has a side nav with a nested
project list, Secrets, and Settings (default VM CPU/memory/disk for new projects),
plus a per-project detail view with live CPU/memory/disk/network usage and
tmux state. Every VM's egress is routed through the supervisor as a **filtering
MITM proxy** — block-by-default with interactive, time-boxed approvals, allow/
block + header-rewrite rules (global or per-project), and a live request log on
the detail view. See `docs/research/` for the design research and `spikes/` for
the de-risk experiments behind each piece.

## Releases

<!-- LATEST_RELEASE:START -->
**Latest release: [v0.1.1](https://github.com/sgsaravana/sadbox/releases/tag/v0.1.1)** · published 2026-09-24 · [release notes →](https://github.com/sgsaravana/sadbox/releases/tag/v0.1.1)
<!-- LATEST_RELEASE:END -->

Every release ships prebuilt binaries for macOS/Linux (arm64/x64) plus
`SHA256SUMS`, built by [`release.yml`](.github/workflows/release.yml). Cut one by
pushing a tag — `git tag v0.1.0 && git push --tags`. Publishing a release runs
[`update-readme-release.yml`](.github/workflows/update-readme-release.yml), which
rewrites the line above with the newest tag, its date, and a link to the notes.
Browse them all on the [releases page](https://github.com/sgsaravana/sadbox/releases).

## Requirements

- macOS 26+, Apple silicon
- Apple `container` CLI: `brew install container`
- `openssl` on PATH (ships with macOS) — the egress proxy mints its CA + certs
- (dev only) [Bun](https://bun.com) ≥ 1.3.5

## Install

The repo is currently **private**, so the public install paths (Homebrew, the
`curl | sh` script) don't work yet — they need a public repo + release. Install
from source or from a locally-built binary.

**From source (recommended while private):**
```sh
git clone git@github.com:sgsaravana/sadbox.git && cd sadbox
bun install
bun run setup      # check deps, start container system, build the base image
bun run start      # http://localhost:7070
```

**Self-contained binary** — sadbox compiles to a single file (Bun-compiled; the
web UI and base-image recipe are embedded, so no repo checkout or `node_modules`
are needed at runtime):
```sh
bun run compile                 # → dist/sadbox for this platform
cp dist/sadbox ~/.local/bin/    # (ensure ~/.local/bin is on PATH)
sadbox setup && sadbox serve
```

<details>
<summary><b>Public distribution (once the repo is public)</b></summary>

These need `sgsaravana/sadbox` to be public and a published Release with the
`sadbox-*` binaries attached (built by `release.yml` on tag push), plus a public
`sgsaravana/homebrew-tap` repo holding `Formula/sadbox.rb` (see
`packaging/homebrew/sadbox.rb`, with the two `sha256`s filled in from the
release's `SHA256SUMS`).

```sh
# Homebrew
brew install sgsaravana/tap/sadbox
sadbox setup && sadbox serve            # or: brew services start sadbox

# Install script
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh
sadbox setup && sadbox serve
```
</details>

### CLI

```
sadbox serve     start the supervisor (default)
sadbox setup     check deps, start container system, build the base image
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

Create a project from the dashboard (name + path to a local git repo), click
**Terminal ↗** for its tmux in a new tab, run `claude` in it, and use
**Sync back** when you like what you see — the project's commits land in
`refs/remotes/sadbox/<name>` in your repo, ready to `git merge` (your worktree
is never touched by sync).

## How it works

```
Browser (dashboard + xterm.js tabs)
   │ REST + WebSocket
Supervisor (Bun/TS, this repo) ── SQLite state, AES-GCM secrets
   │ ProjectDriver interface
Apple container CLI ── one microVM per project
   │ vsock (exec)
Guest: Debian + tmux + Bun + Claude Code + omp + opencode, agent user,
       workdir = your repo copy
```

- **Two source modes** at create: **(a) local folder** — `git ls-files
  --exclude-standard` → tar over exec stdin (only gitignored paths excluded, full
  history included; ~2 s for a 100 MB repo), with an optional git remote for
  push/sync; or **(b) git repository** — omit the folder and give a remote URL
  (+ token for private) and the VM **clones** it into the workdir. Cloned
  projects have no local folder, so they push to the remote from inside the VM
  rather than syncing back.
- **Terminal**: xterm.js ⇄ WS ⇄ `Bun.spawn({terminal})` PTY ⇄
  `container exec -it <project> tmux new -A -s main`. Sessions live in the VM and
  survive supervisor restarts. tmux runs with `mouse on`, so to grab text (e.g.
  an OAuth URL when authorizing an agent's provider) hold **⌥ and drag** — this
  forces a native selection despite mouse-reporting mode, and finishing the drag
  copies it. **⌘C**/**⌘V** (or Ctrl+Shift+C/V) copy the selection and paste.
- **Agents baked in**: Claude Code, [omp](https://omp.sh), and
  [opencode](https://opencode.ai) are installed in the base image (plus Bun +
  git + ripgrep + jq). Run `claude`, `omp`, or `opencode` in the terminal. The
  new-project form lists what a VM ships with and their versions (probed from
  the base image via `/api/toolchain`); the detail view's **Installed tools**
  panel probes the *running VM* itself, so an older VM correctly shows which
  tools it's missing.
- **Secrets** (two scopes): **global** secrets are shared and assignable to any
  number of projects; **project-specific** secrets live in one project and are
  deleted with it (overriding a global of the same name). All encrypted at rest
  (AES-256-GCM) in SQLite, injected as a 0600 env file in the guest before tmux
  starts, write-only in the API/UI.
- **Git setup** (optional, at create): give a remote URL + access token and the
  project's `origin` is pointed there with the token stored via git's credential
  helper (`~/.git-credentials`, 0600) so the agent can push/pull. The token is
  encrypted at rest on the host.
- **Sync-back**: guest autocommit → incremental `git bundle` over exec stdout →
  host `git fetch` into `refs/remotes/sadbox/<name>` → commits + diffstat
  returned to the UI.
- **Detail view**: per project, live CPU %/memory/disk/network/process usage
  (via `container stats` + in-guest probes), workdir size, tmux session/window
  counts and attached-terminal count, git branch/dirty state, folder/remote
  info, and the installed-toolchain probe — plus the live **Network** panel
  (below). A **Rebuild** action destroys the VM and recreates it from the
  project's original source (local folder re-copied at its current HEAD, or the
  git remote re-cloned), keeping the project's secrets and network rules;
  unsynced work inside the old VM is lost. Rebuild uses the **current** base
  image, so a project created before a tool was baked in (e.g. opencode) picks
  it up on rebuild.
- **Network proxy** (egress control): every VM routes its HTTP(S) through the
  supervisor. The proxy MITM-terminates TLS with a per-supervisor CA that each
  VM trusts (installed into the guest trust store + `NODE_EXTRA_CA_CERTS` at
  create), so it sees full URLs, headers, and bodies. It is **block-by-default**:
  a request with no matching rule is *held* while the detail view prompts for
  approval — **Allow once / 1m / 5m / 30m / 60m / forever**, or **Block**. Timed
  and forever answers persist as rules so the host isn't re-prompted. Rules
  (allow/block by host `*.example.com`/`*`, optional path glob + method) and
  header rewrites (set/remove on request or response) are **global** (all VMs)
  or **per-project**. A `set` value can be a literal or drawn from a **secret**
  (global or the project's own) — so a real token can be injected per-host (e.g.
  `Authorization` for `api.anthropic.com`) while never living inside the VM. The
  detail view streams a **live request log** (method,
  host, path, status, decision, size) over SSE. Wiring: guest tools honor
  `HTTP(S)_PROXY` → `net` proxy on the host catches `CONNECT`, MITMs via a
  per-host `https` server, filters/rewrites, forwards upstream, logs.
  *(Cooperative: it covers proxy-aware tooling — curl, git, bun/node, pip —
  which is everything the agent uses; a program making raw non-proxy sockets is
  not yet forced through it. Transparent nftables enforcement is a follow-up.)*

## API

| Method | Path | |
|---|---|---|
| GET/POST | `/api/projects` | list (with live VM state) / create (`{name, sourcePath?, apps?, secretIds?, git?: {remote, token?}}` — omit `sourcePath` to clone `git.remote` in the VM) |
| GET | `/api/projects/:id/details` | full detail: resources, tmux, git, folder |
| DELETE | `/api/projects/:id` | destroy VM |
| POST | `/api/projects/:id/sync` | sync-back (`{autocommit?: bool}`) |
| POST | `/api/projects/:id/rebuild` | destroy + recreate the VM from the project's original source (keeps secrets + net rules) |
| GET | `/api/projects/:id/sync/status` | dirty/ahead counts |
| GET/PUT/POST | `/api/projects/:id/secrets` | view / assign globals / add project-specific |
| GET/POST | `/api/secrets`, DELETE `/api/secrets/:id` | global secret store |
| GET/PUT | `/api/settings` | default VM resources (CPUs, memory, disk) for new projects |
| GET | `/api/toolchain` | agents/tools + versions baked into the base image (`?refresh=1` to re-probe) |
| GET | `/api/fs/dirs?path=` | folder picker (lists subdirs, flags git repos) |
| WS | `/projects/:id/term?cols&rows` | terminal (binary = bytes, text = JSON control) |
| GET | `/api/projects/:id/net/stream` | SSE live feed: snapshot + request/pending/resolved events |
| GET | `/api/projects/:id/net/requests` | recent requests + pending approvals (non-SSE) |
| POST | `/api/projects/:id/net/approvals/:aid` | resolve a held request (`{action, duration}`) |
| GET/POST | `/api/projects/:id/net/rules`, DELETE `…/:rid` | per-project allow/block rules |
| GET/POST | `/api/projects/:id/net/headers`, DELETE `…/:hid` | per-project header rewrites |
| GET/POST | `/api/net/rules`, DELETE `/api/net/rules/:id` | global allow/block rules |
| GET/POST | `/api/net/headers`, DELETE `/api/net/headers/:id` | global header rewrites |
| GET | `/api/net/pending` | `{projectId: count}` pending approvals (nav badges) |
| GET | `/api/net/ca` | download the proxy CA (`.crt`) |

## Deploying

`Dockerfile` builds the supervisor image; `scripts/push-ecr.sh` builds and
pushes it to ECR (defaults to `linux/arm64` for Apple-silicon / Graviton):

```sh
AWS_REGION=ap-southeast-1 AWS_ACCOUNT_ID=1234... ./scripts/push-ecr.sh v0.1.0
```

**But read this before deploying to the Mac mini.** A container cannot create
project microVMs on a macOS host — containers on macOS run inside a Linux VM
that has no access to the host's Virtualization.framework, and Apple silicon
has no nested virtualization (`docs/research/02`, `docs/research/09`). So:

| Where the supervisor runs | Project microVMs? |
|---|---|
| **Mac mini, native** (`bun run start` under launchd) | ✅ via Apple `container` |
| **Mac mini, in Docker/`container`** | ❌ web UI loads, but project create fails — no path to Virtualization.framework |
| **Linux server, in Docker** with `/dev/kvm` | ✅ *once the `kvm` driver ships* (not built yet) |

For your Mac mini today, run sadbox **natively**, not from the ECR image:

```sh
git clone <repo> && cd sadbox && bun install
bun run build:image          # bake the base image
bun run start                # or a launchd plist for boot persistence
```

The ECR image is still worth pushing — it's the artifact for the Linux
deployment path once the `kvm` driver lands, and it runs the UI/API anywhere.

### Serving to the LAN behind Caddy (Mac mini home server)

sadbox binds **`localhost:7070`** by default and has **no auth**, so the right
shape is: run it natively, leave it on localhost, and let the Caddy already on
your Mac mini be the only network-facing piece — it terminates TLS, adds auth,
and reverse-proxies to `127.0.0.1:7070`. A ready-to-adapt block is in
[`packaging/caddy/Caddyfile.example`](packaging/caddy/Caddyfile.example).

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
        basic_auth {                 # sadbox has no auth — add it here
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

Notes:
- **WebSocket** (the browser terminal) is upgraded automatically by Caddy v2 —
  no extra config. The terminal picks `wss://` on an HTTPS page, so it works
  through TLS. `flush_interval -1` is what keeps the live **network feed** (SSE)
  streaming instead of buffering.
- **Keep sadbox on localhost.** Since Caddy is on the same host you don't need
  `SADBOX_HOST=0.0.0.0`; leaving it on localhost means the only way in is
  through Caddy (and its auth). Set `SADBOX_HOST` only if Caddy runs on a
  different machine.
- **Only route 7070.** Port 7071 is the VMs' internal egress proxy on the vmnet
  gateway (`192.168.64.1`) — it must stay reachable from the guests and must not
  be proxied or exposed.
- Use a **dedicated hostname** (or the root), not a subpath — sadbox serves its
  assets and API from `/`.
- Run it under **launchd** so it survives reboots (or `brew services` once the
  formula is in use); Caddy keeps proxying to the same localhost port.

## Known limitations (v0)

- A **local-folder** source must be a git repo with ≥ 1 commit (tar-out fallback
  for non-git folders is designed in `docs/research/06`, not built); or create
  from a **git URL** and the VM clones it instead.
- Web UI has no auth — bind it to localhost (default) and, to reach it from
  other machines, front it with an authenticating reverse proxy (see the Caddy
  setup under [Deploying](#deploying)). Never expose `SADBOX_HOST=0.0.0.0`
  without one.
- macOS/`container` driver only; the Linux/Cloud Hypervisor driver and
  docker-compose packaging are designed (`docs/research/02`) but not built.
- Secret rotation reaches new shells/panes only (env-file semantics).
- The egress proxy is **cooperative** (VM tools honor `HTTP(S)_PROXY`): it
  covers curl/git/bun/node/pip, but a program opening raw non-proxy sockets
  bypasses it. Transparent nftables enforcement is designed, not built. Proxy
  env + CA reach new shells only (same env-file semantics as secrets).
- Claude Code auth: create a `CLAUDE_CODE_OAUTH_TOKEN` secret (from
  `claude setup-token` on the host) and assign it to projects — or an
  `ANTHROPIC_API_KEY`. See `docs/research/05`.
