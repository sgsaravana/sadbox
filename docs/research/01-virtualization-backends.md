# 01 — Virtualization / microVM backend options for sadbox

*Research date: 2026-09-15. All project states verified against live sources (see Sources). Versions and dates are "as of mid-September 2026".*

## Context

sadbox is a supervisor that deploys N microVM "workers" on a host. Each worker gets a copy of a
local folder ("workdir") in its home dir, a toolchain installed (curl, bun, tmux, Claude Code),
and runs Claude Code inside, observed via tmux through a web UI. Workers are therefore
**long-lived, stateful, interactive VMs** — not ephemeral function sandboxes. That distinction
drives most of the conclusions below.

Host today: macOS 26 (Tahoe) on Apple M1 Max (arm64), `kern.hv_support=1`. Important hardware
constraint: **M1/M2 lack nested virtualization** (Virtualization.framework exposes it only on
M3+ with macOS 15+). So on this machine, nothing running *inside* a Linux VM (e.g. Docker
Desktop's VM) can use KVM — a docker-compose-packaged supervisor on this Mac must drive
virtualization at the *host* level, not inside its own container. Linux servers / EC2 metal are
the opposite: KVM is right there, and the macOS frameworks are absent. Hence: swappable backends
behind one driver interface.

## Landscape

### macOS options

#### 1. Apple Containerization framework + `container` CLI — the headline option

Open-sourced at WWDC25; `container` hit **1.0 in June 2026** (one year after announcement) and is
at **1.4.x as of September 2026** — a fast release cadence (recent releases added `container cp`,
`container export`, SSH agent forwarding for builds, a turnkey local Kubernetes plugin, and a
`container clean` command). Apache-2.0, written in Swift, Apple-silicon-only.

Architecture — exactly the sadbox model:

- **One lightweight VM per container** on Virtualization.framework. Sub-second boot via an
  optimized kernel (the Kata Containers guest kernel by default; **user-supplied kernels are
  supported per-container**, tested from 6.14.9+).
- **`vminitd`**: a static-Swift init/agent inside each VM exposing a **gRPC API over vsock** —
  process spawn, signals, stdio streaming, runtime config. This is precisely the exec plumbing a
  supervisor needs, already built and maintained by Apple.
- **Filesystem**: container rootfs is a real **EXT4 block device** (fast, persistent — the
  writable filesystem survives `container stop` / `container start`); **virtiofs** for bind
  mounts and named volumes; `container cp` for host↔guest transfer.
- **Networking**: on macOS 26, each container gets its **own IP on a vmnet network**, containers
  can reach each other, and the host can reach containers directly — no port-mapping needed.
  (macOS 15 is severely degraded: isolated containers, no `container network` — another reason
  sadbox should require macOS 26.)
- **Daemonless-ish**: a launchd `container-apiserver` plus per-container `container-runtime-linux`
  XPC helpers; the CLI is a thin client. OCI images pulled from any registry.
- Known rough edge: **memory ballooning is only partial** — memory freed in a container doesn't
  reliably return to the host. Matters for a large long-lived fleet; size worker RAM modestly.
- Notable for our future: the Containerization README states the framework also runs on **Linux,
  using cloud-hypervisor as the VMM** with TAP networking — Apple's own portability story points
  at Cloud Hypervisor.

Pros: purpose-built for "many small Linux VMs on a Mac", OS-vendor-maintained, OCI-native, fast
boot, vsock exec API for free, persistent rootfs, per-container IPs. Cons: macOS 26 + Apple
silicon only; Swift API (non-Swift supervisors drive the CLI); no VM snapshots; partial balloon.

#### 2. Raw Virtualization.framework (Swift) / Code-Hex `vz` Go bindings

The substrate under everything else here. Full control: virtio-blk/net/fs/vsock/balloon/rng,
Rosetta for amd64 binaries, NAT via vmnet. Needs the `com.apple.security.virtualization`
entitlement (any developer can self-sign). `Code-Hex/vz` (MIT) is the de-facto Go binding —
briefly stale enough in 2025 that the Lima org forked it as `lima-vm/vz/v4`, then **cancelled the
fork when upstream revived**; it's active again but effectively one-maintainer.

The catch, proven in the field by Encore's "Crackling" project: going raw means rebuilding the
whole stack yourself — OCI image → ext4 conversion, kernel/initramfs handling, a guest agent, an
exec/copy/port-forward protocol over vsock, single-threaded dispatch-queue discipline around VM
objects. That is months of work Apple's framework already does. Also: **`saveMachineStateToURL`
(VM suspend/resume, macOS 14+) is a trap** — `validateSaveRestoreSupport` reports success but
saving fails with `VZErrorInternal` for third parties (reported as requiring the private
`com.apple.private.virtualization` entitlement; Tart's Linux-guest suspend fails similarly).
Treat **VM-state snapshotting as unavailable on macOS**; disk-level snapshots via APFS
copy-on-write clones are the realistic substitute.

Verdict: the right layer only if the framework's opinions block us. They don't (yet).

#### 3. Lima — v2.0, CNCF Incubating, now explicitly an AI-agent sandbox

Lima v2.0 (Nov 2025) added a **plugin infrastructure** (gRPC VM-driver plugins: vz, QEMU,
krunkit-with-GPU, WSL2) and its FOSDEM 2026 talk is literally titled *"expanding the focus to
hardening AI"* — sandboxing AI agents so they can't touch host files is now a stated goal.
CNCF Incubating (promoted late 2025), Apache-2.0, very healthy community. virtiofs on vz/krunkit,
automatic port forwarding, ssh-based `limactl shell`, cloud-image based full distros, templates,
also runs on Linux hosts (QEMU driver).

Pros: mature, portable macOS+Linux, great defaults. Cons: it's a **"handful of pet VMs" tool, not
a fleet API** — instance-per-YAML, full distro boots in tens of seconds, driven by a CLI meant
for humans. Wrapping `limactl` as a many-worker fleet driver is fighting its grain. Great as
design reference (its guest-agent + hostagent + eBPF port-watcher architecture), wrong as backend.

#### 4. Tart (now under OpenAI)

Cirrus Labs **joined OpenAI's agent-infrastructure team in April 2026**; Tart/Orchard moved to
the `openai/` GitHub org, relicensed **FSL-1.1-ALv2** (source-available; converts to Apache-2.0
after two years), licensing fees dropped; Cirrus CI shut down June 2026. Strong validation that
"VMs on Apple silicon for agents" is the right idea — and a warning: MacStadium notes there is no
committed public maintenance team now. Tart is CLI-only (no daemon API), full-VM oriented (incl.
macOS guests), image distribution via OCI registries, APFS-clone instant duplication. Suspend
works for macOS guests but **fails for Linux guests** (Virtualization.framework limitation above).
Wrong shape for many-small-Linux-workers; right shape for CI macOS VMs, which we don't need.

#### 5. libkrun / krunkit

`containers/libkrun` (Apache-2.0): a **C library VMM** — KVM on Linux, HVF on macOS/arm64 —
booting a bundled stripped kernel (`libkrunfw`) directly into a process-like VM. virtio-fs,
vsock, balloon, GPU (venus/Vulkan — its killer feature), TSI "transparent socket impersonation"
networking. `krunkit` wraps it with a vfkit-compatible RESTful API and is now the **default
Podman machine provider on macOS/arm64**; Lima has a krunkit driver. Momentum is real (Red Hat),
but 2026 issue traffic shows rough edges on macOS (dyld/homebrew dylib breakage on macOS 26.x
point releases, bind-mount permission quirks vs applehv). No OCI/image layer of its own, no
snapshots. A credible plan-B substrate, especially if workers ever want GPU; not the primary.

#### 6. QEMU with HVF

QEMU 10.x runs fine HVF-accelerated on arm64 Macs (GPL-2.0). But for this use case it's the worst
fit on macOS: the `microvm` machine type is **x86-only** (arm64 uses `virt`), **no vsock on a
macOS host** (vhost-vsock needs a Linux kernel), **no virtiofs on a macOS host** (virtiofsd is
Linux-only; you fall back to 9p), slower boot, huge device surface. Unique strengths — cross-arch
emulation and mature disk snapshots (qcow2/savevm) — aren't what workers need. Skip on macOS.

*(Honorable mention: `vfkit` (crc-org, Apache-2.0) — a REST-API CLI over Virtualization.framework
used by Podman's applehv; a lighter raw-vz wrapper if we ever need one.)*

### Linux options (future portable backend)

#### 1. Firecracker

v1.17.x (September 2026), Apache-2.0, AWS, Rust, KVM x86_64+aarch64. ~125ms boot, <5MiB VMM
overhead, REST API over Unix socket + Go SDK + `firecracker-containerd`. **Snapshots are mature**
(incl. arm64, versioned snapshot format, diff snapshots) — the best resume-a-warm-worker story
anywhere. Deliberately minimal: **no virtiofs — explicitly rejected** (block devices only, so
workdir delivery means building ext4 images or streaming files through a vsock agent), no GPU,
TAP-only networking. Battle-tested at absurd scale (Lambda/Fargate) and the substrate of the AI
sandbox industry (E2B, Vercel Sandbox, Bedrock AgentCore).

#### 2. Cloud Hypervisor

v53.0 (July 2026), Apache-2.0 + BSD-3-Clause, Linux Foundation (Intel/Microsoft/ARM/Alibaba),
Rust/rust-vmm, KVM + MSHV, x86_64 + aarch64. REST API + `ch-remote`. Everything Firecracker
refuses, while staying small: **virtiofs (external virtiofsd), vsock, snapshot/restore** (v53
added an offloaded snapshot daemon and userfaultfd background prefault), hotplug, VFIO/GPU
passthrough, live migration. ~150-300ms boots. And — the kicker — it's the VMM Apple's
Containerization framework itself uses on Linux, and a first-class Kata backend.

#### 3. QEMU `microvm` machine type

Minimal PCI-less/ACPI-less QEMU machine — but **x86_64-only**; arm64 means standard `virt`.
Full QMP API, virtiofs, vhost-vsock, snapshots. GPL-2.0. Fine as an escape hatch; carries QEMU's
attack surface and ops weight. Not a primary.

#### 4. crosvm

Google's ChromeOS VMM (BSD-3-Clause), the ancestor of Firecracker's design; actively maintained,
GPU/Wayland passthrough. But it's built for ChromeOS's integration, with little standalone-server
ecosystem, docs, or API stability story. Not recommended outside ChromeOS.

#### 5. Kata Containers

OpenInfra, Apache-2.0, active (runtime-rs, regular CVE-driven guest kernel bumps). Not a VMM — an
**OCI runtime** putting each container in a microVM (QEMU default; Cloud Hypervisor, Firecracker,
StratoVirt selectable), pluggable into containerd/Docker/K8s. Adds ~150-300ms over the VMM.
Strategic relevance: on a Linux host, `docker run --runtime io.containerd.kata.v2` gives sadbox
VM-isolated workers **through the ordinary Docker API** — the least new code of any Linux path.

## Comparison table

| Backend | Host | Boot | Programmatic control | Guest image | arm64 | vsock | virtiofs | Snapshots | Networking | Maturity (late 2026) | License |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apple `container`/Containerization | macOS 26 (AS) | <1s | CLI + Swift API; vminitd gRPC/vsock | OCI → ext4 | Yes (native; Rosetta for amd64) | Yes (core mechanism) | Yes | No (disk: APFS clones) | vmnet, IP per container | 1.4.x, fast cadence, Apple-backed | Apache-2.0 |
| Raw Virtualization.fwk / vz | macOS 11+ (AS) | ~1-3s (direct kernel) | Swift/ObjC API; Go via Code-Hex/vz | DIY (raw disk + kernel) | Yes | Yes (VZVirtioSocketDevice) | Yes | API exists, blocked by private entitlement | NAT/bridged vmnet | Stable API; vz binding ~1 maintainer | Apple SDK / MIT (vz) |
| Lima v2 | macOS + Linux | 10-30s (distro) | `limactl` CLI, YAML, driver plugins | Cloud images (qcow2/raw) | Yes | via vz | Yes (vz/krunkit) | Experimental save-on-stop | ssh + auto port-fwd (eBPF watcher) | CNCF Incubating, v2.0, AI-sandbox focus | Apache-2.0 |
| Tart | macOS (AS) | 10-30s | CLI only (+Orchard) | Own VM images via OCI registries | Yes | No API exposed | Yes | Suspend: macOS guests only; APFS clones | NAT/bridged | OpenAI-owned, maintenance uncertain | FSL-1.1-ALv2 |
| libkrun/krunkit | macOS (AS) + Linux | <200ms-1s | C API / krunkit REST | rootfs dir/disk (BYO) | Yes | Yes | Yes | No | TSI / gvproxy | Podman-default on macOS; rough edges | Apache-2.0 |
| QEMU + HVF | macOS | 2-10s | QMP | qcow2/raw | Yes (`virt`) | **No (macOS host)** | **No (macOS host; 9p)** | qcow2/savevm | user/vmnet | Mature, wrong fit | GPL-2.0 |
| Firecracker | Linux KVM | ~125ms | REST/Unix socket, Go SDK | ext4 block + kernel | Yes | Yes (hybrid) | **No (rejected)** | **Yes, mature incl. arm64** | TAP | v1.17, hyperscale-proven | Apache-2.0 |
| Cloud Hypervisor | Linux KVM/MSHV | ~150-300ms | REST + ch-remote | raw/qcow2 + kernel or fw | Yes | Yes | Yes (virtiofsd) | Yes (v53: offloaded + prefault) | TAP, VFIO | v53, LF-governed, broad backers | Apache-2.0/BSD-3 |
| QEMU microvm | Linux KVM | ~0.5-1s | QMP | any | machine type x86-only | Yes (vhost) | Yes | Yes | TAP/user | Mature niche | GPL-2.0 |
| crosvm | Linux KVM | fast | CLI/control socket | DIY | Yes | Yes | Yes | Limited | TAP | ChromeOS-internal focus | BSD-3 |
| Kata Containers | Linux KVM | VMM +150-300ms | containerd/Docker/CRI | OCI | Yes | Yes | Yes | Via VMM/agent | CNI | OpenInfra, active | Apache-2.0 |

## Key findings

1. **Apple's Containerization model is the sadbox model.** VM-per-container, vsock gRPC agent,
   ext4 writable rootfs that persists across stop/start, virtiofs mounts, per-container IPs on
   macOS 26, sub-second boot, OCI images, custom-kernel support. Everything a worker needs
   (persistent home, tmux, `container exec -it` for attach, multiple long-lived processes under
   vminitd) is supported today in `container` 1.4.x. Building the same on raw
   Virtualization.framework is a multi-month re-implementation — Encore's Crackling write-up is
   the documented cost of that road.
2. **VM-state snapshot/suspend is effectively unusable on macOS** for third parties
   (`saveMachineStateToURL` gated by a private entitlement; Linux-guest suspend broken even in
   Tart). Plan for disk-level checkpoints (APFS clones / `container export`) and fast cold boots
   instead of memory snapshots on macOS. On Linux, Firecracker/CH give real snapshots later.
3. **The industry converged on this pattern in 2026.** OpenAI bought Cirrus Labs (Tart) for agent
   infra; Lima v2 pivoted to "hardening AI"; E2B/Vercel/Bedrock run agent sandboxes on
   Firecracker. Isolating coding agents in microVMs is mainstream, and the building blocks are
   liquid.
4. **Firecracker vs Cloud Hypervisor splits on our workload.** Firecracker: unmatched snapshots
   and scale, but no virtiofs and a block-image-only workflow — fine for ephemeral function
   sandboxes, friction for long-lived dev workers. Cloud Hypervisor: virtiofs + vsock + snapshots
   + arm64, REST-controlled, and it's what Apple's own framework uses on Linux — the natural
   sibling backend.
5. **Nested-virt reality check:** on M1/M2 hosts the supervisor container cannot itself host
   microVMs; the macOS driver must call the host's `container-apiserver` from inside
   docker-compose (socket/API bridging), or the supervisor runs natively on macOS. On Linux/EC2
   the driver needs `/dev/kvm` (bare-metal instances for arm64). This asymmetry is exactly why
   the driver abstraction must exist from day one.
6. **QEMU-on-macOS lacks both vsock and virtiofs** (Linux-host-only backends), which quietly
   kills it for this design despite HVF working fine.

## Recommendation for sadbox

**macOS now: Apple's `container` CLI (Containerization framework) as the primary backend.**
Require macOS 26 + Apple silicon. Drive it as a subprocess/CLI integration (works from any
supervisor language); if the supervisor ends up in Swift, link the framework directly and talk to
vminitd's gRPC ourselves. Worker recipe: OCI image with tmux/bun/curl/Claude Code baked in;
workdir seeded via `container cp` (a *copy*, per spec — reserve virtiofs mounts for opt-in live
sharing); worker home lives on the container's persistent ext4 rootfs or a named volume;
interactive access via `container exec -it` (tmux attach) bridged to the web UI over a PTY;
workers reachable by per-container IP for anything HTTP/ssh. Do not adopt Lima/Tart as the
backend; do not drop to raw vz unless a concrete framework limitation forces it (the framework is
Apache-2.0 — we can also fork/extend).

**Linux later: Cloud Hypervisor as the primary microVM backend**, with the same OCI-image →
ext4 pipeline (Containerization's tooling or our own), virtiofs for shares, vsock for the agent.
Keep **Kata Containers as the pragmatic fast-path**: on a generic Linux server with containerd,
"worker = Kata container" delivers VM isolation through the Docker API with minimal new code —
acceptable first Linux milestone, with the native CH driver as the endgame. Choose Firecracker
instead only if the roadmap shifts toward huge fleets of ephemeral snapshot-restored workers.

**Abstraction boundary: a `WorkerDriver` interface, defined now, with capability flags.**
Modeled on what Encore's Crackling proved out (one guest protocol, N hypervisors):

```
interface WorkerDriver {
  create(spec: WorkerSpec): WorkerId      // image, cpus, memMB, seed files
  destroy(id); start(id); stop(id)
  status(id): WorkerStatus; list(): WorkerInfo[]; events(): Stream
  exec(id, argv, opts {pty, env, cwd}): ExecSession   // streaming stdio+resize — the tmux pipe
  copyIn(id, hostPath, guestPath); copyOut(id, guestPath, hostPath)
  address(id): IpAddr | null              // preferred: routable worker IP
  forwardPort(id, guestPort): HostEndpoint // fallback where no routable IP
  capabilities(): {snapshot?, sharedMount?, gpu?, routableIp?}
  snapshot(id)/restore(ref)               // optional capability
}
```

Design rules: exec is a **streaming PTY primitive** (everything interactive, including tmux
attach and running sshd-less shells, flows through it); networking is **"give me an address"**
first, port-forward second; images are **OCI everywhere**; snapshots are optional-capability, so
macOS (no) and Linux (yes) don't fork the core; the supervisor never assumes it shares a kernel —
or even a machine — with the backend (macOS driver may proxy to a host-level API from inside a
container).

## Open questions

1. Can the supervisor use Apple's Containerization **Swift framework's Linux port** (cloud-
   hypervisor backend) to get one codepath on both platforms? Maturity of that Linux support is
   unverified — prototype it.
2. Driving `container` CLI vs talking to `container-apiserver`'s XPC directly from a non-Swift
   supervisor: is CLI JSON output stable enough to be an API? (Check `--format json` coverage per
   subcommand.)
3. Memory-ballooning gap: measure real host-RAM behavior with 5-10 idle workers on 1.4.x; decide
   default worker RAM and whether stop-idle-workers policy is needed.
4. Workdir seeding at scale: `container cp` of a big node_modules-laden workdir vs mounting a
   virtiofs snapshot vs baking a per-job ext4 volume — benchmark.
5. Does `container` survive macOS point updates gracefully (krunkit's dylib breakage is a cautionary
   tale)? Pin versions; test upgrades.
6. For docker-compose packaging on macOS: exact mechanism for reaching the host's
   `container-apiserver` from inside the compose stack (Unix-socket mount? TCP shim?) — owned by
   the deployment research, but the driver API must allow a remote transport.
7. Tart/Orchard's FSL license and uncertain stewardship rule it out today — revisit only if the
   FSL→Apache conversion plus community maintenance materialize.

## Sources

- https://github.com/apple/container — repo, README
- https://github.com/apple/container/releases — 1.0 → 1.4.1 release trail
- https://github.com/apple/container/blob/main/docs/technical-overview.md — per-container VMs, vmnet, macOS 15 vs 26, balloon caveat
- https://github.com/apple/containerization — framework APIs, vminitd gRPC/vsock, ext4 tooling, custom kernels, Linux/cloud-hypervisor note
- https://thenewstack.io/apple-containers-on-macos-a-technical-comparison-with-docker/
- https://anil.recoil.org/notes/apple-containerisation — architecture deep dive
- https://encore.dev/blog/firecracker-apple-silicon — Crackling: MachineBackend abstraction, vz threading, saveMachineStateToURL entitlement trap
- https://github.com/Code-Hex/vz and https://github.com/lima-vm/vz — Go bindings status, cancelled fork
- https://archive.fosdem.org/2026/events/attachments/RGCTDY-lima/slides/266976/lima_yjbsxrd.pdf — Lima v2.0, CNCF Incubating, "hardening AI", driver plugins
- https://lima-vm.io/docs/config/vmtype/ and https://lima-vm.io/docs/config/vmtype/krunkit/ — drivers, virtiofs
- https://macstadium.com/blog/cirrus-labs-is-joining-openai — Tart/Orchard fate, Cirrus CI shutdown
- https://github.com/openai/tart — new org, FSL-1.1-ALv2 releases
- https://github.com/cirruslabs/tart/issues/803 — Linux-guest suspend failure
- https://github.com/containers/libkrun — features, license, consumers
- https://github.com/containers/podman/issues/24559 and podman issue #28958 / discussion #27679 — krunkit rough edges
- https://github.com/firecracker-microvm/firecracker/releases — v1.16/v1.17 (2026)
- https://github.com/firecracker-microvm/firecracker/issues/1180 — virtiofs/host-FS-sharing rejection
- https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md — arm64 snapshot support
- https://www.cloudhypervisor.org/blog/cloud-hypervisor-v53.0-released/ — v53 snapshot daemon, arm64
- https://www.qemu.org/docs/master/system/i386/microvm.html — microvm machine (x86)
- https://emirb.github.io/blog/microvm-2026/ — 2026 microVM isolation landscape, AI-sandbox patterns
- https://github.com/kata-containers/kata-containers/releases — active 2026 cadence
