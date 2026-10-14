# sadbox

Supervisor for **microVM AI-agent sandboxes** on macOS (Apple silicon, macOS 26+
— see [Supported platforms](#supported-platforms)). Spin up isolated Linux
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
secrets → git sync-back → destroy, with a browser editor that can stage,
commit, push, switch branches, stash and discard inside the VM. The web UI opens on a **Home** overview
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
_No release published yet — see the [releases page](https://github.com/sgsaravana/sadbox/releases)._
<!-- LATEST_RELEASE:END -->

Every release ships prebuilt binaries for macOS/Linux (arm64/x64) plus
`SHA256SUMS`, built by [`release.yml`](.github/workflows/release.yml). Cut one by
pushing a tag — `git tag v0.1.0 && git push --tags`. Publishing a release runs
[`update-readme-release.yml`](.github/workflows/update-readme-release.yml), which
rewrites the line above with the newest tag, its date, and a link to the notes.
Browse them all on the [releases page](https://github.com/sgsaravana/sadbox/releases).

## Supported platforms

**sadbox fully works on one platform today: an Apple silicon Mac running
macOS 26 (Tahoe) or later.** Everywhere else the binary starts and serves the
web UI and API, but it cannot create project VMs — which is the whole point —
so treat those platforms as unsupported.

| Platform | Project VMs | Notes |
|---|---|---|
| **Mac, Apple silicon (M1 or later), macOS 26+** | ✅ **Supported** | The only fully working setup. |
| Mac, Apple silicon, macOS 15 or earlier | ❌ | Apple's `container` CLI requires macOS 26. Upgrade macOS. |
| Mac, Intel | ❌ | Apple's `container` CLI is Apple silicon only; `brew install container` refuses to install. No Intel backend is planned. |
| Linux (arm64 / x64) | ❌ Not yet | Needs the KVM / Cloud Hypervisor driver, which is designed (`docs/research/02`) but not built. |
| Docker / any container, on any host | ❌ | A containerized supervisor cannot reach the host's hypervisor; see [Deploying](#deploying). |
| Windows | ❌ | No build, none planned. |

Why so narrow: every project is a real microVM, and sadbox creates them through
Apple's [`container`](https://github.com/apple/container) tool, which only
exists for Apple silicon on macOS 26+. Release binaries are also published for
Intel Macs and Linux (`sadbox-darwin-x64`, `sadbox-linux-*`) so the UI can be
run or demoed there, and for the Linux driver to come — not because projects
work on them.

## Requirements

On a supported Mac:

- Apple's [`container`](https://github.com/apple/container) CLI:
  `brew install container`
- `git`, and `openssl` on PATH (both ship with macOS / the Xcode command line
  tools) — the egress proxy uses openssl to mint its CA and certificates
- [Bun](https://bun.com) ≥ 1.3.5 — only if you run from source

## Install

### Option 1 — install script (prebuilt binary)

```sh
brew install container
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh
```

This downloads the latest release binary for your platform into
`~/.local/bin/sadbox`. If the script says that directory is not on your `PATH`,
add it as shown. To pin a version or change the location:

```sh
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh \
  | SADBOX_VERSION=v0.2.0 SADBOX_BIN_DIR=/usr/local/bin sh
```

### Option 2 — download the binary yourself

Grab `sadbox-darwin-arm64` from the
[releases page](https://github.com/sgsaravana/sadbox/releases/latest), check it
against `SHA256SUMS`, and put it on your `PATH`:

```sh
shasum -a 256 sadbox-darwin-arm64        # compare with the line in SHA256SUMS
chmod +x sadbox-darwin-arm64
xattr -d com.apple.quarantine sadbox-darwin-arm64 2>/dev/null   # browser downloads only
mv sadbox-darwin-arm64 ~/.local/bin/sadbox
```

The binary is not signed or notarized, so a copy downloaded with a browser is
quarantined by macOS; the `xattr` line clears that. (`curl` downloads, including
the install script, are not quarantined.)

### Option 3 — from source

For development, or to run changes that are not in a release yet:

```sh
git clone https://github.com/sgsaravana/sadbox.git && cd sadbox
bun install
bun run setup      # same as `sadbox setup`
bun run start      # same as `sadbox serve`  (bun run dev to reload on change)
```

`bun run compile` builds the same single-file binary into `dist/sadbox`; the web
UI and base-image recipe are embedded, so it runs without the checkout.

A Homebrew formula is kept in `packaging/homebrew/sadbox.rb`, but it is not
published to a tap yet, so `brew install` of sadbox itself is not available.

## First run

```sh
sadbox setup     # checks dependencies, starts the container system, builds the base image (a few minutes, once)
sadbox serve     # http://localhost:7070
```

The first `sadbox serve` generates a sign-in password, prints it once, and
saves it in `~/.sadbox/initial-password`. Use it to sign in, or set your own
with `sadbox passwd`. Then, in the browser:

1. **Add a Claude credential** under **Secrets**: run `claude setup-token` on
   your Mac and save the result as `CLAUDE_CODE_OAUTH_TOKEN` (or save an
   `ANTHROPIC_API_KEY`). Skip this if you will use another agent or log in
   inside the VM.
2. **Create a project** under **Projects**: give it a name and either a local
   folder that is a git repository with at least one commit, or a git URL to
   clone. Tick the secret you just added.
3. Open **Terminal ↗** and run `claude` (or `omp`, `opencode`). The first
   requests to each new host wait for your approval — a popup appears right
   in the terminal and editor tabs (and in the **Network** panel on the
   project's page).
   Egress is blocked by default.
4. When you like the result, **Sync back**: the VM's workdir is copied into
   your folder as ordinary, uncommitted file changes — review them with
   `git diff` and commit what you want. Nothing is committed for you, in the VM
   or in your repo, and uncommitted work of yours in the folder is never
   overwritten: the sync stops and lists what is in the way.

`sadbox doctor` reports what is missing if something does not start. sadbox
listens on localhost only by default; see [Deploying](#deploying) before
exposing it to other machines.

To update, re-run the install script (or `git pull && bun install` from
source), then `sadbox setup` again if the release notes mention a new base
image. To uninstall, remove the binary and `~/.sadbox`.

### CLI

```
sadbox serve     start the supervisor (default)
sadbox setup     check deps, start container system, build the base image
sadbox doctor    report environment health
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
version to edit by hand. The same commit points `packaging/homebrew/sadbox.rb`
at the new release (version, download URLs and sha256s, via
`scripts/set-formula.sh`); if you publish a tap, copy that file into it.

Create a project from the dashboard (name + path to a local git repo), click
**Terminal ↗** for its tmux in a new tab, run `claude` in it, and use
**Sync back** when you like what you see — the VM's files are copied into
your folder as uncommitted changes for you to review and commit.

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
  (+ token for private) and the VM **clones** it into the workdir. A cloned
  project starts with no local folder, so it pushes to the remote from inside
  the VM — or you **connect a local folder** to it later (detail page → Folder
  & git → *Connect a folder…*) and use **Sync back** like any other project.
  The folder can be a git repository or any other folder.
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
- **Terminal**: xterm.js ⇄ WS ⇄ `Bun.spawn({terminal})` PTY ⇄
  `container exec -it <project> tmux new -A -s main`. Sessions live in the VM and
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
  in the VM: each read or save is a short `container exec`. The agent edits the
  same files, so a save is refused if the file changed in the VM since you
  opened it (reload, or overwrite deliberately), and an unedited tab picks up
  the agent's changes when you return to it. It is an editor, not an IDE — no
  language server, debugger or project-wide search — and it handles UTF-8 text
  files up to 2 MB.
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
- **Approve where you are working**: when something in the VM asks for a host
  no rule covers, the proxy holds the request and a popup appears on the
  terminal and editor tabs with the method, URL and a countdown. **Allow** it
  for just that request, 1 / 5 / 30 minutes, an hour, or always — or **Deny**
  it (once, or "always block"). The command is waiting meanwhile and continues
  as soon as you answer; unanswered requests are denied after 2 minutes. The
  same prompts still appear on the project's detail page, and answering in one
  place clears the other.
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
- **Sync-back**: the guest records its workdir as a snapshot commit on a hidden
  ref (throwaway index — branch and working state untouched) → `git bundle`
  over exec stdout → fetched into a private repo whose work tree is the folder
  → `git checkout` there writes the changed files; a diffstat is returned to
  the UI.
- **Detail view**: per project, live CPU %/memory/disk/network/process usage
  (via `container stats` + in-guest probes), workdir size, tmux session/window
  counts and attached-terminal count, the branch the VM has checked out now
  and its dirty state (the projects list shows the live branch too; for a
  stopped VM it is the last one seen, kept in the database), folder/remote
  info, and the installed-toolchain probe — plus the live **Network** panel
  (below). The buttons along the top are **Terminal**, **Editor**, **Sync
  back** (once a folder is connected), **Secrets**, **Stop** / **Start**,
  **Rebuild** and **Destroy**; the project cards on the list carry the same
  ones. **Stop** (solid red) shuts the VM down and keeps its disk — files,
  installed packages and logins — while agents and terminals in it end;
  **Start** (blue) boots it again. **Change…** next to Memory gives that one VM more (or less) memory:
  a running VM is shut down and booted again with the new size, so agents and
  terminals in it end, while its files, installed packages and logins stay.
  A **Rebuild** action destroys the VM and recreates it from the
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
  supervisor's own setup traffic (cloning the repo, extra apt packages) goes
  through the proxy too, is logged, and skips the prompt only while setup
  runs. If the supervisor restarts, running VMs wait and carry on; if the
  relay in a VM dies, it is restarted within about half a minute. Projects
  created before this still sit on Apple's NAT network with direct internet —
  the detail view marks them **not isolated** — until you **Rebuild** them.
  `SADBOX_NETWORK=default` opts out for new projects.

- **Port forwards** (inbound): on the detail view, map a port on the supervisor
  host to a port inside the VM (e.g. host `8080` → VM `8000`) and open the app
  the agent is running at `<supervisor-host>:8080`. Since a VM has no network
  address, each connection is carried into the VM over `container exec` and
  connected to the VM's own loopback — so it reaches whatever listens on that
  port, bound to `127.0.0.1` or `0.0.0.0` alike, for HTTP, WebSockets or any
  other TCP. Forwards persist across supervisor restarts and rebuilds and are
  removed with the project. They listen on all interfaces of the host, so a
  forward is reachable on the **same domain as the web UI** with just the port
  changed (`http://sadbox.internal.example.com:8080`), even when the UI itself
  is on localhost behind a reverse proxy. They are plain, unauthenticated TCP —
  not behind that proxy's TLS or sadbox's sign-in — so anyone who can reach the
  host can reach a forwarded port; set `SADBOX_FORWARD_HOST=localhost` to keep
  forwards on this machine only.
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
| GET/POST | `/api/projects` | list (with live VM state and each VM's current `branch`) / create (`{name, sourcePath?, apps?, secretIds?, git?: {remote, token?}}` — omit `sourcePath` to clone `git.remote` in the VM) |
| GET | `/api/projects/:id/details` | full detail: resources, tmux, git, folder |
| DELETE | `/api/projects/:id` | destroy VM |
| POST | `/api/projects/:id/start`, `…/stop` | boot a stopped VM / shut a running one down (its disk is kept) |
| POST | `/api/projects/:id/sync` | sync-back (`{force?: bool}` overwrites files changed in the folder) |
| GET | `/api/projects/:id/term/links` | links currently on the project's terminal (wrapped URLs re-joined) |
| POST | `/api/projects/:id/rebuild` | destroy + recreate the VM from the project's original source (keeps secrets + net rules) |
| GET | `/api/projects/:id/sync/status` | count of uncommitted files in the VM |
| PUT | `/api/projects/:id/memory` | `{memoryMB}` — change this VM's memory; a running VM is restarted to take it (disk kept) |
| PUT/DELETE | `/api/projects/:id/sync-folder` | connect (`{path}`) / disconnect a local folder for a project cloned from a git URL |
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
| GET/POST | `/api/projects/:id/forwards`, DELETE `…/:fid` | port forwards (`{hostPort, guestPort}`) — host port → VM port |
| GET/POST | `/api/net/rules`, DELETE `/api/net/rules/:id` | global allow/block rules |
| GET/POST | `/api/net/headers`, DELETE `/api/net/headers/:id` | global header rewrites |
| GET | `/api/net/pending` | `{projectId: count}` pending approvals (nav badges) |
| GET | `/api/net/ca` | download the proxy CA (`.crt`) |
| POST | `/api/auth/login`, `/api/auth/logout` | sign in (`{password}` → session cookie) / sign out |
| GET | `/api/auth/status` | `{enabled, signedIn}` |

Every endpoint except `/api/auth/login` and `/api/auth/status` needs the session
cookie (`401` otherwise).

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
git clone https://github.com/sgsaravana/sadbox.git && cd sadbox && bun install
bun run build:image          # bake the base image
bun run start                # or a launchd plist for boot persistence
```

The ECR image is still worth pushing — it's the artifact for the Linux
deployment path once the `kvm` driver lands, and it runs the UI/API anywhere.

### Serving to the LAN behind Caddy (Mac mini home server)

sadbox binds **`localhost:7070`** by default and speaks plain HTTP, so the right
shape is: run it natively, leave it on localhost, and let the Caddy already on
your Mac mini be the only network-facing piece — it terminates TLS and
reverse-proxies to `127.0.0.1:7070`. sadbox's own sign-in still applies behind
it; Caddy's `basic_auth` is an optional second layer. A ready-to-adapt block is in
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

Notes:
- **WebSocket** (the browser terminal) is upgraded automatically by Caddy v2 —
  no extra config. The terminal picks `wss://` on an HTTPS page, so it works
  through TLS. `flush_interval -1` is what keeps the live **network feed** (SSE)
  streaming instead of buffering.
- **Keep sadbox on localhost.** Since Caddy is on the same host you don't need
  `SADBOX_HOST=0.0.0.0`; leaving it on localhost means the only way in is
  through Caddy (and so over TLS — the sign-in password should never cross
  the network in plain HTTP). Set `SADBOX_HOST` only if Caddy runs on a
  different machine.
- **Only route 7070.** Port 7071 is the egress proxy for older VMs that still
  sit on a network (new ones use a private socket instead); it refuses any
  client that is not a project VM and must not be proxied.
- Use a **dedicated hostname** (or the root), not a subpath — sadbox serves its
  assets and API from `/`.
- Run it under **launchd** so it survives reboots (or `brew services` once the
  formula is in use); Caddy keeps proxying to the same localhost port.

## Known limitations (v0)

- A **local-folder** source must be a git repo with ≥ 1 commit (tar-out fallback
  for non-git folders is designed in `docs/research/06`, not built); or create
  from a **git URL** and the VM clones it instead.
- The web UI speaks plain HTTP. It is password-protected, but to reach it from
  other machines put a TLS reverse proxy in front (see the Caddy setup under
  [Deploying](#deploying)) rather than exposing `SADBOX_HOST=0.0.0.0` directly,
  or the password and session cookie cross the network unencrypted.
- **Forwarded ports are not covered by sign-in**: they are raw TCP to the app
  in the VM, reachable by anyone who can reach this machine on that port.
- Apple silicon + macOS 26 only (see [Supported platforms](#supported-platforms));
  the Linux/Cloud Hypervisor driver and docker-compose packaging are designed
  (`docs/research/02`) but not built.
- Secret rotation reaches new shells/panes only (env-file semantics).
- Egress is HTTP(S)-only, through the proxy; tools find it via
  `HTTP(S)_PROXY` (curl, git, bun, pip do; Node's built-in `fetch` does with
  `NODE_USE_ENV_PROXY=1`, which is set). A program that ignores those variables
  has no network at all. WebSockets *out of* a VM are not supported by the
  proxy. Projects created before isolation stay on the NAT network until
  rebuilt. Proxy env + CA reach new shells only (same env-file semantics as
  secrets).
- VMs must be started by sadbox. One started by hand with `container start`
  comes up without its proxy relay; sadbox restarts the relay within about
  half a minute while the supervisor is running.
- Claude Code auth: create a `CLAUDE_CODE_OAUTH_TOKEN` secret (from
  `claude setup-token` on the host) and assign it to projects — or an
  `ANTHROPIC_API_KEY`. See `docs/research/05`.
