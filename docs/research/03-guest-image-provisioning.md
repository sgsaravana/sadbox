# 03 — Guest OS Images and Worker Provisioning

Status: research, September 2026. Nothing built yet.

## Context

sadbox is a supervisor that spawns N microVM "workers" on the host. Each worker gets a
copy of a local folder (the "workdir") in its home directory, a user-selected set of
apps (curl, Bun, Claude Code, tmux), and runs Claude Code inside tmux, observed from a
web terminal. Host today: macOS 26 (Tahoe) on Apple M1 Max (arm64), so the near-term
backend is Apple's Containerization framework (Virtualization.framework underneath).
A future Linux backend will be Firecracker or Cloud Hypervisor. Everything below is
arm64-first; nothing precludes x86-64 later.

The core design question: one image strategy that provisions workers on all three
backends, fast, with minimal in-guest machinery.

## Base image choice

### glibc vs musl — the facts as of September 2026

Both of our headline apps now officially support musl, which was not true two years ago:

- **Bun** ships official musl binaries — "Linux x64 musl" and "Linux ARM64 musl" — and
  documents glibc 2.17+ for the glibc builds; the install script auto-selects the right
  binary. Alpine is a supported target.
- **Claude Code** officially lists **Alpine Linux 3.19+** as a supported OS. It ships a
  signed **apk repository** (`downloads.claude.ai/claude-code/apk/{stable,latest}`)
  alongside apt and dnf repos, and the npm package has `linux-arm64-musl` /
  `linux-x64-musl` platform binaries. On Alpine it additionally needs `bash`, `curl`,
  `libgcc`, `libstdc++`, and system `ripgrep` with `USE_BUILTIN_RIPGREP=0` (the bundled
  ripgrep is glibc-only). Notably, Claude Code is now a **native binary** — Node.js is
  not required at runtime (npm's Node 22 requirement is install-time only).

So Alpine is *viable*. But the worker is a **general-purpose dev sandbox**: Claude Code
will run `npm install`, `pip install`, cargo builds, whatever the user's project needs.
That ecosystem is still glibc-shaped — prebuilt native Node addons, Python manylinux
wheels, and vendor binaries frequently have no musl build. Debugging "works on my Mac,
fails in the sandbox" musl issues is exactly the support burden a sandbox product should
not take on to save ~100 MB per *image* (not per worker — workers share the base image).

### Verdict

- **Primary base: Debian stable slim (`debian:bookworm-slim` / trixie-slim), arm64.**
  ~30 MB compressed, glibc, apt, first-class Claude Code apt repo, zero ecosystem
  surprises. Fedora minimal buys nothing here and dnf is slower and larger.
- **Optional later: an Alpine "small" variant** for users who want minimal images and
  know their toolchain is musl-clean. Fully supported by Bun and Claude Code now, so
  this is a product option, not a compatibility gamble.

## Image build pipeline

### One source of truth: a Dockerfile → OCI image

All three backends can be fed from a single OCI image built with `docker buildx build
--platform linux/arm64` (or `podman build`). This is the pipeline:

```
Dockerfile (debian:slim + apt: curl git tmux openssh-server ripgrep ca-certificates
            + bun (official installer) + claude-code (Anthropic apt repo, stable channel)
            + adduser agent (uid 1000), sshd config, sadbox guest agent binary)
        │
        ▼  buildx --platform linux/arm64 → OCI image  (push to local registry/OCI layout)
        │
        ├── Apple Containerization: consume the OCI image DIRECTLY.
        │   The framework pulls OCI images and its ContainerizationEXT4 module
        │   "creates and populates ext4 file systems" from the layers, natively in
        │   Swift on macOS — no Linux VM needed to build the block device.
        │
        ├── Firecracker (Linux host): flatten OCI → ext4:
        │   docker create/export (or buildx --output type=tar) → tar
        │   → mkfs.ext4 -d <extracted-dir> rootfs.ext4     # no loop mounts needed
        │   Firecracker's own docs document exactly this Docker→ext4 flow.
        │
        └── Cloud Hypervisor (Linux host): the SAME raw ext4 image attached as
            virtio-block, direct kernel boot (--kernel + --cmdline root=/dev/vda).
            CH supports raw natively; qcow2 exists in the ecosystem but the upstream
            docs convert qcow2→raw with qemu-img — use raw, skip qcow2 entirely.
```

Key points:

- `mkfs.ext4 -d dir img` populates the filesystem directly from a directory tree —
  no root, no loop devices; this is the current best practice for Docker→Firecracker
  rootfs pipelines and removes the mount/cp/umount round-trips.
- **Kernels are separate artifacts**, not part of the image pipeline. Apple
  Containerization takes a user-provided kernel (tested from 6.14.9; a prebuilt
  optimized kernel from the Kata Containers family is the documented default).
  Firecracker publishes CI-tested 5.10/6.1 configs for aarch64; Cloud Hypervisor
  direct-boots a standard `Image` on AArch64 (GICv3 required). Pin one kernel per
  backend in the supervisor, version them independently of the rootfs.
- **mkosi** (systemd's image builder) is the alternative: distro-native, reproducible,
  emits ext4/disk images directly. Rejected as primary because it builds distro images
  from package managers on a Linux host — it can't be the macOS-native path, and it
  forks the pipeline into two build systems. Dockerfile keeps one definition that the
  Apple backend consumes untouched.
- **App selection per worker**: resist a build-matrix of image variants. Ship **one
  "fat" base image** containing curl+tmux+bun+claude-code+sshd; per-worker app
  selection is a provisioning-time toggle (what the agent launches / puts on PATH),
  not a different image. One image means one cache on disk, shared page cache across
  workers, and one rebuild pipeline. Revisit only if image size becomes a real cost.

### Baked vs boot-time install

**Bake everything.** Boot-time installation (apt/curl installers) would add tens of
seconds and a network dependency to every worker create — unacceptable when the VM
itself boots in well under a second.

- Claude Code releases multiple times per week; its **stable** channel is "typically
  about a week old, skipping releases with major regressions". Bake from the apt
  stable channel and **rebuild the base image on a schedule (nightly) plus on-demand**
  ("update runtime" button). Set `DISABLE_AUTOUPDATER=1` in the guest — ephemeral
  workers must not each download an update at boot; freshness comes from rebakes.
- Bun: same story, bake the official arm64 binary, refresh on rebake.
- Rebuild cost is one `docker build --pull` + one flatten step; cache makes it seconds.

**cloud-init: no.** Firecracker's own docs note generic cloud images don't match what
a microVM exposes (device naming, cmdline); cloud-init needs a datasource (seed ISO /
metadata service), runs Python multi-stage at boot, and costs 1–2 s+ — in a VM that
boots in 125 ms. The microVM-native pattern is: kernel cmdline for static facts +
**a tiny in-guest agent over vsock** for everything dynamic (Firecracker's MMDS
key-value store exists too, but vsock is a live bidirectional channel — a pipe, not a
store — and it's the one mechanism all three backends share).

## Provisioning flow

From "user clicks create" to "tmux running with workdir in home":

1. **Supervisor allocates worker identity**: name, vsock CID (Linux backends),
   ed25519 SSH keypair (host-side; private key stays with the supervisor), IP plan
   (backend-specific, see Networking).
2. **Build the workdir disk** (per-worker, the only per-worker artifact): copy the
   selected local folder into a sparse ext4 image sized e.g. 16 GB
   (`mkfs.ext4 -d` on Linux; ContainerizationEXT4 on macOS). Drop in
   `/.sadbox/authorized_keys` and a `worker.json` (selected apps, hostname, git
   identity) at the disk root while building it — config rides the disk, no metadata
   service needed.
3. **Instantiate the VM**: base rootfs attached **read-only** (Linux backends: the
   shared rootfs.ext4 + an ext4/overlay scratch layer or per-worker reflink copy;
   Apple: the framework materializes the ext4 block device from the OCI image),
   workdir disk attached as second virtio-block device, vsock device, NIC, pinned
   kernel, cmdline with `hostname=`, `ip=` (Firecracker static config) or DHCP (Apple
   vmnet).
4. **Boot**: PID 1 is vminitd (Apple) or the sadbox guest agent (Firecracker/CH).
   Guest agent mounts /proc /sys /dev, mounts the workdir disk at
   `/home/agent/work`, `chown -R agent`, installs the authorized_keys, sets
   hostname, brings up networking, syncs the clock, then reports **ready over vsock**.
5. **Start the session**: supervisor issues an exec over the control channel (vminitd
   gRPC on Apple; agent RPC on Linux): as user `agent`, `tmux new-session -d -s main
   -c ~/work`, then `tmux send-keys 'claude' Enter` (or launch claude directly as the
   tmux command). Only apps the user selected get launched/linked.
6. **Attach the UI**: web terminal bridges to `tmux attach -t main` via the control
   channel (vsock exec streaming pty) — or via SSH if enabled. Worker is live.

Target wall clock: step 2 dominates (rsync/cp of the workdir); steps 3–5 are
sub-second on Firecracker and ~1 s on Apple.

## In-guest init and plumbing

- **No systemd.** It buys nothing for a 3-process VM and costs boot time and image
  size. On Apple, the framework decides anyway: **vminitd** (Apple's Swift init) is
  PID 1 and exposes a gRPC API over vsock to configure the environment and spawn
  processes — sadbox drives it directly. On Firecracker/Cloud Hypervisor, ship a
  **single static guest-agent binary as PID 1** (Go or Rust, ~few MB) doing the
  vminitd-equivalent: mounts, hostname, network, clock, user session spawn, exec RPC
  over vsock, child reaping. OpenRC/tini are fallbacks, but a custom agent keeps one
  control protocol shape across backends.
- **User account**: baked into the image (`agent`, uid 1000, home `/home/agent`,
  passwordless sudo optional per policy). Never created at boot.
- **Workdir injection**: second block device (chosen above) beats the alternatives —
  a tar stream over vsock/SSH is simple but serializes the copy through the boot path;
  virtiofs is a *share*, not a *copy* (the product semantics are "copy"), and
  **Firecracker has no virtiofs**, so it can't be the common mechanism. The block
  device is instant to attach, size-capped, snapshottable, and works on all three
  backends. (On Apple, virtiofs remains available as an opt-in "live mount" feature
  later.)
- **DNS/hostname**: bake a sane `/etc/resolv.conf` pointing at the backend NAT
  resolver (Apple vmnet supplies DHCP/DNS; on Firecracker point at the host bridge IP
  and run a dnsmasq on the host, or just use public resolvers). Hostname from
  worker.json/cmdline.
- **Time sync**: vz guests track the host clock reasonably; Firecracker guests drift
  after host sleep and always after snapshot-restore. Have the agent set the clock at
  boot and expose a "resync" RPC (busybox `hwclock -s`/SNTP or chrony `makestep` if
  we ever need continuous discipline). Wrong clocks break TLS to the Anthropic API,
  so this is not optional.

## Networking

| | Apple Containerization | Firecracker | Cloud Hypervisor |
|---|---|---|---|
| Model | vmnet.framework NAT; DHCP per VM | one TAP per VM + host bridge/NAT (iptables) | same TAP model (virtio-net) |
| Guest IP | assigned by macOS DHCP on the vmnet network; host reaches guest directly by IP | supervisor allocates (e.g. /30 per worker or bridge subnet), passed via `ip=` cmdline | same, static via cmdline |
| Port mapping | optional `--publish`-style forwarding at the vmnet layer; usually unnecessary — direct IP works | host reaches guest IP over the bridge; DNAT only for external exposure | same |
| Control channel | **vsock** (vminitd gRPC) | **vsock** (virtio-vsock, Unix socket on host) | **vsock** (virtio-vsock) |

- The supervisor should treat **vsock as the primary control plane** (exec, pty
  streaming, health, file ops) on every backend — it works with networking disabled,
  which is also the story for a future "no-network sandbox" mode.
- **SSH is optional sugar**: sshd is baked but only started if the worker enables it;
  per-worker public key is injected via the workdir disk (step 2) — no
  `authorized_keys` templating in the image, no shared keys between workers.
- The web terminal never needs a guest port: it rides the vsock exec stream (or SSH).

## Key findings

1. The musl blockers are gone: Bun ships official arm64 musl builds and Claude Code
   officially supports Alpine 3.19+ with a signed apk repo — Alpine is viable, but
   glibc (Debian slim) is still the right default for an arbitrary-dev-toolchain
   sandbox because the npm/pip prebuilt-binary ecosystem remains glibc-first.
2. Claude Code is a native binary now (no Node runtime dependency) with apt/dnf/apk
   repos and a "stable" (~1 week lag) channel — ideal for baking; disable the
   auto-updater in guests and rebake nightly.
3. One Dockerfile can feed all three backends: Apple Containerization consumes OCI
   directly and converts layers to ext4 block devices natively on macOS
   (ContainerizationEXT4); Firecracker/CH take the same image flattened via
   `docker export` + `mkfs.ext4 -d` (no loop mounts). qcow2 is unnecessary — CH runs
   raw.
4. cloud-init is the wrong tool in microVMs (datasource + Python + seconds of boot
   work); the native pattern is kernel cmdline + a tiny vsock agent. Apple already
   ships that agent (vminitd, gRPC over vsock); sadbox needs a Linux twin of it.
5. Workdir-as-second-block-device is the only injection mechanism that is a true
   copy, fast, and portable across backends — Firecracker has no virtiofs, so
   virtiofs cannot be the common path.
6. Boot targets: Firecracker ≤125 ms to guest init (snapshot restores ~30 ms are a
   future option); Apple Containerization sub-second. Worker-create latency will be
   dominated by copying the workdir, not by the VM.
7. Kernels are pinned per backend, versioned separately from the rootfs (Apple: Kata
   family ≥6.14.9; Firecracker: 5.10/6.1 aarch64 configs; CH: standard Image, GICv3).

## Recommendation

- **Base image**: `debian:bookworm-slim` (arm64) + curl, git, tmux, openssh-server,
  ripgrep, ca-certificates, Bun (official installer), Claude Code (apt stable
  channel), baked `agent` user, baked sadbox guest agent. One fat image; per-worker
  app selection is a launch-time toggle. Alpine variant later if demanded.
- **Pipeline**: Dockerfile → OCI (buildx, linux/arm64) as the single source of truth;
  Apple backend consumes OCI directly; Linux backends flatten to raw ext4 via
  `docker export | mkfs.ext4 -d`. Nightly + on-demand rebakes; `DISABLE_AUTOUPDATER=1`
  in guest. Estimated rootfs ~1–1.5 GB uncompressed; per-worker workdir disk sparse
  16 GB default (node_modules routinely wants hundreds of MB to GBs).
- **Provisioning**: no cloud-init. Read-only shared rootfs + per-worker workdir ext4
  built on the host with config/keys inside; vsock control channel (vminitd on Apple,
  custom static PID-1 agent on Firecracker/CH); tmux session created via exec RPC;
  web terminal over the vsock pty stream; SSH opt-in.

## Open questions

- Reuse an existing Linux guest agent vs writing one: could Apple's vminitd itself be
  built/run under Firecracker (it's open source, Swift-on-Linux)? Would unify the
  control protocol (gRPC over vsock) across all backends — worth a spike.
- Root disk write layer on Linux backends: overlayfs-on-tmpfs vs reflink copy of the
  shared rootfs per worker (XFS/btrfs host) — measure both.
- Firecracker snapshot-based instant workers (~30 ms restores): huge UX win, but
  snapshot + clock-fixup + per-worker key injection interplay needs design.
- Does the Apple backend use the Containerization Swift package in-process (Swift
  supervisor or FFI) or shell out to the `container` CLI? Affects how much of the
  image/ext4 machinery we get for free. (Backend-choice doc owns this.)
- Image distribution: local OCI layout only, or run a local registry so the Apple
  framework and Linux flattener pull from the same place?
- Claude Code auth in the guest: credential injection (OAuth token / API key) is a
  provisioning input — belongs with the secrets design, but the workdir-disk config
  channel can carry it.

## Sources

- Apple Containerization (framework, vminitd, EXT4, kernel ≥6.14.9, macOS 26): https://github.com/apple/containerization
- Apple container CLI networking (vmnet NAT, per-VM IPs, --publish): https://github.com/apple/container/blob/main/docs/networking.md
- Anil Madhavapeddy, "Under the hood with Apple's Containerization": https://anil.recoil.org/notes/apple-containerisation
- Claude Code advanced setup (platforms incl. Alpine 3.19+, apt/dnf/apk repos, stable channel, musl deps, native binary, auto-updates): https://code.claude.com/docs/en/setup
- Bun installation (official musl x64/arm64 builds, glibc 2.17+): https://bun.com/docs/installation
- Bun musl support history: https://github.com/oven-sh/bun/issues/918
- Firecracker rootfs & kernel setup (Docker→ext4 flow, supported kernels): https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md
- Firecracker spec (≤125 ms boot): https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md
- Firecracker snapshots for ~28 ms sandbox starts: https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k
- Firecracker MMDS vs vsock provisioning patterns: https://www.pandastack.ai/blog/firecracker-mmds-metadata-service/
- Cloud Hypervisor README (raw images, virtio-{net,block,pmem,fs,vsock}, AArch64/GICv3, direct kernel boot): https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/README.md
- mkosi (alternative distro-native image builder): https://mkosi.systemd.io/
- Docker-build → mkfs.ext4 -d pipeline optimization discussion: https://github.com/vm0-ai/vm0/issues/7867
- Encore, "We rebuilt the Linux microVM stack on Apple Silicon": https://encore.dev/blog/firecracker-apple-silicon
- Apple container machine virtiofs mounts: https://github.com/apple/container/pull/1837
