# Spike C — git-native sync-back

Proves the sync-back design from `docs/research/06-workdir-sync.md`: the
worker's changes flow host-ward as git commits over the existing exec channel —
no sshd, no rsync, no shared mounts — and the host previews everything before
touching its worktree.

Test bed: the `spike-b` worker from `../b-image` with a 2,247-file repo
copied into `~/workdir` (Spike B's tar recipe).

## The flow (all verified 2026-09-15)

```sh
# 1. provision-time, once per worker (supervisor does this):
container exec <w> sh -c 'cd ~/workdir \
  && git config user.name "sadbox worker <w>" \
  && git config user.email worker@sadbox.local \
  && git checkout -b sadbox/<w>'

# 2. worker commits (the agent does this itself, or supervisor autocommits):
#    ... edits ... git add -A && git commit

# 3. sync-back, on demand from the web UI:
container exec <w> sh -c 'cd ~/workdir && git bundle create - <last-synced-sha>..sadbox/<w>' \
  > /tmp/<w>.bundle
git -C <source> fetch /tmp/<w>.bundle 'sadbox/<w>:refs/remotes/sadbox/<w>'

# 4. preview — worktree untouched:
git -C <source> log --oneline master..refs/remotes/sadbox/<w>
git -C <source> diff master...refs/remotes/sadbox/<w>

# 5. apply = plain git, user's choice: merge / cherry-pick / checkout per-file
```

## Measured

| Step | Result |
|---|---|
| Bundle create + stream over exec stdout (round 1: 1 commit + 120 deletions) | 0.10 s, **650 bytes** |
| Host fetch into tracking ref | 0.05 s |
| Round 2 incremental bundle (basis = last-synced sha) | **550 bytes**, only the new commit |
| Host reads file content from ref without checkout (`git show ref:path`) | ✓ |
| Host worktree/status after fetch | untouched, clean |

## Findings

- `git bundle create -` streams binary-safe through `container exec` stdout.
  The supervisor records the last-synced sha per worker and uses it as the
  bundle basis; bundles stay tiny regardless of repo size.
- Fetching into `refs/remotes/sadbox/<worker>` makes the worker's work appear
  as a remote branch in every git UI the user already has — review works
  anywhere, not just in sadbox's web view.
- **Guest git identity must be set at provision** (repo-local
  `git config user.name/email`) or commits fail. Do it in the copy-in step.
- **Edge case — exclusions vs. committed paths**: copy-in excludes
  `node_modules`; if the source repo has such paths *committed* (our synthetic
  repo did), the worker's first commit records them as deletions, which then
  appear in sync-back. Mitigation for the supervisor: derive the exclusion
  list from the source repo's `.gitignore` (only exclude ignored paths), and
  warn when an exclusion pattern matches tracked files.
- Not spiked (research 06 covers the design): tar-out fallback for non-git
  source folders; autocommit cadence in the guest.

## Verdict

**Spike C passes.** Sync-back is sub-second and a few hundred bytes per sync,
side-effect-free on the host until an explicit apply, and reuses the exec
channel — zero additional guest infrastructure.

All three de-risk spikes (A: terminal, B: image/provisioning, C: sync) have
now passed. Next: scaffold the supervisor proper.

## Cleanup

```sh
container stop spike-a spike-b && container rm spike-a spike-b
pkill -f "bun run server.ts"
```
