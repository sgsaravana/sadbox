# 02 — Deployment portability: can sadbox be a docker-compose app?

Research date: 2026-09-15. Verified against current sources (see Sources). Host today: macOS 26
(Tahoe), Apple M1 Max, `kern.hv_support=1`.

## Context

sadbox is a supervisor that launches N microVM workers, each a sandbox for an AI coding agent
(copy of a local workdir, curl/bun/tmux/Claude Code installed, watched via tmux from a web UI).
The stated goal: "a docker-compose file for this app where I can run this anywhere — a different
mac, a linux server, an ec2 instance."

The short answer: **the control plane can be a compose app everywhere; the VM-launching part can
be a compose service only on Linux hosts with KVM.** On macOS — including this M1 Max — putting
the VM launcher inside Docker is not merely awkward, it is impossible on M1/M2 hardware and
unsupported-by-tooling even on M3+. The design should embrace a driver split rather than fight
this.

The one piece of genuinely good news from 2026: AWS turned on nested virtualization for
*virtual* EC2 instances (Intel 8th-gen only), so the "EC2 instance" leg of the goal no longer
requires expensive `.metal` boxes — with an architecture caveat discussed below.

## Per-platform reality check

### macOS (Apple Silicon)

Three facts stack up against "microVM manager in a container" on macOS:

