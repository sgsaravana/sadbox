# 14 — Running sadbox on an Intel Mac

> **Status: built 2026-11-11** — `src/driver/vz/` (vfkit over Virtualization.framework), the
> driver selection, `setup`/`doctor`, `install.sh`/Homebrew and the README. Tested with a stand-in
> VMM (`test/fake-vfkit.ts`) and against real VMs on Apple silicon; the Intel amd64 pair
> (Debian `vmlinuz` + amd64 disk) still needs a run on Intel hardware. See "As built" below.
> Research verdict, 2026-11-11: **possible, and smaller than expected** — but it is a
> *third driver*, not a port of either existing one. The natural backend is
> **`vfkit` over Apple's Virtualization.framework**, which supports Intel hosts and gives us the
> same vsock + virtio-fs primitives the KVM driver already speaks. A zero-code workaround also
> exists (run the Linux backend elsewhere; use the Intel Mac as the browser).

## The question

Can sadbox run **on** an Intel Mac, making its project microVMs locally? (Not: can an Intel Mac
open the web UI.)

## Why nothing works today

Three independent blockers, and they are all real:

1. **`container` is Apple-silicon only.** Apple's README: *"You need a Mac with Apple silicon to
   run `container`"*, macOS 26 only — and macOS 26 runs on just four Intel models (MacBook Pro
   16″ 2019, MacBook Pro 13″ 2020 4×TB3, iMac 2020, Mac Pro 2019). There is no Intel build and no
   upstream plan for one. That is the whole macOS driver.
2. **The KVM driver needs Linux.** `src/driver/kvm/vmm.ts` checks `process.platform === "linux"`
   and `/dev/kvm`; Cloud Hypervisor has no macOS port (KVM/MSHV only).
3. **Docker can't help on a Mac.** A container on macOS cannot reach the host hypervisor, so
   "run the Linux image in Docker" doesn't give KVM — the same conclusion as
   [02-deployment-portability.md](02-deployment-portability.md). Neither does running a Linux VM
   and putting KVM inside it: Virtualization.framework documents nested virtualization for
   **M3 and later** only, and the Intel story depends on third-party hypervisors exposing VT-x
   (Parallels/VMware). That is two layers of virtualization on an already-old machine; not a path
   to recommend.

## What an Intel Mac does have

The important finding: **Virtualization.framework itself is not Apple-silicon only.**

- Apple documents it for *"Apple silicon and Intel-based Mac computers"*, and
  *"Design and run custom Linux guests on Apple silicon or Intel-based Mac computers."*
  On Intel the guest must be x86_64, accelerated by HVF — native, not emulated.
- **`vfkit`** (crc-org, Apache-2.0, v0.6.4, 2026-07) is a CLI over that framework — the same layer
  Podman's `applehv`/CRC/minikube use. Its supported platforms list **"Intel x86_64"**, and its CI
  runs virtualization tests on **`macos-26-intel`** runners. One 66 MB universal, signed
  (`com.apple.security.virtualization`) binary per release.
- Devices it exposes, all of which we need: **virtio-blk** (raw disk), **virtio-vsock** (one host
  unix socket per port), **virtio-fs** (shares), **virtio-serial** (console → log file), rng,
  balloon. No networking is required — the sadbox VM is deliberately network-less.
- It boots a Linux kernel directly (`--bootloader linux,kernel=…,initrd=…,cmdline=…`) plus a raw
  disk image, i.e. exactly the KVM driver's `disk.ext4` + kernel model.

