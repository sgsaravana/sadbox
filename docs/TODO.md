# TODO

What's left after v0.5.1: Linux (v0.5.0), Intel Macs, the Windows 11/WSL 2 beta,
vaults, agent logins/history and the network controls are merged on `main`.
Most useful first. Phases L4, L6 and L7 are in [ROADMAP.md](ROADMAP.md).

## Verify before the next release

- [ ] **Try it by hand on a real Linux machine with KVM.** CI covers the API
      and the terminal, but not a person using it in a browser.
  - [ ] `curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh`
  - [ ] `sadbox setup`, then `sadbox service install`
  - [ ] create a project, run `claude` in the browser terminal, approve its
        network requests
  - [ ] open a port forward and a named route; sync changes back to the host
  - [ ] reboot: the service comes back and the project starts
  - [ ] the same with docker compose (`docker compose run --rm sadbox sadbox setup`, `up -d`)
- [ ] **Run the Windows 11/WSL 2 beta acceptance checklist.**
      `feature/windows-wsl2` is merged; the runbook is
      [`windows-wsl2-beta.md`](windows-wsl2-beta.md) §5. Cut `v0.6.0-beta.1`
      only after it passes.
- [ ] **Spike D round 2 (real tokens).** The credential proxy is built; the
      remaining verification is real short-lived tokens and a real Claude
      `/login` + refresh through the proxy. Procedure:
      [`spikes/d-credential-proxy/`](../spikes/d-credential-proxy/README.md#vm-experiments-round-2-real-tokens).
- [ ] **CI for the vz driver.** GitHub's `macos-26-intel` runners have
      Virtualization.framework but no Docker, so the Linux x86_64 job should
      build the amd64 disk (`sadbox setup` with the kvm driver, then move/copy
      `images/`) and the kernel (`docker build -o ... images/kernel`) and pass
      them to a macOS Intel job that runs `vz.it.test.ts`.
- [ ] **Test agent history directly.** Add a check to `test/e2e-linux.ts`:
      history written in the VM appears on the host, and a new project with the
      same name gets it back. Today the compose run only shows the mounts
      succeed (`sharedMount` is off on the native CI runner: uid 1001, and
      Ubuntu's virtiofsd can't translate ids).
- [ ] **L6: one contract suite for all three drivers** (`container`, `kvm`,
      `vz`) instead of separate tests.
- [ ] **arm64 Linux.** Builds already, untested: GitHub's arm64 runners have no
      `/dev/kvm`. Needs a Graviton `.metal` instance or similar.

## Named routes

Built on `feature/named-routes` (host-based routes):

- [x] **Host routes** `<name>.<SADBOX_ROUTE_DOMAIN>` → a VM port. One listener
      (`SADBOX_ROUTES_PORT`, loopback 7072), sign-in/open passes, WebSockets,
      the **Named routes** panel, API, tests and docs.
- [ ] **Decide the public shape.** Add `SADBOX_ROUTE_DOMAIN` and a wildcard
      DNS record + certificate; add the Caddy block from
      [`packaging/caddy/Caddyfile.example`](../packaging/caddy/Caddyfile.example).
      Without this the feature stays off and opens no port.
- [ ] **Fix forward/route links behind TLS.** `/forwards/:id/open` still builds
      `http://host:host_port`; use `X-Forwarded-Proto` so a forward behind
      Caddy opens over HTTPS. The named-route path already uses the forwarded
      scheme.
- [ ] **Path form — deliberately not built.** `sadbox.domain.com/sample`
      breaks root-absolute URLs and puts the app on the UI's origin (it can
      call sadbox's API with your session). If wanted later, put path routes on
      a separate app host and require a matching base path: see
      [`research/17-named-routes.md`](research/17-named-routes.md) §8.

## Self-update

Built on `feature/named-routes` (with the named routes):

- [x] `sadbox update` / `sadbox upgrade` for install-script and downloaded
      binaries: GitHub release check, `SHA256SUMS` verification, atomic binary
      replacement, optional systemd/launchd restart. Flags: `--check`,
      `--prerelease`, `--version`, `--no-restart`, `--force`.
- [x] Homebrew, docker and source checkouts are recognised and get their own
      update instructions instead of having the binary replaced.
- [x] Windows launcher passes `update` through to the supervisor inside WSL.
- [ ] Publish the Homebrew tap (formula is in `packaging/homebrew/`) so
      `brew upgrade sadbox` is a real path; today `sadbox update` falls back to
      `brew upgrade sadbox` with a tap hint if it fails.

## Follow-ups

- [ ] **Faster create on Linux.** Each project gets a full copy of the 2 GB
      image disk (`cp --reflink=auto --sparse=always`), about 7 s on ext4,
      which can't reflink. Try a qcow2 overlay on the shared image disk, if
      Cloud Hypervisor's qcow2 support handles backing files.
- [ ] **L4 cleanup.**
  - [ ] UI and `doctor` text says "container" where it means a project's VM.
  - [ ] The secrets key is a plain file in the data dir. Move it to the
        Keychain on macOS and a compose secret (or similar) on Linux.
- [ ] **Outbound WebSockets through the proxy.** Upgrade passthrough in
      `src/net/proxy.ts`, subject to the same rules/approvals.
- [ ] **Vault KEK in Keychain** (pairs with the L4 item above; it also protects
      the agent logins).
- [ ] **Non-git local folders.** tar-in copy + tar-out sync-back with
      `git diff --no-index` preview and backed-up apply (`research/06`).
- [ ] **Live env-file / proxy-env rotation.** Items still written to the env
      file, and the proxy env, reach new shells only.
- [ ] **Workdir `.env` writer.** Placeholder lines in `~/workdir/.env` for apps
      that read `.env` directly (sadbox-managed keys only).
- [ ] **DB backup.** Litestream (or periodic snapshot) of the SQLite file
      (`research/07`).
- [ ] **Scale measurements.** RAM/balloon behavior with 10+ idle VMs; workdir
      copy-in throughput for 1–2 GB repos (open questions #4, #5).
- [ ] **L7: snapshots.** CH snapshot/restore for near-instant resume (Linux).
- [ ] **Readable release notes.** Have the auto-PR workflow title PRs from
      their commits instead of "Merge feature/… into main", or squash-merge.

## Housekeeping

- [ ] Edit v0.4.4's release notes by hand, if wanted (generated before the
      commit-based notes).
- [ ] Releases v0.4.1–v0.4.3 have no binaries. Delete them, or note on each
      to use v0.4.4.
- [ ] Tag v0.5.0 was cut; tag the Windows beta separately if it is released.