1. **Every macOS container runtime runs containers inside a Linux VM** (Docker Desktop,
   OrbStack, colima/Lima, Rancher Desktop, even Apple's own `container` uses VM-per-container).
   A microVM manager in that container needs KVM *inside that Linux guest*, i.e. nested
   virtualization.
2. **Nested virtualization requires M3 or later + macOS 15+.** The M1 Max lacks the hardware
   feature entirely. This is a permanent "no" on this machine, not a software gap.
3. **Even on M3+/M4, mainstream tooling doesn't expose it.** Docker Desktop: open enhancement
   request since 2023, no response, no `/dev/kvm` (docker/desktop-feedback#314). OrbStack:
   unanswered discussion; docs still say "waiting on Apple". Only Lima/colima support
   `nestedVirtualization: true` (vz or krunkit vmType, M3+ only, silently ignored otherwise) —
   and the default guest kernels ship without `CONFIG_KVM`, so you must build a custom kernel.
   Workable for a hobby demo; not a deployment story to hand to users.

**Can a container instead call out to host Virtualization.framework?** No. Vz is a macOS
framework requiring the `com.apple.security.virtualization` entitlement in a *macOS process*;
a Linux container inside the Docker VM has no channel to it. The only pattern that works — and
the one everyone converges on (Encore's `cracklingd`, Tart runners, Apple's `container` with its
per-container helper) — is a **native macOS daemon** (launchd) that owns VM lifecycle, which a
portable control plane talks to over an API.

What *does* work natively on the M1 Max today: Virtualization.framework Linux VMs (fast, first-
class), Apple `container` 1.x (VM-per-container, macOS 26 needed for container-to-container
vmnet networking), vfkit/krunkit. So the *product* works fine on this Mac — just not inside
Docker. Caveats to note: Vz snapshot save/restore needs a private Apple entitlement (Encore hit
this — plan for cold boots, not snapshot restore, on macOS), and the 2-VM cap applies only to
*macOS* guests, not Linux guests.

### Linux server

This is the happy path, with well-worn patterns:

- **Firecracker/Cloud Hypervisor inside a container is established practice** (Kata Containers
  runs QEMU/CLH/Firecracker under containerd; fadams/firecracker-in-docker documents the minimal
  privilege set; E2B/Northflank/Fly-style platforms all do KVM-in-container variants).
- **Required container grants** — notably *not* `--privileged`:
  - `--device /dev/kvm` (host kernel must have KVM; user in `kvm` group or device cgroup rule)
  - `--device /dev/net/tun` (tap devices for guest networking)
  - `cap_add: [NET_ADMIN]` (create taps, NAT inside the container netns; `NET_RAW` is in
    Docker's default set). Everything else can be dropped; the process can run non-root.
- docker-compose expresses all of this directly (`devices:`, `cap_add:`), so **on Linux,
  `docker compose up` really can be the whole story**: control plane + a "host driver" service
  sharing `/dev/kvm`.
- Pitfalls to design around:
  - Firecracker's `jailer` wants to manage cgroups/chroot; in-container you typically skip it
    (the container *is* the jail) or run with cgroups disabled.
  - Firecracker has no virtio-fs; workdir injection means building an ext4/squashfs per worker
    or copying over vsock. Cloud Hypervisor has virtio-fs/virtio-pmem — friendlier for the
    "copy a local folder in" flow. Worth preferring **Cloud Hypervisor (or CH-via-Kata)** for
    sadbox's use case; both are Rust VMMs with near-identical container requirements.
  - Networking: taps + NAT live inside the driver container's netns; the web UI reaches workers
    via the driver's port-forwards. Keep the driver on the compose network, not `network_mode:
    host`, unless you need to expose per-VM IPs.
  - Host kernel must be a real KVM host: bare metal, or a VM with nested virt enabled (below).

### EC2 and other clouds

- **AWS, Feb/Mar 2026 — nested virt on virtual instances**: C8i/M8i/R8i (8th-gen *Intel* only;
  leverages VMCS shadowing), enabled via `CpuOptions` at launch / launch templates, KVM or
  Hyper-V as L1, Virtual Secure Mode auto-disabled, ~5–15% CPU overhead (more for I/O-bound).
  Rolled out from us-west-2 to all commercial regions. **No Graviton, no AMD.**
- **Graviton (arm64)**: still *no* nested virt on virtual instances as of mid-2026 (openly
  tracked; aws-samples issues wait on it). arm64 KVM on AWS = **Graviton `.metal`**
  (c7g.metal, c8g.metal-24xl/48xl). Firecracker fully supports arm64/Graviton (GICv3).
- **EC2 Mac**: mac2 (M1/M2) through M4/M4 Pro (GA Sep 2025) and M4 Max (GA Jan 2026). The
  M4-generation ones are M3+-class hardware, so the *native macOS* agent path even works in AWS.
  24-hour minimum allocation and dedicated-host pricing make this a niche option only.
- **GCP**: nested virt on x86 only (N1/N2/N2D/C2/C2D/M1/M2, N4D for AMD; E2 and *all ARM*
  excluded; KVM as the only L1). Axion **C4A-metal** gives bare-metal arm64 if arch parity
  matters. ≥10% overhead documented.
- **Azure**: nested virt since 2017 on many x86 sizes (v3+); Hyper-V officially, KVM works in
  practice; no ARM nested.
- **Hetzner**: Cloud VMs do **not** expose VT-x/AMD-V (verified: vmx disabled on CPX) — no
  nested virt at any tier. But **Hetzner dedicated (Robot) servers are cheap bare metal** and
  are arguably the best €/performance target for sadbox: full KVM, no overhead, ~€40–100/mo.

**Architecture-parity implication (opinionated):** your dev machine is arm64. If workers on EC2
run on C8i (x86_64), your guest rootfs, kernel, and every tool baked into the worker image
(bun, Claude Code binaries) must be built per-arch, and "it worked on my Mac" no longer implies
"works in prod". Either commit to multi-arch worker images from day one, or pick arm64
everywhere (Mac native + Graviton metal + Hetzner RX/Ampere line) and keep one image.

## Docker-compose feasibility analysis

| Component | In compose on Linux? | In compose on macOS? |
|---|---|---|
| Web UI / API / state (control plane) | Yes, trivially | Yes, trivially |
| VM driver (KVM) | **Yes** — `devices: [/dev/kvm, /dev/net/tun]`, `cap_add: [NET_ADMIN]` | **No** — impossible on M1/M2; unsupported by Docker Desktop/OrbStack even on M3+ |
| VM driver (Virtualization.framework) | n/a | **No** — must be a native macOS process |

So "one compose file that runs anywhere" is achievable only by narrowing what the compose file
contains. Two honest framings:

1. **Compose = full app** on any Linux host with KVM (bare metal, EC2 8i-family, GCP N2,
   Azure v3+, Hetzner dedicated). This is real and worth shipping.
2. **Compose = control plane only** on macOS, paired with a native agent. Frankly, if the
   control plane is a single static binary, requiring Docker Desktop on a Mac *just* to run the
   control plane is worse UX than `brew install sadbox && sadbox serve`.

## Candidate architectures

### A. Single binary everywhere; compose is Linux packaging (recommended)

One binary, `sadbox`, containing web UI (embedded assets), API, state (SQLite), and a **driver
interface** with two implementations:

- `driver/kvm` (Linux): shells out to / links Cloud Hypervisor or Firecracker. Needs
  `/dev/kvm`, `/dev/net/tun`, `CAP_NET_ADMIN` — whether it's running on the host or in a
  container is irrelevant to the code.
- `driver/vz` (macOS): Virtualization.framework via a small Swift/objc shim or by driving
  Apple's `container`/`vfkit`. Runs under launchd.

Distribution: `brew install` on macOS; on Linux, a compose file whose single meaningful service
is the sadbox image with the device/cap grants (plus optional Postgres/Caddy if wanted). The
compose goal is met on every platform where compose can meet it; macOS gets something better
than compose, not a broken approximation of it.

### B. Split control plane + remote host agents

Control plane runs anywhere (compose, a cheap VPS, even Fly) and speaks a driver API (gRPC/HTTP
+ auth) to one or more **host agents**: native launchd binary on Macs, container or systemd unit
on Linux boxes. This is Encore's crackling shape and scales to "my Mac + a Hetzner box + an EC2
instance as one fleet".

Verdict: this is the *eventual* shape, and A degenerates into it cleanly if the driver interface
is defined over a socket from day one (in-process transport locally, TCP later). Don't build the
multi-host fleet first; build A with the driver behind an interface.

### C. Everything in Docker, everywhere (rejected)

Requires nested virt inside Docker Desktop/OrbStack on macOS: impossible on the M1 Max, custom-
kernel-Lima-only on M3+, double-virtualization overhead, and you inherit Docker Desktop as a
hard dependency. Rejected; revisit only if Docker Desktop ships nested-virt support.

**Recommendation: A now, with B's socket-shaped driver interface so multi-host comes free.**
Prefer Cloud Hypervisor over Firecracker on Linux for virtio-fs (workdir injection); pick one
guest-image toolchain that produces arm64 *and* x86_64 rootfs from the start.

## Deployment matrix

| Target | MicroVMs in Docker? | Recommended deployment | Notes |
|---|---|---|---|
| This M1 Max (macOS 26) | **Impossible** (no nested-virt hardware) | Native `sadbox` binary, `driver/vz` (Vz / Apple `container`), launchd | Works today; no snapshot/restore (private entitlement); Linux guests unlimited |
| M3/M4 Mac, macOS 15+ | Possible via Lima `nestedVirtualization: true` + custom KVM kernel — awkward, unsupported by Docker Desktop/OrbStack | Same native path as M1 | Don't ship the Lima hack to users |
| Linux bare metal (Hetzner dedicated, home server) | **Yes — first-class** | `docker compose up` (driver container: `/dev/kvm`, `/dev/net/tun`, `NET_ADMIN`) or plain binary + systemd | Best perf/€; the canonical compose target |
| EC2 C8i/M8i/R8i (x86, Feb 2026+) | Yes (enable nested virt via `CpuOptions`) | compose, same file as bare metal | 5–15% overhead; x86 workers → need multi-arch images |
| EC2 Graviton virtual (c8g etc.) | **Impossible** (no nested virt on Graviton yet) | — | Watch AWS announcements |
| EC2 Graviton `.metal` (c8g.metal-24xl) | Yes | compose | arm64 parity with the Mac; pricey |
| GCP N2/C2 (x86) / Azure v3+ (x86) | Yes (enable nested virt) | compose | ≥10% overhead (GCP documented) |
| GCP C4A-metal (arm64 Axion) | Yes | compose | arm64 bare metal alternative |
| Hetzner *Cloud* VMs | **Impossible** (VT-x not exposed) | control plane only, if anything | Use their dedicated line instead |
| EC2 Mac M4/M4 Max | n/a (macOS host) | native macOS agent | 24h minimum, dedicated host pricing — niche |

## Open questions

1. **Firecracker vs Cloud Hypervisor vs Kata for `driver/kvm`** — CH's virtio-fs simplifies
   workdir injection; Firecracker has the smaller attack surface and snapshotting. Needs a
   prototype (separate research topic).
2. **Guest image pipeline** — one OCI-image → rootfs flow that runs on macOS (no loop mounts;
   Encore solved this in userspace Rust) and in the Linux driver container, emitting both archs.
3. **Driver API surface** — what exactly crosses the socket (create/destroy, vsock console/tmux
   attach, file push/pull, metrics) so drivers stay thin.
4. **macOS worker parity** — Vz gives full VMs but no snapshot restore; is cold-boot-to-Claude
   fast enough (<2–3 s is achievable per Encore/Apple `container` data)?
5. **Does OrbStack/Docker Desktop ship nested virt in 2026–27?** Low signal today; if it lands,
   Architecture C becomes viable for M3+ Macs and this doc should be revisited.
6. **Multi-tenant hardening on Linux** — jailer-equivalent inside the driver container
   (seccomp, cgroup v2 per VM) before exposing sadbox on shared hosts.

## Sources

- https://github.com/fadams/firecracker-in-docker — unprivileged Firecracker-in-Docker: /dev/kvm, /dev/net/tun, CAP_NET_ADMIN only
- https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md — KVM access requirements
- https://katacontainers.io/ and https://github.com/kata-containers/kata-containers/blob/main/docs/hypervisors.md — QEMU/CLH/Firecracker under container runtimes; /dev/kvm requirement
- https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual — AWS nested virt on C8i/M8i/R8i, all commercial regions
- https://sjramblings.io/aws-ec2-nested-virtualization-finally/ — CpuOptions enablement, Intel-only, VMCS shadowing, 5–15% overhead, no Graviton/AMD
- https://www.infoq.com/news/2026/03/aws-ec2-nested-virtualization/ — announcement coverage
- https://github.com/aws-samples/sample-multi-tenant-openclaw-on-firecracker/issues/19 — Graviton nested virt still unavailable (tracked May 2026)
- https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview — GCP: x86-only, KVM L1 only, ARM excluded, ≥10% overhead
- https://cloud.google.com/blog/products/compute/new-axion-c4a-metal-offers-bare-metal-performance-on-arm — arm64 bare metal on GCP
- https://learn.microsoft.com/en-us/answers/questions/1404819/azure-vm-nested-virtualization-dsv4-series — Azure nested virt status
- https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/ — Hetzner Cloud: no nested virt, VT-x disabled on CPX
- https://github.com/docker/desktop-feedback/issues/314 — Docker Desktop Mac: nested virt/KVM open request, no response
- https://github.com/orgs/orbstack/discussions/2074 and https://github.com/orbstack/orbstack/issues/1504 — OrbStack nested virt: unanswered, "wait for Apple"
- https://github.com/lima-vm/lima/issues/4498 and https://github.com/lima-vm/lima/issues/5419 — Lima `nestedVirtualization` (vz/krunkit, M3+ only), custom kernel needed
- https://encore.dev/blog/firecracker-apple-silicon — crackling: Firecracker on Linux + Vz on macOS behind one API; Vz snapshot entitlement blocked; /dev/kvm in Linux VM only on M3+/macOS 15
- https://github.com/apple/container/releases/tag/1.0.0 and https://github.com/apple/container/releases/tag/1.1.0 — Apple `container` 1.x; macOS 26 needed for vmnet container networking
- https://thenewstack.io/apple-containers-on-macos-a-technical-comparison-with-docker/ — VM-per-container architecture
- https://aws.amazon.com/blogs/aws/announcing-amazon-ec2-m4-and-m4-pro-mac-instances/ and https://aws.amazon.com/about-aws/whats-new/2026/01/amazon-ec2-m4-max-mac-instances-ga — EC2 Mac M4 generation
- https://blog.alexellis.io/how-to-run-firecracker-without-kvm-on-regular-cloud-vms/ — context on the no-KVM fallback (emulation; not viable for sadbox perf)