And the kernel: the Cloud Hypervisor Linux tag sadbox pins
(`ch-release-v7.2.8-20261009`) ships **`bzImage-x86_64`** (8.8 MB) and an arm64 `Image`. It looked
like a free win — virtio-pci, virtio-blk, ext4, virtio-console (`hvc0`), virtio-fs and vsock built
in — but **VZ refuses the arm64 Image before the guest runs** (tested 2026-11-11: `VZErrorDomain
Code=1`, "the virtual machine failed to start"; an empty initramfs and the same disk boot fine with
Apple's Kata kernel). So the vz driver builds **Debian's kernel** locally with Docker
(`images/kernel`), for the host's architecture, with the virtio and vsock modules in the initramfs.
That also means no big kernel download at setup.

## Options, and why they lose

| Option | Verdict | Why |
|---|---|---|
| Apple `container` / Containerization on Intel | ❌ | Apple-silicon only, macOS 26 only, no upstream Intel plan. |
| Build Containerization for x86_64/Intel | ❌ | The framework and its `vminitd` guest artifacts are arm64; multi-month reimplementation of what `vfkit` already gives us. |
| **`vfkit` driver (Virtualization.framework)** | ✅ **recommended** | Intel x86_64 hosts, Linux x86_64 guests, vsock + virtio-fs + raw disks, CLI-shaped like Cloud Hypervisor. |
| libkrun / krunkit | ❌ | libkrun's HVF support is **macOS/ARM64**; no Intel macOS. |
| QEMU + HVF | ⚠️ fallback only | Runs on Intel, but on a macOS host it has **no vsock** and **no virtio-fs** (virtiofsd is Linux-only); would need a virtio-serial control channel and 9p shares — i.e. agent and mount changes — for a worse result. |
| Linux guest + KVM inside (nested) | ❌ | Virtualization.framework doesn't nest on Intel; only third-party hypervisors might, as a VM-inside-VM. |
| **Linux x86_64 host, Intel Mac as the client** | ✅ **works today, zero code** | The Linux/KVM backend is supported and the UI is a browser. See below. |

## The zero-code answer (works today)

Run sadbox on any supported **Linux x86_64 host with KVM** — a home server, or a cloud instance
with nested virtualization (Intel C8i/M8i/R8i, or any `.metal`) — and open its web UI from the
Intel Mac. Two things make this practical rather than a compromise:

- The UI, terminal, vaults and proxy are all browser-side; the Mac needs no code.
- Projects can be created **from a git remote instead of a local folder**
  (`sourcePath` omitted → clone-in-VM), so the fact that the source tree lives on the Mac is not a
  blocker: push, create/clone on the Linux host, sync back to a branch, pull on the Mac. A local
  folder on the Mac can also be shared to the Linux host over the network if wanted.

What it does not give you: the Mac's own CPU/RAM doing the work, and a local folder mapped
directly (the "copy this folder in" flow assumes the folder is on the supervisor's host).

## The real answer: a `vz` driver over `vfkit`

The driver boundary is already right for this ([01](01-virtualization-backends.md), decision 3).
The KVM driver is a good template because it is *also* a "VM is a folder, reached only through the
guest agent, no network" backend. Most of it transfers unchanged.

### What maps to what

| Driver piece | On Intel with `vfkit` |
|---|---|
| `create` / `destroy` / `start` / `stop` / `setMemory` | Same VM-as-folder design: `~/.sadbox/vz/vms/<ref>/vm.json`, `disk.ext4`, `vfkit.pid`, `console.log`. Start = spawn `vfkit` detached; stop = agent `poweroff`, then signal. |
| Disk clone + grow | **Already written**: `cloneDisk` in `driver/kvm/index.ts` has a macOS branch using `copyFileSync(..., COPYFILE_FICLONE)` (APFS clones) + `truncateSync`. The disk is raw ext4, which is all Virtualization.framework accepts. |
| Guest exec / terminal / stream / port-forward carriers | **Unchanged**: `src/driver/agent.ts` against the same guest agent. |
| vsock, host → guest (agent port 1024) | `--device virtio-vsock,port=1024,socketURL=<sock>,connect`. vfkit listens on the host unix socket and dials a **new** guest connection per host connection (a `tcpproxy` route), so the agent's one-connection-per-operation protocol works as-is. Host side is the existing `unixSocket(path)` dial — no `CONNECT` handshake. |
| vsock, guest → host (ready announcement, port 1025) | `--device virtio-vsock,port=1025,socketURL=<sock>,listen`; the host listens on the unix socket and vfkit bridges the guest's dial. The existing `awaitAnnouncement(path)` is already a unix-socket listener speaking the agent's frames — unchanged. |
| Shared mounts (agent history, logins, links) | `--device virtio-fs,sharedDir=…,mountTag=sbxN`; the agent already does `mount -t virtiofs <tag>`. No `virtiofsd` on the host, no uid translation flags — VZ's host implementation maps ownership itself. |
| Image build (`ImageStore`) | Same pipeline as Linux: `docker build` → `images/disk` → `mkfs.ext4` + the Go agent. On an Intel Mac Docker (Desktop or Colima) builds **linux/amd64** natively, and everything in `images/` is arch-neutral. Keep a separate `~/.sadbox/vz/images` root. |
| Kernel | Built locally by `sadbox setup` with Docker from `images/kernel` (Debian for the host's architecture, virtio/vsock modules in the initramfs). |
| initrd | vfkit always passes one, and a distro kernel needs it: the built initramfs carries the virtio/vsock modules, mounts the root disk and `run-init`s the agent. |
| Console | `--device virtio-serial,logFilePath=<console.log>`, `console=hvc0` (the CH kernel's console device). |
| Stats | CPU time from `ps -p <pid>`, memory/processes from the agent's `/proc` reads; the guest is isolated, so there are no network counters to report. `ProjectStats` fields are already optional. |
| Snapshots | None (Virtualization.framework cannot, for third parties), same as today's macOS backend. |

A boot ends up looking like:

```
vfkit --cpus 2 --memory 2048 \
  --bootloader linux,kernel=…/vmlinuz,initrd=…/initrd.img,\
cmdline="console=hvc0 root=/dev/vda rw init=/sbin/sadbox-agent sadbox.hostname=<ref> sadbox.announce=1025 quiet" \
  --device virtio-blk,path=…/disk.ext4 \
  --device virtio-vsock,port=1024,socketURL=…/agent.sock,connect \
  --device virtio-vsock,port=1025,socketURL=…/announce.sock,listen \
  --device virtio-fs,sharedDir=…,mountTag=sbx0 \
  --device virtio-rng \
  --device virtio-serial,logFilePath=…/console.log
```

No `virtio-net`: the VM has no network interface, exactly like the KVM driver.

### Code to write

Small, because the design did the hard part:

- `src/driver/vz/vmm.ts` (~80 lines): `vfkit` path (`SADBOX_VFKIT_BIN` or a pinned download),
  kernel and initrd, `vmmProblems()` (`process.platform !== "darwin"`, arch must match,
  binary present).
- `src/driver/vz/index.ts` (~450 lines): a close adaptation of `driver/kvm/index.ts` — `chArgs` →
  `vfkitArgs`, `hybridVsock(...)` → `unixSocket(...)`, stats via `ps`, same lifecycle, bridges
  and `restore()`.
- `src/driver/vz/images.ts` (~60 lines): the KVM image store pointed at `~/.sadbox/vz`, using the
  same `images/disk` build.
- `src/driver/index.ts`: pick `container` on macOS arm64, `vz` on macOS x64;
  `SADBOX_DRIVER=vz` overrides everywhere (so it can be tried on Apple silicon too, below
  macOS 26).
- `src/cli.ts`: `setup`/`doctor` branches (`vfkit` present, Docker present, kernel fetched).
- Tests: `test/fake-vfkit.ts` + `vz.test.ts` mirroring `test/fake-ch.ts` and `kvm.test.ts`; a real
  integration test is possible on GitHub's `macos-26-intel` runner, which is what vfkit itself
  uses for VM tests.
- README: platform table, requirements, `SADBOX_DRIVER`.

Rough size: **~600–700 lines of new code, ~150 lines of test**, and nearly all of it is the KVM
driver with the transport swapped.

### Effort

- **Spike, 1 day** (done 2026-11-11): booted the existing ext4 disk under VZ, confirmed agent
  `ping` over the `connect` unix socket, terminal over vsock, `mount -t virtiofs` from a share,
  stop/start. The only real unknown was the kernel — see "As built".
- **Driver + tests, 3–5 days** — as estimated.
- **Docs + CI, 1–2 days** — docs done; CI still open.
- Total: **about 1.5–2 weeks** for someone with the codebase in their head, versus months for a
  raw-framework backend.

### Risks and open questions (for the spike)

1. **Kernel/device compatibility.** Solved for arm64: CH's Image does not start under VZ at all;
   Debian's kernel does, with the vsock/virtio modules loaded from the initramfs. The amd64 pair
   (`vmlinuz` bzImage + `initrd.img`) is built the same way but has not been booted on Intel
   hardware yet.
2. **virtio-fs on Intel hosts.** Apple exposes it on both architectures, but I found no explicit
   Intel data point. Fallback: `sharedMount: false` — history and logins are then copy-in only,
   and the product still works (that is exactly how the KVM driver degrades without `virtiofsd`).
3. **Number of virtio-fs devices.** One per distinct host folder; usually 1–3. Confirm VZ's limit.
4. **vfkit governance.** Third-party, Red Hat/CRC-adjacent, one main maintainer-ish, but shipping
   in Podman/CRC/minikube; 66 MB signed universal builds. Pin the version and download it in
   `setup` like Cloud Hypervisor. Apple's `container` stays the primary on Apple silicon.
5. **Platform horizon.** macOS 26 is the last release that runs on any Intel Mac, and vfkit's own
   Intel CI runners are flagged for possible retirement in 2028. This is a "keep the old Mac
   useful" path, not a growth platform — worth saying so in the README.
6. **Docker dependency.** Unlike today's macOS path (which uses `container build`), the `vz`
   driver needs Docker/Colima to build `linux/amd64` images and the ext4 disk. Acceptable, but a
   new requirement to document.

## Recommendation (and what was done)

1. **If an Intel Mac is only a client:** the Linux/KVM backend on a Linux host (or a nested-virt
   cloud instance), with the UI in the Mac's browser and git remotes for source, still needs no
   code and no new backend.
2. **Built: the `vz` driver on `vfkit`** (`src/driver/vz`), behind `SADBOX_DRIVER=vz` and the
   default on Intel Macs; `container` stays the default on Apple silicon. See "As built".
3. **Not done, on purpose:** making `container` or Cloud Hypervisor work on Intel, or relying on
   nesting KVM inside a macOS VM.

The requirements for the `vz` path are: Intel Mac (2018+, macOS 15+), `vfkit`, Docker,
`git`, `openssl`, Bun (source builds) — noticeably lighter than `container`'s "macOS 26 + Apple
silicon".

## As built (2026-11-11)

`src/driver/vz/` is the third `ProjectDriver`. The KVM driver's transport-agnostic half moved to
`src/driver/vm.ts` (spec file, pid file, disk clone, mount planning, host socket bridges) and
`src/driver/diskimages.ts` (the Docker → ext4 pipeline), so both drivers share one copy. The
vfkit-specific part is `vfkitArgs()` (two vsock devices, a raw virtio-blk disk, virtio-fs shares,
a serial log, `--restful-uri`), `unixSocket()` as the agent dial (no `CONNECT` handshake), and
`ps -o time=` + guest `/proc` for stats.

What was proven, on an Apple silicon Mac (macOS 27.2, vfkit 0.6.4, arm64 guest — the same driver
code and Virtualization.framework path the Intel build uses):

- The whole `ProjectDriver` works against real VMs: create 0.46–0.99 s, stop 52–102 ms, start
  417–922 ms, destroy 57–110 ms; guest commands, PTY + resize, the host-dials-in socket, grown
  disk, memory change while stopped, and agent history mounted both ways over virtio-fs.
- The kernel choice: **Cloud Hypervisor's `Image-arm64` does not start under VZ** — `vm.Start()`
  fails with `VZErrorDomain Code=1` before the guest runs, with a bare config and with a valid
  initrd. Apple's Kata kernel and Debian's kernel both boot. The vz driver therefore builds
  Debian's kernel + initramfs locally with Docker (`images/kernel`), adding `virtio_pci`,
  `virtio_blk`, `virtio_console`, `virtio_fs`, `vsock`, `vmw_vsock_virtio_transport` and `ext4` to
  the initramfs; without the vsock modules the agent exits with `open /dev/vsock: no such file`.
- Cloud Hypervisor's x86 `bzImage-x86_64` is *not* used either — one kernel strategy per backend is
  simpler, and Debian's amd64 `vmlinuz` is the standard thing VZ on Intel boots.

Not yet proven: the amd64 kernel + disk on Intel hardware, virtio-fs specifically on Intel, and a
CI job (macOS runners have no Docker; the plan is to build the artifacts on the Linux job and run
the VM test on `macos-26-intel`).

## Sources

- Apple `container` README (Apple silicon, macOS 26): https://github.com/apple/container
- Apple Virtualization framework overview (Apple silicon *and Intel*): https://developer.apple.com/documentation/virtualization
- Apple, *Creating and Running a Linux Virtual Machine* (both architectures): https://developer.apple.com/documentation/virtualization/creating-and-running-a-linux-virtual-machine
- Apple, `VZGenericPlatformConfiguration.isNestedVirtualizationSupported` (M3+): https://developer.apple.com/documentation/virtualization/vzgenericplatformconfiguration/isnestedvirtualizationsupported
- vfkit repository, usage (vsock connect/listen, virtio-fs, virtio-blk, serial, REST): https://github.com/crc-org/vfkit
- vfkit supported hosts (Intel x86_64; CI on macOS 26 Intel): https://github.com/crc-org/vfkit/blob/main/doc/supported_platforms.md
- vfkit vsock proxy implementation (new guest connection per host connection): https://github.com/crc-org/vfkit/blob/main/pkg/vf/vsock.go
- vfkit release v0.6.4 (universal signed binary): https://github.com/crc-org/vfkit/releases/tag/v0.6.4
- Cloud Hypervisor Linux release assets, `bzImage-x86_64` at the pinned tag: https://github.com/cloud-hypervisor/linux/releases/tag/ch-release-v7.2.8-20261009
- libkrun (HVF on macOS/ARM64): https://github.com/containers/libkrun
- Lima VZ driver, Intel caveats: https://lima-vm.io/docs/config/vmtype/vz/
- vsock on macOS research notes (QEMU/HVF has no workable vsock; VZ is the path): https://gist.github.com/patrickjholloway/660e371efd4c6749aba7b2726105fb91
- macOS Tahoe 26 Intel models: https://support.apple.com/en-us/122867
- Parallels, nested virtualization on Intel Macs (third-party hypervisor, two layers): https://docs.parallels.com/landing/parallels-desktop-developers-guide/software-development-specific-functions-of-parallels-desktop/nested-virtualization-support
