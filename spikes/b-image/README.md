# Spike B — worker image & provisioning latency

Builds the real sadbox worker image and measures the provisioning path from
`docs/research/03-guest-image-provisioning.md`. Uses Spike A's bridge
(`../a-terminal`, `TARGET=container WORKER=spike-b`) for the terminal checks.

## Image

`Dockerfile` → `container build -t sadbox-worker:spike-b .`

- **debian:trixie-slim** — deliberate divergence from research doc 03's
  bookworm recommendation: bookworm ships tmux 3.3a, but the Claude Code
  flicker fix needs tmux ≥ 3.4. Trixie ships **3.5a**.
- Baked: curl, git 2.47.3, tmux 3.5a, ncurses-term, Bun 1.4.2 (official
  installer), **Claude Code 2.1.272** (official native installer),
  `DISABLE_AUTOUPDATER=1`, locales (UTF-8), ripgrep, jq, sudo.
- Non-root `agent` user (uid 1000) with passwordless sudo; `~/.tmux.conf`
  baked (tmux-256color + RGB + mouse).
- `container exec` honors the image's `USER` — sessions run as `agent`
  without extra flags; `-u root` available for admin ops.

## Measured (M1 Max, 2026-09-15)

| Step | Time |
|---|---|
| Image build (`container build`, cold-ish cache) | 72 s (one-time per image update) |
| `container run` → VM running, warm image | **0.78 s** |
| Workdir copy-in: 2,247 files / ~50 MB source repo (tar over exec, node_modules excluded) | **0.35 s** |
| **Create → ready worker with repo inside** | **≈ 1.2 s** |
| `container cp`, full 113 MB incl. node_modules (rejected, see below) | 2.8 s |

## The copy-in recipe that works

```sh
COPYFILE_DISABLE=1 tar --no-xattrs -C "$SRC" --exclude node_modules -cf - . \
  | container exec -i <worker> sh -c 'mkdir -p ~/workdir && tar -xf - -C ~/workdir'
```

Verified: file count matches host exactly, ownership `agent:agent`, git repo
fully intact in the guest (`git log`/`git status` work).

## Findings

- **`container cp` is unusable for workdir injection**: it preserves the host
  uid (501), which maps to no guest user — files land as `UNKNOWN`, and the
  `agent` user can't write or even delete them. Use tar-over-exec, which
  creates files as the exec user.
- **macOS bsdtar needs BOTH flags**: `COPYFILE_DISABLE=1` (else ~1 AppleDouble
  `._*` file per real file — 2,556 junk files in our test) *and* `--no-xattrs`
  (else a `LIBARCHIVE.xattr.com.apple.provenance` warning per file from GNU
  tar in the guest).
- Claude Code's official native installer works headlessly in a Dockerfile
  `RUN` as non-root (→ `~/.local/bin`); Bun's likewise (→ `~/.bun/bin`).
- Claude Code TUI verified through the full bridge (WS byte capture,
  `test-claude-tui.ts` in spike A): alt-screen, onboarding screen, theme
  picker with syntax-highlighted diff preview all render inside tmux in the
  microVM. First visual frame ~1–2 s after `claude`.

## Verdict

**Spike B passes.** One Dockerfile produces a worker image with the full
toolchain; a warm create-to-ready cycle is ~1.2 s — well inside "disposable"
territory. Provisioning recipe and gotchas above go straight into the
supervisor's copy-in module.

## Next (Spike C)

Sync-back: guest autocommits to a `sadbox/<worker>` branch, exports an
incremental `git bundle` over exec stdout, host fetches it into a tracking
ref and previews the diff. Then scaffold the supervisor.
