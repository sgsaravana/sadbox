# Spike E — Cloud Hypervisor + guest agent

Linux phase L0 in [`docs/ROADMAP.md`](../../docs/ROADMAP.md#then-linux-support):
boot the sadbox base image under Cloud Hypervisor (CH) on KVM, and prove the
channel the Linux driver will use for everything — exec, PTY, byte streams and
the proxy's socket — over vsock, with timings to set against macOS (≈ 1.2 s
create → ready).

## Pieces

| File | What it is |
|---|---|
| [`guest/agent/`](../../guest/agent/README.md) | **sadbox-agent** (Go, static, ~3 MB): the VM's init and the host's way in. It started here and moved out for L1. |
| `probe.ts` | The checks, from the host side (below). |
| `build-rootfs.sh` | `images/base` → `docker build` → `docker export` → ext4, with the agent as `/sbin/sadbox-agent`. The image's ENV / USER / WORKDIR, which an export drops, go to `/etc/sadbox/image.json` for the agent. |
| `run-ch.sh` | Fetches CH and the CH kernel (pinned), clones the disk, boots, probes, powers off, then boots the same disk again. Writes `out/results-<machine>.json`. |
| `.github/workflows/spike-e.yml` | Runs both scripts on GitHub's Ubuntu runners: x86_64 has `/dev/kvm`, and arm64 is tried to find out whether it does. The results go to the run summary and an artifact. |

**Why not Apple's vminitd under CH** (open question #2 in `research/README`):
vminitd is Swift, speaks the Containerization framework's internal gRPC API, and
expects that framework's boot sequence. Building it for Linux and tracking its
changes would cost more than this agent does. The macOS driver keeps
`container exec`; the two meet at the `ProjectDriver` interface, not at the
wire protocol.

## Protocol

One operation per vsock connection. CH's hybrid vsock makes the guest's
vsock a unix socket on the host: write `CONNECT 1024\n`, read `OK <n>\n`, then
the stream. Frames are `[type u8][length u32 BE][payload]`.

| Direction | Types |
|---|---|
| host → guest | `0` request (JSON, first) · `1` stdin · `2` stdin EOF · `3` resize `{cols,rows}` · `4` signal (1 byte) |
| guest → host | `10` started `{pid}` · `11` stdout · `12` stderr · `13` exit `{code,signal}` · `14` error `{message}` · `15` ok |

Requests:
- `{"op":"ping"}`
- `{"op":"exec","argv":[…],"user":"agent","env":["K=V"],"cwd":"…","tty":{"cols":80,"rows":24}}`
  - The user defaults to the image's `USER`, and the environment is the image's
    plus HOME, USER, SHELL and TERM (with a tty).
  - It runs in its own session. Closing the connection early kills its process
    group.
  - After exit, output is read until EOF, or until it has been idle for 1 s,
    since a background child may hold the pipe.
- `{"op":"connect","path":"/run/sadbox/proxy.sock"}` → ok, then raw bytes both
  ways. This is the host dialling a unix socket in the guest, which replaces
  `container run --publish-socket` for the proxy carriers.
- `{"op":"poweroff"}` → syncs and powers off. CH exits.

The driver's operations map onto it:
- `exec`, `execWithStdin` and `execCaptureBytes` → `exec`
- `stream` → `exec` with stdin open
- `terminal` → `exec` with `tty`, plus resize frames
- the proxy socket → `connect`

## Checks (`probe.ts`)

ping round trip · exec as the image user in its workdir, with its PATH · exec
as root · exit codes, stderr apart, SIGTERM → 143, missing binary → error ·
exec latency (p50/p95 of `true`) · 64 MB stdin through `sha256sum` · 256 MB
stdout · output just before exit fully delivered · a background child holding
stdout does not hang exec · closing the connection kills the process · PTY:
`/dev/pts/N`, size, resize, input, exit code · `connect` to a guest unix socket
(1 MB echo) · guest loopback (listen + fetch on 127.0.0.1) · `sudo -n` as the
agent user · **Claude Code's TUI under tmux through the PTY**.

