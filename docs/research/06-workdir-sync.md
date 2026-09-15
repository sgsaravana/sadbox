# 06 — Workdir Copy-In and On-Demand Sync-Back

Status: research, September 2026. Nothing built yet.

## Context

sadbox provisions microVM workers (Linux guests) and copies a selected host folder
("source folder", usually a git repo) into the guest home dir as `~/workdir`. It is a
copy, not a mount — the agent (Claude Code) inside the VM must never be able to touch
the original. Later, on an explicit user action in the web UI, the guest's workdir is
synced back into the source folder.

Backends: today Apple Containerization / Virtualization.framework on macOS 26
(APFS, arm64); later a Firecracker-class backend on Linux. Two facts shape everything:

1. **Cross-OS copy.** Host is macOS, guest is Linux. `node_modules` (native addons),
   `.venv`, Rust `target/`, anything with compiled artifacts is built for
   darwin-arm64 and is dead weight or actively broken inside the guest. These should be
   **excluded at copy-in and reinstalled inside** (`npm ci`, `uv sync`, `cargo build`),
   not shipped. This also cuts the typical 1–2GB repo down to 50–300MB of actual source.
2. **Firecracker has no virtio-fs**, deliberately, for attack-surface reasons
   ([issue #1180](https://github.com/firecracker-microvm/firecracker/issues/1180)); it
   exposes only virtio-blk, virtio-net, and vsock. Any design that leans on virtiofs is
   macOS-only. Portable primitives are: **block devices** and **streams over vsock**.

One more platform landmine: since macOS Sequoia, `/usr/bin/rsync` is **openrsync**, not
GPL rsync 3.x. openrsync speaks only protocol 27–29 and supports `-n`, `--delete`,
`--exclude`/`--filter`, `-b`/`--backup-dir` — but **not `--itemize-changes`**
([man page](https://manp.gs/mac/1/openrsync)). Any plan that says "just rsync over ssh
with itemized dry-run" either bundles GPLv3 rsync (licensing friction for a shipped app)
or breaks on a stock Mac.

## Copy-in options

| Option | Portable? | Speed (repo w/o node_modules, ~50–300MB) | Notes |
|---|---|---|---|
| **Per-worker ext4 image built at provision** | Yes | Seconds; host-disk-bound (~GB/s APFS SSD) | Best |
| tar stream over guest-agent exec (vsock) | Yes | Seconds; vsock streams at 100s of MB/s | Good fallback |
| virtiofs mounted briefly, `cp` inside, unmount | macOS only | Slow — many-small-file cp over virtiofs is ~3x native even in 2025-era Docker/VZ ([benchmarks](https://www.paolomainardi.com/posts/docker-performance-macos-2025/)) | Reject |
| rsync/ssh into guest | Yes | Fine, but needs sshd+rsync in guest image | No win for a *first full* copy vs tar |

**Recommended: build the workdir as its own ext4 block image at provision time.**

- macOS: Apple's Containerization package ships a `ContainerizationEXT4` module whose
  stated purpose is to "create and populate ext4 file systems" from Swift on the host
  ([apple/containerization](https://github.com/apple/containerization)) — the same
  machinery it uses to turn OCI layers into root filesystems. Write the filtered source
  tree into `worker-<id>/workdir.img`, attach as a second virtio-blk device, have the
  init mount it at `~/workdir`.
- Linux/Firecracker: `mkfs.ext4 -d <dir> workdir.img` populates an image from a
  directory **unprivileged, no loop mount** ([mke2fs(8)](https://man7.org/linux/man-pages/man8/mke2fs.8.html)) —
  this is already the standard Firecracker rootfs-building idiom.

Why an image beats streaming: the workdir exists before the guest even boots (no agent
handshake in the critical path), it is atomic (image either fully built or not), it
gives a natural per-worker disk quota, and it keeps workdir I/O off the rootfs image.
Keep **tar-over-agent-exec** (`vminitd` gRPC exec over vsock on Apple; our own agent on
Firecracker) as the fallback path and for late additions ("copy this extra folder in").

Copy-in filter: honor `.gitignore` plus a sadbox-level exclude list (`node_modules`,
`.venv`, `target`, `dist`, `build`, `.DS_Store`; see Safety rails for `.env`). Do copy
`.git` — it is the backbone of sync-back. First boot runs the project's install step
inside the guest.

## Sync-back options compared

The job: guest `~/workdir` → host source folder, on demand, with the host folder
possibly modified meanwhile, with preview, and with the ability to pick files.

**(a) rsync over ssh, `--delete` + excludes.** One-way mirror; "conflict handling" is
"guest silently wins", softened only by `--backup`/`--backup-dir` stashing overwritten
files. Needs sshd + rsync in every guest image and real rsync on the host (stock macOS
openrsync lacks `--itemize-changes`, so the preview story degrades; bundling GPL rsync
3.x has license overhead). Fast and well-understood, but the safety/conflict story is
the weakest of the serious options. Verdict: acceptable *engine* for non-git folders,
but not over ssh — see the staging variant below.

**(b) Mutagen.** Acquired by Docker in 2023 ([announcement](https://www.docker.com/blog/mutagen-acquisition/));
the standalone OSS project's last release is **v0.18.1, Feb 2025** — ~19 months stale as
of Sept 2026, with energy visibly redirected into Docker Desktop's Synchronized File
Shares. Architecturally it is a **continuous-session daemon** (create/pause/flush/
terminate); on-demand sync means faking one-shot via `create --paused` + `flush` +
`terminate`, and it injects its own agent binary into the guest. Its conflict model
(two-way-safe: never auto-resolve destructively) is genuinely good
([docs](https://mutagen.io/documentation/synchronization/)), but we'd be adopting a
daemon + agent + session lifecycle to press a button once. Verdict: wrong shape for
"user clicks Sync"; risk of depending on a slow-moving standalone project.

**(c) Git-native.** Guest commits; host **fetches** the worker's branch. Fetch never
touches the host working tree, so the source folder is untouched until the user
explicitly merges — the safest possible default, and diff/review comes free. Proven
pattern: sketch.dev ran the agent in a container clone with a `sketch-host` remote and
auto-pushed `sketch/*` branches to the host clone ([docs](https://sketch.dev/docs/git);
project archived Jul 2026, but the pattern lives on in its successor and in Dagger's
[container-use](https://github.com/dagger/container-use), which gives each agent
environment a branch reviewable via plain `git checkout`). Verdict: **primary**.

**(d) Unison.** Alive (2.54.0, May 2026,
[releases](https://github.com/bcpierce00/unison/releases)) and principled about
bidirectional conflicts, but: OCaml binary needed on both sides, historically fussy
version pairing, interactive-first conflict model, and we don't actually want
bidirectional sync (host→guest updates are a non-goal for v1). Verdict: no.

**(e) tar-out and replace.** Trivial and dependency-free, but obliterates concurrent
host edits, no delta, no per-file pick. Verdict: only as the transport into a staging
dir — never directly onto the source folder.

**Fallback that actually fits (non-git folders): tar-out → host staging dir → local
apply.** Stream `tar -C ~/workdir -cf -` out of the guest over the existing agent exec
channel into `worker-<id>/staged/`. Then all comparison and application happens
**host-local**: preview with `git diff --no-index source/ staged/` (works in any folder,
git ships on every dev Mac, output is proper unified diff for the web UI), apply with
local openrsync `-a --delete --backup --backup-dir` (openrsync supports all of these) or
our own file-walker. No sshd, no rsync in the guest, no GPL bundling, and the dangerous
step is a local, previewable, backed-up operation.

## The git-native option

Since workdirs are usually git repos and Claude Code commits as it works, make
**"sync = fetch the worker's branch into the source repo"** the primary mechanism.

Flow, per sync click:

1. **Guest side (via agent exec, no ssh needed):** if the worktree is dirty, create a
   sync commit: `git add -A && git -c user.name="sadbox worker <id>" -c
   user.email="worker-<id>@sadbox.local" commit -m "sadbox auto-sync <timestamp>"`.
   (When Claude Code already committed, this is a no-op.) Ensure work sits on a branch
   `sadbox/<worker-id>` — create it at copy-in time so the agent's commits land there
   by default.
2. **Export:** `git bundle create - sadbox/<worker-id> --not <base-commit>` streamed
   over the agent channel to `worker-<id>/sync.bundle` on the host. Bundles are a
   first-class fetch source ([git-bundle docs](https://git-scm.com/docs/git-bundle)),
   and incremental (`--not <base>`) bundles stay tiny. This avoids running sshd or
   git-daemon in the guest and avoids the host needing network reachability into it.
3. **Import (side-effect-free):** in the source repo,
   `git fetch <bundle> sadbox/<worker-id>:refs/remotes/sadbox/<worker-id>`.
   Fetch runs no hooks and executes nothing from the fetched objects; git's fetch path
   is designed for untrusted remotes. The source working tree is still untouched.
4. **Review in the web UI:** `git diff <merge-base>...refs/remotes/sadbox/<id>` rendered
   as a file list + unified diffs.
5. **User applies**, choosing one of: fast-forward/merge into current branch; create a
   local branch from the ref (recommended default — mirrors sketch's `sketch/*` UX);
   cherry-pick; or per-file `git checkout refs/remotes/sadbox/<id> -- <path>` for
   partial sync. Working-tree writes are gated by the safety rails below.

In-guest requirements: git in the guest image (already required for Claude Code),
a configured git identity (inject `user.name`/`user.email` — the worker's own identity,
or forward the host's `git config` like VS Code dev containers forward Git identity),
and the pre-created `sadbox/<worker-id>` branch. **No sshd, no host→guest ssh keys, no
git server** — the bundle rides the same vsock exec channel everything else uses.
(ssh remote — `git fetch ssh://guest/...` — remains a valid alternative if we later run
sshd anyway; bundles just have fewer moving parts.)

What git-native does *not* carry: untracked-but-ignored files (build artifacts —
good) and files matching `.gitignore` that the user actually wants (rare; the rsync
fallback path covers it). Uncommitted guest changes are handled by step 1's autocommit.

## Diff/preview

Preview before overwrite is not a nice-to-have; it is the core UX of this feature —
the user's whole job here is "review the agent's work, then accept it".

- **Git path:** preview is structurally free. Fetch first (harmless), then serve
  `git diff --numstat` for the file list and per-file unified diffs. This is exactly
  a PR review screen; sketch.dev even supported inline comments on the diff feeding
  back into the agent chat — a compelling later feature for sadbox.
- **Non-git path:** after tar-out to staging, `git diff --no-index --numstat source/
  staged/` gives the identical data shape, so the web UI renders one diff component for
  both paths. Do not build the preview on rsync dry-run output: openrsync has no
  `--itemize-changes`, and parsing rsync `-n -v` text is brittle.
- Per-file checkboxes in the UI map to `git checkout <ref> -- <paths>` (git path) or a
  path-filtered copy from staging (fallback path). Same selection model for both.

Feasible? Entirely — everything is a subprocess of host git against local data; diffs of
a few hundred files render fine with any diff2html-style component. Guard rails: cap
rendered diff size, mark binary files as "changed (binary)", collapse lockfiles by
default.

## Safety rails

1. **Never write the source folder as a side effect.** Fetch/stage is always step one;
   working-tree mutation only ever happens on a second, explicit user action.
2. **Clean-worktree gate.** Before any working-tree write, require `git status
   --porcelain` to be empty (git path) or offer auto-stash (`git stash push -m
   "sadbox pre-sync"`). Non-git path: refuse to apply if source changed since staging
   (compare mtimes/hashes captured at stage time) unless the user confirms.
3. **Backup before overwrite (non-git apply path).** APFS makes this nearly free:
   `cp -Rc source source.sadbox-bak` uses clonefile(2) for a copy-on-write clone —
   instant and near-zero space until files diverge ([cp -c](https://ss64.com/mac/cp.html));
   Linux: `cp -a --reflink=auto`. Do **not** rely on APFS snapshots: `tmutil
   localsnapshot` is volume-wide, gated to Time Machine-enrolled volumes, and restoring
   a single folder means mounting the snapshot and copying manually
   ([Eclectic Light](https://eclecticlight.co/2019/09/19/volume-recovery-using-an-apfs-snapshot/)).
   Keep the last N=2 backups, garbage-collect older ones.
4. **Symlink policy.** Everything leaving the guest is attacker-influenced (the agent
   wrote it). On tar extraction to staging: extract as an unprivileged user into a fresh
   empty dir, never dereference symlinks (store as links), reject entries with absolute
   paths or `..` components, and reject symlinks whose targets resolve outside the
   workdir before copying them onward. Apply step must use the staging dir as the sole
   source of truth — never re-read paths supplied by the guest.
5. **Exclude list, both directions.** Defaults: `node_modules`, `.venv`, `target`,
   `dist`, `build`, `.next`, `.DS_Store`. **Secrets:** `.env*` is copied *in* only on
   explicit opt-in per project, and is *never* synced back (the agent may have logged
   or rewritten it). Support a `.sadboxignore` (gitignore syntax) in the source folder
   for per-project overrides.
6. **Git-path safety notes.** Fetch executes no hooks; object malleability is git's
   own well-tested territory. The residual risk is post-merge tooling on the host
   (husky hooks, `direnv`) running agent-authored code when the *user* later builds —
   that is inherent to accepting agent work and belongs in the review UX copy, not in
   sync mechanics.
7. **Size cap** on sync-back (default a few GB) so a runaway agent filling the workdir
   disk can't fill the host volume via staging.

## Recommendation

- **Copy-in:** per-worker **ext4 workdir image** built at provision — from the source
  folder filtered through `.gitignore` + defaults + `.sadboxignore` —
  via `ContainerizationEXT4` (macOS) / `mkfs.ext4 -d` (Linux), attached as virtio-blk.
  Exclude `node_modules` and friends unconditionally (cross-OS makes them useless);
  run the install step inside on first boot. Tar-over-agent-exec as the fallback and
  incremental-add path. No virtiofs anywhere (not portable to Firecracker, slow).
- **Sync-back primary (git repos, i.e. the normal case):** git-native. Autocommit in
  guest → incremental `git bundle` over vsock → `git fetch` into
  `refs/remotes/sadbox/<worker>` → web-UI diff review → user-chosen apply
  (branch-from-ref default, merge/cherry-pick/per-file optional). Requires only git +
  identity + a pre-created branch in the guest; no sshd.
- **Sync-back fallback (non-git source folders):** tar-out to host staging dir →
  `git diff --no-index` preview → backed-up (`cp -Rc` clone), path-filtered local apply
  with `--delete` semantics. No Mutagen, no Unison, no GPL rsync bundling.
- **Preview UX:** one diff component fed by git in both paths; apply is always a second
  explicit action; per-file selection supported from day one.
- **Safety rails:** stage-then-apply everywhere, clean-worktree gate, COW backup before
  non-git overwrite, strict symlink/path validation on extraction, `.env` never syncs
  back, size caps.

## Open questions

- Multiple workers from one source folder: ref naming handles it
  (`refs/remotes/sadbox/<worker>`), but the apply UX for overlapping changes needs design.
- Git submodules and LFS: bundle covers the superproject only; decide whether v1
  recurses submodules or documents the limitation. LFS objects need a separate channel.
- Should sadbox optionally push the worker branch straight to `origin` (PR flow) instead
  of the local repo, sketch-style?
- Host→guest *re*-sync ("pull my new commits into the running worker"): same bundle
  mechanism reversed — in scope for v1?
- Guest-dead recovery: can we read `workdir.img` from the host to salvage work when the
  VM won't boot? (Linux: loop mount; macOS: depends on ContainerizationEXT4 gaining
  read support — verify.)
- Non-git folders that *contain* nested git repos: staging apply must treat inner `.git`
  dirs carefully (probably exclude them).

## Sources

- Apple Containerization (EXT4 module, vminitd/vsock, virtio devices): https://github.com/apple/containerization
- Firecracker device model / no virtio-fs: https://firecracker-microvm.github.io/ ; https://github.com/firecracker-microvm/firecracker/issues/1180
- macOS rsync → openrsync: https://derflounder.wordpress.com/2025/04/06/rsync-replaced-with-openrsync-on-macos-sequoia/
- openrsync supported flags: https://manp.gs/mac/1/openrsync
- Mutagen acquisition by Docker: https://www.docker.com/blog/mutagen-acquisition/
- Mutagen releases (v0.18.1, Feb 2025): https://github.com/mutagen-io/mutagen/releases
- Mutagen sync modes & conflicts: https://mutagen.io/documentation/synchronization/
- Unison releases (2.54.0, May 2026): https://github.com/bcpierce00/unison/releases
- sketch.dev git flow (`sketch-host` remote, `sketch/*` branches): https://sketch.dev/docs/git ; https://github.com/boldsoftware/sketch
- Dagger container-use (branch-per-agent-environment): https://github.com/dagger/container-use
- macOS VM filesystem performance benchmarks: https://www.paolomainardi.com/posts/docker-performance-macos-2025/
- git bundle: https://git-scm.com/docs/git-bundle
- mke2fs `-d` (populate ext4 from directory): https://man7.org/linux/man-pages/man8/mke2fs.8.html
- APFS snapshots are volume-wide / TM-gated: https://eclecticlight.co/2019/09/19/volume-recovery-using-an-apfs-snapshot/
- `cp -c` clonefile on APFS: https://ss64.com/mac/cp.html