Run it locally against any Linux box running the agent with
`-listen tcp:HOST:PORT` (`--tcp`). On a Mac, use a `container` VM and
`--relay <name>`, which carries each connection over `container exec`:

```sh
cd guest/agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o out/sadbox-agent-arm64 .
cfg=$(container image inspect sadbox-base:latest | jq -c '.[0].variants[] | select(.platform.architecture=="arm64") | .config.config | {Env, User, WorkingDir}')
container run -d --name sbx-e-agent -u root -v "$PWD/out:/opt/agent" sadbox-base:latest \
  sh -c "mkdir -p /etc/sadbox && printf '%s' '$cfg' > /etc/sadbox/image.json && exec /opt/agent/sadbox-agent-arm64 -init off -listen tcp:127.0.0.1:1024"
cd ../../spikes/e-cloud-hypervisor && bun probe.ts --relay sbx-e-agent
```

## Results

### Local, the agent's protocol (M1 Max, Apple `container` VM, not CH) — 2026-11-09

All 15 checks pass. The timings are mostly `container exec`, which carries
every connection here (ping ≈ 85 ms, exec p50 ≈ 90 ms). They say nothing about
vsock. Streams: stdin ≈ 200 MB/s, stdout ≈ 300 MB/s through that relay.

Bugs fixed along the way:
- Output after exit got a flat 1 s, so a fast producer lost its tail and a
  background child stalled exec for 30 s. Draining now stops only once output
  is idle.
- In the test relay, its stdout must be flushed before it exits.

### Cloud Hypervisor on KVM (GitHub Actions, x86_64) — 2026-11-09

AMD EPYC 7763, CH v54.0, guest kernel 7.2.8, 2 vCPUs, 2 GB. **All 15 checks
pass**, Claude Code's TUI under tmux included.

| Measure | Value |
|---|---|
| image build (docker) | 43 s |
| rootfs (export + mkfs.ext4) | 33 s, 1.8 GB used of 3.3 GB |
| per-project disk clone (full copy, ext4) | 0.8 s |
| boot: launch → agent answers | 6.2 s (inflated, see below) |
| restart: launch → agent answers | 2.1 s (inflated, see below) |
| poweroff → VMM exit | 1.06 s (the agent's 1 s SIGTERM grace) |
| ping | 0.73 ms |
| exec `true` p50 / p95 | 1.7 / 2.3 ms |
| stdin / stdout | 94 / 234 MB/s |

For comparison, `container exec` on macOS costs ≈ 90 ms per exec, so vsock
exec is ~50× faster.

**The boot times are an upper bound.** CH accepts a hybrid-vsock `CONNECT`
before the guest listens, and the connection then sits unanswered. The probe
gave each attempt 2 s before retrying, so the boot times are rounded up to that
(the restart's 2055 ms is one 2 s timeout plus ~50 ms). Each attempt now gets
250 ms. The next run measures boot properly.

**arm64:** `ubuntu-24.04-arm` has no `/dev/kvm`, so the job stops after
checking for it.

Follow-ups for L1:
- Poweroff: wait for processes to exit, not a flat 1 s.
- Boot readiness: the host can't tell "not up yet" from "stuck", so the
  driver needs short attempts, or the agent should announce itself (e.g.
  dial the host on vsock when ready).
- stdin at 94 MB/s is below stdout. It's 1 MB frames through a pipe into
  `sha256sum`, so it's fine for the driver's uses, but larger frames are worth
  trying.

**Exit criterion** (ROADMAP L0): Claude Code's TUI usable in the browser
through a CH guest. In CI this is the TUI check above: alt-screen and Claude
Code's text drawn through tmux over the PTY. A by-hand browser check waits for
L3 (a real `driver/kvm`) or a Linux box.

## Not covered yet

- arm64 KVM: GitHub's arm runner has none. Needs a Graviton `.metal` or an
  M3+ Mac with nested virtualization.
- Copy-on-write disks: the runner's ext4 makes `cp --reflink=auto` a full
  copy. qcow2 overlays or a reflink filesystem are L2's job.
- Stats, memory changes (balloon) and snapshot/restore: L3 / L7.
- virtiofs mounts (agent history): L3.
