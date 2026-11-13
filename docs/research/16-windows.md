# 16 — Running sadbox on Windows

> **Status: research, 2026-11-13; WSL 2 implementation started on
> `feature/windows-wsl2`.** Verdict: **doable, and closer than the platform's
> reputation suggests.** Two routes work:
>
> 1. **WSL 2** — the existing Linux/KVM build, unchanged, inside a managed WSL
>    distribution. Weeks of packaging; full feature parity; Windows 11 x64 only;
>    ARM64 is a hard no. **Ship this first.**
> 2. **OpenVMM + WHP** — a native Windows driver. Microsoft's MIT-licensed Rust
>    VMM exposes **virtio-vsock over a Windows AF_UNIX socket with the same
>    `CONNECT`/`OK` handshake sadbox already speaks**, and serves virtio-fs
>    in-process. No protocol change. A sibling of the `vz` driver. An
>    open-source project (izba) already runs this exact shape on Windows 11
>    24H2. **Fund a spike; this is the durable native answer.**
>
> **Hyper-V/HCS is not the path.** It needs admin, excludes Home, and adds a
> privileged service for a worse UX than WHP. Cloud Hypervisor and Firecracker
> do not run on Windows, and there is no Apple-`container` equivalent.
>
> Everything below is grounded in the code on `main` (v0.5.0, three drivers) and
> in sources read on 2026-11-13. Facts that need a hands-on spike are marked
> **[verify]**.

## The question

Can sadbox run **on** Windows and make its project microVMs locally? (Not: can a
Windows browser open a sadbox running on a Mac or Linux host — that already
works, and remains the zero-code fallback.)

## Decision summary

| Question | Answer |
|---|---|
| Is Windows support possible? | **Yes.** Two independent routes, both with full isolation. |
| Is there a drop-in Apple-`container` equivalent? | **No**, but OpenVMM + WHP is close in shape. |
| Cheapest path? | **WSL 2 + the existing Linux/KVM driver.** No driver or protocol code. |
| Best native path? | **OpenVMM + WHP** (MIT, Rust, Microsoft; virtio-vsock over AF_UNIX; virtio-fs in-process). |
| Is QEMU/WHPX needed? | Only as a fallback; OpenVMM is the better fit (permissive licence, memory-safe, smaller, already used by WSL 3.0 and izba). |
| Hyper-V/HCS? | ❌ Admin-gated, Pro-only, and not needed — WHP is the user-mode API without the Hyper-V feature. |
| Windows Home? | ✅ WSL 2. ✅ WHP in practice (Docker's per-user products rely on it) **[verify]**. ❌ Hyper-V. |
| Windows 10? | ❌ WSL 2 nested virt (Windows 11 only). ✅ WHP native (Windows 10 2004+) **[verify]** — a real argument for the native path. |
| Windows ARM64? | ❌ WSL 2 (no `/dev/kvm`, no ETA). ✅ OpenVMM/WHP supports Aarch64 **[verify]**. |
| Biggest technical blocker | Not vsock: **OpenVMM solves it**. The blocker is the **Windows host port** (Bun, sockets, service, packaging). |
| Biggest product blocker | **Trust and enablement**: admin once, SmartScreen/SAC, a VM launcher + TLS proxy is malware-shaped. |
| Competitive reality | **Docker Sandboxes already ships a free local microVM-per-agent product on Windows 11 x64 + WHP.** Windows support is now table stakes, not a differentiator. |

## What Windows does *not* have

These facts decide the architecture. They are Windows ecosystem gaps, not
sadbox limitations.

1. **No first-party microVM-per-project stack.** Microsoft's VM stack is
   Hyper-V. There is no per-user, OCI-native, exec-agent-bearing "one small VM
   per container" API with a persistent ext4 root. Docker Desktop, Podman
   Desktop and Rancher Desktop all solve this by shipping a **WSL 2
   distribution**, not by exposing a VM API.
2. **No Cloud Hypervisor, Firecracker or vfkit on Windows.** Cloud Hypervisor
   is KVM/MSHV on Linux; Firecracker is KVM-only; vfkit is macOS. crosvm builds
   with a WHPX backend but is **not tested upstream**, and its virtio-vsock
   needs Linux's `/dev/vhost-vsock`.
3. **No `vhost-vsock`.** The Linux vhost kernel driver is absent, and QEMU's
   `vhost-user-vsock` needs eventfd/shared-memory/FD-passing backends that are
   Linux-shaped. This would be fatal — *except* that a userspace VMM can
   emulate `virtio-vsock` itself. **OpenVMM does exactly that**, over a Windows
   AF_UNIX socket.
4. **No virtiofsd.** Irrelevant for OpenVMM (virtio-fs is in-process), and the
   driver interface already degrades to `sharedMount: false` for QEMU-style
   backends.
5. **No reflink on NTFS**, and **none on ext4 either**. `cloneDisk` is O(image
   size) on both. Fix with sparse files (NTFS `FSCTL_SET_SPARSE`) or an
   XFS/btrfs image inside WSL (see below).
6. **No per-user Hyper-V.** Creating Hyper-V VMs needs **Hyper-V
   Administrators**. WSL 2 and WHP exist so that a normal user does not need
   that.

## Why sadbox is unusually well-placed

The codebase accidentally made a Windows port much smaller than a typical
desktop app port:

1. **The hypervisor is already behind `ProjectDriver`** (`src/driver/types.ts`).
   Windows is a fourth implementation, not a rewrite.
2. **The guest agent is the control plane** (`guest/agent`), and it runs
   *inside* the Linux guest. `terminal` is an in-guest PTY, `exec` is a framed
   stream, `connect` is raw bytes. **The host never needs a PTY** — Bun's
   ConPTY support exists, but sadbox does not depend on it.
3. **VMs have no network interface.** Egress rides a private socket to the
   supervisor's proxy. A Windows backend needs **no virtual switch, NAT, or
   firewall rule** — the most painful part of Windows virtualization disappears.
4. **Disks are copies, not shares**, so the workdir needs no filesystem
   passthrough. Only agent history uses a share.
5. **The UI is a browser app.** xterm.js, the editor, vaults and the proxy are
   already platform-neutral; a Windows browser is a supported client today.

The gaps are exactly three: **the VMM**, **the host↔guest transport**, and
**host OS services**. OpenVMM closes the first two. The third is the real work.

---

# The prior art changed the answer (2026)

This is no longer a greenfield question. Three developments matter:

## Docker Sandboxes (`sbx`) — the direct competitor

The product, its architecture and a full sadbox comparison are in
[15-docker-sandboxes.md](15-docker-sandboxes.md). Two Windows facts matter here:

- Local sandboxes run on **Windows 11 x64 + Windows Hypervisor Platform**, are
  installed **per-user via `winget`** into `%LOCALAPPDATA%`, and need no Docker
  Desktop. That is the bar for a native Windows install.
- It requires a Docker account sign-in and is Docker-hosted; a self-hosted,
  account-free tool still has a niche.

For Windows, the strategic point is that **Docker has already validated the
demand and the architecture** (VM-level isolation, host proxy, credential
injection, microVM per agent). Anthropic's own docs now point Windows users at
WSL 2, containers or VMs, and state that native Windows runs Claude Code
commands unsandboxed. sadbox must differentiate on *workflow* — vaults, agent
logins/history, project lifecycle, browser editor + git, sync-back — not on
"we have VMs".

Docker also ships **Docker VMM (beta)**: its **own VMM on top of WHP +
Virtual Machine Platform**, per-user, no Hyper-V role, x86_64 only. That is the
closest architecture to the native path in this document, and further evidence
that WHP is the right API — and that Home support is plausible **[verify]**.

**CUA (trycua)** merged *"microVMs on Windows: QEMU on the Windows Hypervisor
Platform, with checkpoints, forks and warm pools"* on 2026-11-07. It is the
best public performance data for the QEMU/WHPX fallback: on Windows 11 Pro
26200, 2 vCPU / 2 GB, **disk checkpoint 299 ms**, **cold restore/fork 3.95 s**,
**warm-pool claim 360 ms**, **~0.7–0.8 GB host RSS per running 2 GB VM**. It
also hit the same QEMU-on-Windows limits this document flags: guest reboot
hangs, `-cpu host` is not faster, and `-smp 4` is not better.

## izba — an open-source blueprint

`Lupus/izba` (Apache-2.0) is a per-project microVM sandbox for AI agents. It
ships two backends:

- **Linux/KVM** with Cloud Hypervisor + virtiofsd, including **WSL 2 nested
  virtualization**, with a gated integration suite.
- **Native Windows** with **OpenVMM over WHP**, cross-built `izba.exe`, an Inno
  Setup installer, and **full CLI parity validated on Windows 11 24H2**.

Its Windows port design is almost a specification for sadbox's native driver:
OpenVMM as a single `openvmm.exe`, `--virtio-vsock-path` over a Windows AF_UNIX
socket, the **same hybrid-vsock `CONNECT`/`OK` handshake**, virtio-fs served
in-process, Linux direct boot, no NIC by default, and a list of concrete
Windows bugs it had to fix (process trees, sparse files, handle inheritance,
AF_UNIX socket cleanup). Read it before writing any native code.

## Microsoft's OpenVMM — the substrate

OpenVMM is a **modular, cross-platform VMM in Rust, MIT-licensed**, from
Microsoft. It runs on **Windows x64/Aarch64 via WHP**, Linux via KVM/MSHV, and
macOS arm64 via Hypervisor.framework. It is the new backend in **WSL 3.0** and
the basis of OpenHCL. It supports:

- **Linux direct boot** (`--kernel`, `--initrd`, `-c cmdline`) — the exact
  artifact sadbox already builds.
- **virtio-vsock** over a host path, with the hybrid `CONNECT`/`OK` handshake
  (confirmed by its own test matrix on KVM, MSHV and **WHP**).
- **virtio-fs and virtio-9p**, served in-process — no sidecar.
- **virtio-blk**, raw images and VHD/VHDx; `--com1 file=` serial logs.
- **No NIC** unless `--net` is passed.
- A single standalone `openvmm.exe`.

Caveats: **OpenVMM ships no releases** (izba pins a CI artifact or builds from
source), its management CLI is still evolving, and it does not exit when the
guest powers off (stop needs a kill escalation). Those are real costs, but
they are packaging and hardening costs, not architecture risks.

---

# Option A — WSL 2 (ship first)

**Not a new driver.** It is "sadbox for Windows" delivered the way Docker
Desktop, Podman Desktop and Rancher Desktop deliver their Linux engines: a
managed WSL 2 distribution with the Linux binary inside.

## How it works

```
Windows 11
┌──────────────────────────────────────────────────────────────┐
│  Browser  ── http://localhost:7070 ──┐                       │
│                                      │ WSL localhost forward │
│  sadbox.exe (launcher / tray)        │                       │
│    └─ wsl.exe -d sadbox ─────────────┼──────────┐            │
│                                      │          │            │
│  ┌───────────────────────────────────▼──────┐   │            │
│  │ WSL 2 VM (Microsoft kernel, systemd)     │   │            │
│  │  sadbox (the unchanged linux-x64 binary) │   │            │
│  │    └─ Cloud Hypervisor ── /dev/kvm       │   │            │
│  │         └─ project microVM (no NIC)      │   │            │
│  │              └─ sadbox-agent (vsock)     │   │            │
│  └──────────────────────────────────────────┘   │            │
└──────────────────────────────────────────────────────────────┘
```

WSL 2 is a real, Microsoft-maintained Linux VM on Hyper-V. On **Windows 11**,
`[wsl2] nestedVirtualization` defaults to **true** (but set it explicitly; the
default has flipped before), and the WSL kernel ships `CONFIG_KVM=m`,
`KVM_INTEL/KVM_AMD=m`, `VHOST_VSOCK=m`, virtio-fs, loop devices and XFS/btrfs.
`/dev/kvm` appears, and the existing Linux driver runs unchanged: Cloud
Hypervisor microVMs, userspace hybrid vsock over a Unix socket, the proxy, the
guest agent, virtiofsd, Docker image builds.

This is proven by two independent implementations:

- **izba** — Cloud Hypervisor + virtiofsd per sandbox, NIC-less vsock island,
  gated integration suite green on WSL 2.
- **Firecracker on WSL 2** — a microVM per coding agent on a laptop, ~1000 runs
  over two weeks, **median time-to-ready 178.5 ms** over vsock.

## What ships

1. **The existing `sadbox-linux-x64` binary.** No new compile target.
2. **A WSL distribution** (tar or VHDX, imported with `wsl --import`) with:
   - Docker Engine + `docker-buildx` (not Docker Desktop), `git`, `openssl`,
     `curl`, optional `virtiofsd`;
   - the `sadbox` binary and a **system** systemd unit.
3. **`sadbox.exe`** — a small launcher compiled with Bun
   (`bun build --compile --target=bun-windows-x64`; verified locally on
   2026-11-13 with Bun 1.4.4: a PE32+ x64 executable is produced). It:
   - runs a preflight (Windows build ≥ 22000, WSL version, `/dev/kvm` openable,
     `KVM_GET_API_VERSION`, a 1-second canary VM);
   - imports/updates the distro, writes `wsl.conf` (`systemd=true`) and the
     unit, starts it, opens `http://localhost:7070`;
   - shows the sign-in password, logs, "Restart backend", "Uninstall".

No supervisor code changes are needed beyond the folder picker and host git
flags.

## What has to change in the repository

| Area | Change | Size |
|---|---|---|
| Release | Windows launcher + WSL distro build; the Linux binary already exists | CI + packaging |
| `src/api/http.ts` folder picker | Windows roots: `C:\…` ↔ `/mnt/c/…`; "Windows" and "WSL" sections | small |
| `src/core/sync.ts` | Host git on DrvFs: `-c core.fileMode=false`; line endings | small |
| `src/core/history.ts` | It applies host `path.join`/`dirname`/`slice().split("/")` to **guest POSIX paths**; even in WSL this is correct, but a native port must use `path.posix` (a latent bug to fix now) | small |
| `src/cli.ts` `doctor` | WSL-aware checks and messages | small |
| Docs / tests | Windows install page; a WSL CI job that runs `setup` + create + terminal + sync | docs + CI |

The folder picker and sync are the only product code that must be touched.
Everything else is packaging.

## Requirements and limits (be honest in the installer)

- **Windows 11 x64 only.** Nested virtualization is Windows 11-only; Windows 10
  ignores the setting.
- **Windows Home works** — WSL 2 is a Home feature. This is the strongest
  argument for WSL 2 over Hyper-V.
- **ARM64 is a hard no.** Windows on ARM starts the WSL guest at EL1, so
  `kvm: HYP mode not available` and there is no `/dev/kvm`. The request has
  been open since 2023 with no ETA; Snapdragon X2 Elite is still unsupported
  (2026-10-08). Do not advertise ARM support for this path.
- **Admin once + reboot** to enable `VirtualMachinePlatform` if it is not
  already on. After that, per-user.
- **Fragility is real.** In October 2026, one cumulative update silently
  removed nested virtualization on **all AMD machines** for ~2.5 weeks
  (`HcsGetServiceProperties` returned `ERROR_INVALID_DATA`; the WSL error was
  swallowed until 3.0.4 added a warning). Pin a known-good Windows build
  matrix, preflight hard, and ship a "Restart backend" button.
- **Laptop power bugs** are open: hibernate BSOD (`0x9F`), standby hangs,
  `WSAENOBUFS` after Modern Standby, periodic 3–4 s freezes. A long-running
  product will hit them; plan a resume hook (`wsl --shutdown` + restart).
- **Put all state on the WSL ext4 filesystem**, never `/mnt/c` — Unix sockets,
  permissions, sparse files and `FICLONE` do not behave on DrvFs.
- **ext4 has no reflink.** The current `cloneDisk` falls back to a full copy.
  Inside WSL, put VM state on an **XFS-with-reflink or btrfs image file** (the
  WSL kernel has both); clone time drops from seconds to milliseconds. This
  also improves the Linux story.
- **`/dev/kvm` permissions reset** (no seat/udev); use the `kvm` group, not
  ACLs.
- **vsock half-close does not cross** nested WSL (guest `SHUT_WR` never reaches
  the host). Audit the agent's framing; sadbox uses one-op-per-connection and
  explicit `exit` frames, so it is likely fine, but test it.
- **Lifecycle**: `vmIdleTimeout` 60 s, `instanceIdleTimeout` 15 s, logoff
  terminates instances. Use a system unit + a keep-alive, set
  `instanceIdleTimeout=-1`, and expect a full restart after reboot.
- **Projects on Windows folders** work through `/mnt/c` but are slower; git
  metadata, symlinks and line endings need care. Recommend WSL-side repos or
  git remotes for large projects.

## Effort

| Milestone | Estimate |
|---|---|
| Internal demo on an existing Ubuntu WSL distro (`setup`, `serve`, create, terminal, sync) | **1–2 days** |
| Beta: launcher, dedicated distro, system unit, folder mapping, doctor, docs | **2–3 weeks** |
| Product quality: signed installer, update, Windows matrix (Home/Pro, Intel/AMD), CI, repair flow | **4–6 weeks** |

Best effort-to-parity ratio in this document. The costs are product costs
(installer, support, WSL dependency), not engineering risk.

---

# Option B — native OpenVMM + WHP

**The durable native answer.** It is a fourth `ProjectDriver` and a Windows
host port, but **not** a protocol change and **not** a QEMU port.

## Why OpenVMM, specifically

| Property | Why it matters for sadbox |
|---|---|
| **MIT, Rust, Microsoft** | Permissive bundling; memory-safe; the same VMM Microsoft uses in WSL 3.0. |
| **WHP on Windows x64 + Aarch64** | No Hyper-V feature, no admin after enablement, Home-friendly, ARM64 possible. |
| **Linux direct boot** | Reuses `images/kernel` (`vmlinuz` + `initrd.img`) and `images/disk` (flat ext4) unchanged. |
| **virtio-vsock over a host path** | The existing guest agent (`mdlayher/vsock`) and host `hybridVsock` dialer work; OpenVMM answers `OK <channel>`, which the handshake already accepts. **No protocol v2, no serial mux.** |
| **virtio-fs in-process** | Agent history/logins mounts work without virtiofsd; one exe, no sidecar. |
| **No NIC by default** | The isolation property is preserved. |
| **Single `openvmm.exe`** | Simple packaging; no QEMU DLL zoo. |

The catch: **no releases**. You build it from source or pin a CI artifact
(izba's approach), and its CLI evolves. Budget a build pipeline and a version
pin. This is the main reason QEMU remains a fallback.

## What maps to what

| Driver piece | On Windows with OpenVMM |
|---|---|
| `create` / `destroy` / `start` / `stop` / `setMemory` | Same "VM is a folder": `%LOCALAPPDATA%\sadbox\openvmm\vms\<ref>\vm.json`, `disk.img`, `openvmm.pid`, `console.log`. Start = spawn `openvmm.exe` detached (`CREATE_NO_WINDOW`, no job object); stop = agent `poweroff`, then terminate the process tree. |
| Disk | Raw ext4; per-project **sparse** copy on NTFS (`FSCTL_SET_SPARSE` before `SetLength`, or it reserves the full size). VHDx is an alternative if differencing/clone support is confirmed **[verify]**. |
| Guest exec / terminal / stream / port forwards / proxy carriers | **Unchanged.** `hybridVsock(path)` becomes OpenVMM's `--virtio-vsock-path` AF_UNIX socket; the `CONNECT`/`OK` handshake is the same. |
| Shared mounts | `--virtio-fs pcie_port=fs-<tag>:<tag>,<host_path>` — in-process, no virtiofsd. `sharedMount: true`. |
| Console | `--com1 file=<console.log>`; keep `console=hvc0`? Use OpenVMM's serial or a virtio console as the kernel console **[verify]**; the log is the boot-failure tail. |
| Stats | Windows process counters (`GetProcessTimes`, `GetProcessMemoryInfo`) + guest `/proc` through the agent; `ProjectStats` fields are optional. |
| Lifecycle API | No REST/QMP needed: one process per VM, liveness by PID + creation time (`GetProcessTimes`, to defeat PID reuse), plus a `ping` through the agent. |
| Images | Same Docker → `images/disk` pipeline, run through Docker Desktop/WSL 2 or a helper distro. **Native Windows still needs a Linux environment to build the guest image** unless you ship a prebuilt, hash-verified base image + kernel from the release (the cleanest no-Docker UX) or embed `mke2fs` like izba. |
| Driver selection | `src/driver/index.ts`: `win32` → `openvmm`; `SADBOX_DRIVER=openvmm` to force it. |
| Supervisor | Bun on Windows: HTTP/WS/SQLite fine; AF_UNIX or named pipes for the proxy carriers/forwards; **no openssl** by default; Task Scheduler service; PMv2/signing. |

## Boot sketch

```text
openvmm.exe
  --hv
  --kernel   ...\vmlinuz
  --initrd   ...\initrd.img
  -c         "console=hvc0 root=/dev/vda rw init=/sbin/sadbox-agent
              sadbox.hostname=<ref> sadbox.listen=vsock:1024 quiet"
  --memory   2048MB
  --processors 2
  --virtio-blk file:...\disk.img,pcie_port=vda
  --virtio-vsock-path ...\vsock.sock
  --com1     file=...\console.log
  # no --net: the VM has no network interface
```

Exact flag spellings are a spike item; izba's driver (`vmm/openvmm.rs`) is a
working reference for `--kernel`, `--initrd`, `-c`, `--processors`,
`--memory`, `--virtio-blk`, `--virtio-fs`, `--virtio-vsock-path`, `--com1`,
`--hv`, and the PCIe root-port topology.

## The transport: why this is much smaller than it looked

If the VMM were QEMU or crosvm on Windows, vsock would be unavailable and the
one-operation-per-connection protocol would need a **serial multiplexer**
(protocol v2). OpenVMM removes that entirely:

- OpenVMM emulates **virtio-vsock** in userspace and exposes it as a **Windows
  AF_UNIX socket path** (`--virtio-vsock-path`).
- The host dials the socket and writes `CONNECT <port>\n`; OpenVMM answers
  `OK <vmbus-channel-id>\n`; frames follow. This is **byte-identical** to the
  Cloud Hypervisor hybrid-vsock path sadbox already implements in
  `hybridVsock()` (`src/driver/agent.ts:39`).
- The guest agent's `AF_VSOCK` listener is unchanged.
- Guest→host announce: OpenVMM's path model may not expose the
  `<socket>_<port>` convention CH uses; if not, **drop announce** and use the
  existing `waitForAgent` polling fallback. No protocol change.

Scope saved: the 1–2 week protocol v2 + serial transport disappears from the
critical path. The driver becomes a close sibling of `driver/vz` (one VMM
process per VM, vsock over a Unix socket, in-process share) rather than a new
transport stack.

## Host port chores (the real work)

| Topic | What breaks on Windows | Fix |
|---|---|---|
| Unix sockets / VMM channel | `net.Server.listen(<path>)`, `fetch({ unix })`, `rmSync`/`chmodSync` on sockets; Bun's `server.url` throws for AF_UNIX, and an open bug (#41381) reports AF_UNIX listeners accepting but never responding | **Named pipes** (`\\.\pipe\sadbox-…`) for sadbox's own carriers/forwards (supported in Bun since 1.1.28). For **OpenVMM's `--virtio-vsock-path`**, verify Bun can dial the AF_UNIX path; if not, add a tiny AF_UNIX ↔ named-pipe/TCP shim, or upstream a pipe option. `fetch({ unix })` is not needed (no CH REST API). |
| Proxy carriers | `~/.sadbox/run/<id>.sock` | Named pipe, or AF_UNIX if validated; remove the 100-byte `sun_path` guard for pipes. |
| TLS CA | The proxy shells out to `openssl` | Mint X.509 in TS with WebCrypto (`@peculiar/x509`) — removes the dependency everywhere — or bundle a static `openssl.exe` (Apache-2.0). |
| Service | `sadbox service` writes a systemd unit | Per-user **Task Scheduler** entry at logon (best fit) or NSSM/WinSW if a real service is needed; Bun has **no SCM integration**, so graceful stop must go through a control channel, not `SIGTERM`. |
| Detached VMM | Bun/libuv puts every `uv_spawn` child in a **kill-on-close job object**; children die with the supervisor unless detached | `Bun.spawn(..., { detached: true, stdio: ["ignore", …], windowsHide: true })` (detached removes it from the job), re-adopt by PID + creation time on startup. **Do not enable `--no-orphans`** — it is the opposite of "VMs outlive the supervisor". |
| Process trees | `proc.kill()` terminates **one** process; grandchildren survive (`SILENT_BREAKAWAY_OK`); OpenVMM runs the guest in an `openvmm vm` worker child | Sweep descendants (Toolhelp) and wait, or use a job object for the VM subtree; izba hit this exact bug (workload survived stop and held the disk/vsock). |
| Process liveness | `process.kill(pid, 0)`, `/proc` | `OpenProcess` + `GetProcessTimes` (creation time defeats PID reuse) + `GetExitCodeProcess`; `TerminateProcess` is not a tree kill. |
| Signals | **`SIGTERM` does not exist on Windows**; `proc.kill("SIGTERM")` is `TerminateProcess(1)`, an unconditional hard kill; a `process.on("SIGTERM")` handler never fires | Rebuild shutdown around `SIGINT`/`SIGHUP`/`SIGBREAK` plus an out-of-band control channel (loopback HTTP, named pipe, sentinel); VMM stop is agent `poweroff` → kill escalation. |
| Paths | `~/.sadbox`, POSIX joins, `chmod`, symlinks | `%LOCALAPPDATA%\sadbox` (or `SADBOX_DATA`); no-op `chmod`; avoid host symlinks; guard `fs.rm` against empty paths (Bun #47420 can wipe cwd). |
| Sparse disks | `truncate` allocates real clusters on NTFS | `FSCTL_SET_SPARSE` before extending, or the 32 GiB default consumes 32 GiB. |
| Host tools | `sh -c "command -v"`, `stty`, `cp --reflink`, `ps`, `tar --no-xattrs`, `openssl` | Windows branches: `Bun.which`, a hidden password prompt, `fs.cp`/`fs.copyFile`, Windows process counters, in-box `tar.exe`/`Bun.Archive`, WebCrypto X.509. |
| Bun runtime | `import.meta.main` is **always false** in compiled Windows builds (open #48689); `localhost` resolves `::1` first; `fs.watch`/`fs.rm` have open bugs | Avoid `import.meta.main` in the entrypoint; bind `127.0.0.1` explicitly; one watcher per path; test `bun:sqlite` WAL + long-running server. |
| Packaging | Unsigned exe → SmartScreen; SAC blocks unknown binaries; AV flags a VM launcher + TLS MITM; no winget integration in Bun | Per-user MSI (Inno/WiX) + submit a `winget` manifest; **Artifact Signing** (~$9.99/mo); a Store listing for a warning-free channel; security whitepaper. Bun strips inherited Authenticode so `signtool` can sign; `--windows-hide-console` works cross-target. |

### Bun on Windows, concretely

Verified or documented as of Bun 1.4.4 (2026-10-22):

- **Cross-compile works** from macOS/Linux: `bun build --compile
  --target=bun-windows-x64` produced a 110 MB PE32+ console executable in
  seconds. It imports only system DLLs (the UCRT is statically linked since
  1.1.19), so there is no VC++ redistributable to ship. `bun-windows-arm64`
  exists too.
- **PTY exists** (`Bun.Terminal` via ConPTY since 1.3.14) but sadbox does not
  need it: the PTY is in the guest.
- **HTTP, WebSockets, `bun:sqlite`** are production-viable. WAL works; keep a
  reference to a `Database` so GC does not close it mid-transaction.
- **Spawn is the sharp edge**: every child is in libuv's kill-on-close job
  object. `detached: true` removes it (the lever for VMs that outlive the
  supervisor); `--no-orphans` is the opposite and must **not** be enabled.
  `windowsHide: true` is required or console windows flash. Concurrent spawns
  can inherit a sibling's pipe (open #48351), delaying EOF.
- **Signals**: there is no `SIGTERM`; `proc.kill("SIGTERM")` is a hard
  `TerminateProcess(1)`. `SIGINT`/`SIGHUP`/`SIGBREAK` are delivered. Design
  shutdown around those plus an explicit control channel.
- **Sockets**: named pipes are supported; AF_UNIX binds but has rough edges.
  Prefer pipes for sadbox's own sockets and validate the OpenVMM AF_UNIX path.
- **The rest is chores**: `openssl`, `sh`, `stty`, `ps`, `cp`, `tar`, symlinks,
  `chmod`, and a winget/installer story. None is architectural.

## Security

- **The VM boundary is real**, and OpenVMM is memory-safe Rust with a minimal
  device model — much closer to Cloud Hypervisor's TCB than QEMU's C surface.
  This is a strong reason to choose it over QEMU.
- **Isolation properties survive**: no NIC, no host filesystem share by
  default, proxy-enforced egress, per-VM disk, no host PTY.
- **New surface**: the AF_UNIX vsock socket (same-user ACLs; remove stale
  files), the supervisor's proxy port, and the Windows process model.
- **Do not install the MITM CA on the host.** sadbox already installs its CA
  only in the **guest** trust store; keep it that way. A host root CA is a
  security-review red flag, breaks Firefox/Java/Node bundles unevenly, and is
  unnecessary.

## Effort

| Phase | Estimate |
|---|---|
| Spike: OpenVMM boots the existing ext4 disk + kernel, agent `ping`/terminal over `--virtio-vsock-path`, one proxy carrier and port forward, virtio-fs mount, sparse disk, measure create/IO | **3–5 days** |
| `driver/openvmm` (args, lifecycle, stats, images, restore) + fake-VMM tests; model on `vz` | **2–3 weeks** |
| Supervisor port (Bun Windows, AF_UNIX/pipes, X.509, Task Scheduler, paths, process management) | **2–3 weeks** |
| Installer, signing, auto-start, update, OpenVMM build/pin | **2 weeks** |
| Hardening, Windows matrix (11 x64 + ARM64, Home/Pro), performance, security review | **3–4 weeks** |
| **Total** | **~8–12 weeks** for one experienced developer; **3–4 months** to a signed, product-quality release |

This is materially less than a QEMU-based plan because it removes the protocol
change, the virtiofsd problem, the QEMU packaging/licence burden, and the
CLI-REST-over-UDS rewrite.

## If OpenVMM is not viable: QEMU + WHPX

QEMU/WHPX is a real fallback, not a straw man — CUA ships it (above) — but it
is **materially worse for sadbox**, and the reasons are structural:

- **No vsock, no vhost-user, no 9p, no virtiofs on Windows.** QEMU's own
  `meson.build` rejects vhost-user on Windows and vhost-kernel outside Linux.
  The control plane becomes **virtio-serial + a framing/mux layer** (the
  protocol v2 this document otherwise avoids). Port forwards and proxy
  carriers all ride that one byte stream.
- **No VM state save/restore.** WHPX registers a hard migration blocker, so
  `savevm`/`migrate` are impossible; only disk checkpoints and paused
  warm-pool VMs. That is a different product architecture.
- **More sharp edges**: never `-cpu host`; guest reboot hangs; no balloon; no
  VGA; `-M microvm` is x86-only and untested under WHPX; the Windows block
  backend is thread-pool + `ReadFile`, with no discard/TRIM on raw files.
- **Distribution**: GPLv2 (you ship corresponding source), **unsigned**
  upstream builds (you sign them), ~150–250 MB, and documented Defender false
  positives. QEMU's C device model is a much larger TCB than OpenVMM's Rust.
- **Performance**: ~4 s cold restore, 360 ms warm-pool claim, ~0.7–0.8 GB RSS
  per 2 GB VM (CUA). Fine for a dev tool; not a CH-class footprint.

Pick QEMU only if OpenVMM's no-release/CLI churn is unacceptable, or as a
short-lived stopgap while the OpenVMM driver is built.

---

# Option C — Hyper-V / HCS (not recommended)

Included because "Windows support" often means "use Hyper-V". It is possible,
but the worst fit.

## Two variants

1. **Hyper-V management API** (`New-VM`, WMI): documented and stable, but it
   has **no direct kernel boot** — a Generation 2 VM boots through UEFI, so the
   current flat ext4 artifact would need a VHDX with an ESP and GRUB/UKI. It
   also needs Hyper-V Administrators, and VMs are `vmms`-owned.
2. **HCS** (`vmcompute.dll`, `hcsshim`): what WSL, LCOW and EFLOW use. Its
   `Chipset.LinuxKernelDirect` schema takes **kernel + initrd + cmdline
   directly** — the exact shape sadbox already builds — plus SCSI disks, a
   synthetic serial port, and Hyper-V sockets. This is the only sane
   Hyper-V-based route.

An HCS VM config is, almost verbatim, sadbox's model:

```json
{ "VirtualMachine": {
    "Chipset": { "LinuxKernelDirect": {
        "KernelFilePath": "...\\vmlinuz",
        "InitRdPath": "...\\initrd.img",
        "KernelCmdLine": "root=/dev/sda rw init=/sbin/sadbox-agent ..." } },
    "ComputeTopology": { "Memory": { "SizeInMB": 2048, "AllowOvercommit": true },
                         "Processor": { "Count": 2 } },
    "Devices": { "Scsi": { "0": {} },
                 "HvSocket": { "HvSocketConfig": { ... } },
                 "ComPorts": { "0": { "NamedPipe": "\\\\.\\pipe\\sadbox-<ref>" } },
                 "Plan9": {} } },
  "ShouldTerminateOnLastHandleClosed": true }
```

HCS also gives CPU/memory/disk/uptime statistics (`HcsGetComputeSystemProperties
"Statistics"`), dynamic memory (`AllowOvercommit`, balloon hints), and VHDX
differencing disks for O(1) clones. `hcsshim` even ships `tar2ext4`, which can
build the ext4 VHD on Windows without Linux.

## The one thing it does better: hvsocket

Hyper-V sockets (`AF_HYPERV`) are the Windows analog of vsock, addressed by VM
ID + a service GUID. Linux's `hv_sock` registers as an `AF_VSOCK` transport, so
the guest agent's listener can work — but the details are worse than they look:

- **Guest→host only.** The Linux transport registers `VSOCK_TRANSPORT_F_G2H`;
  there is no guest→guest, and a host→guest *listen* is not the model. sadbox's
  host dials **into** the guest for the agent and for proxy carriers, so the
  direction would have to invert (the guest dials the host and the host
  multiplexes), or use a different channel.
- **16 KB MTU**, per-connection VMBus channel, 24–256 KB ring. Fine for exec
  and JSON, **bad for bulk sync** — the block disk is the right path for that.
- **Service GUID ↔ vsock port** is a fixed template
  (`<port>-facb-11e6-bd58-64006a7986d3`), and the host must register the GUID
  under `HKLM\...\GuestCommunicationServices` — **admin at install time**.
- Host-side access needs `AF_HYPERV` WinSock calls, which Node/Bun do not
  expose: `bun:ffi`/a native helper, or a Go/Rust companion.

## Why it loses

- **Admin**: HCS needs a **privileged service** (SYSTEM) that owns the handles;
  there is no documented per-user HCS path. `ShouldTerminateOnLastHandleClosed`
  means VMs die with the owning process, so "long-lived" is the service's job.
- **Editions**: HCS is used in practice on Pro/Enterprise/Education; **Home is
  unverified and likely unsupported** for a third-party service. WHP is the
  per-user-friendly API.
- **Image pipeline**: VHDX + UEFI bootloader (Hyper-V WMI), or the undocumented
  HCS path; optionally `tar2ext4`/ReFS block clones.
- **No virtio**: the guest needs `CONFIG_HYPERV_*` (VMBus, storvsc, hv_sock,
  balloon), not virtio. A new kernel config and a new device model.
- **Undocumented contract**: HCS docs were last substantively updated in 2022;
  `hcsshim`'s useful packages are `internal/`, so you vendor/fork or write your
  own client. Version coupling and a real support burden.
- **Effort**: **10–12 engineer-months** to parity, plus a privileged service,
  for a worse UX than WSL 2 or OpenVMM.

**Home remains the killer**: HCS is the one Microsoft-native path that could
boot the existing artifact, and it is exactly the path that wants Pro plus a
service. If Home must work, HCS is out.

Revisit only for an **enterprise deployment** that mandates Hyper-V, has an
IT-managed privileged service, and forbids WSL/WHP.

---

# Options that lose

| Option | Verdict | Why |
|---|---|---|
| **Cloud Hypervisor on Windows** | ❌ | Linux-host only (KVM/MSHV); no WHP backend. |
| **Firecracker on Windows** | ❌ | KVM-only. |
| **crosvm + WHPX** | ⚠️ research only | WHPX backend untested upstream; virtio-vsock needs `/dev/vhost-vsock`. |
| **QEMU + WHPX** | ⚠️ fallback | Works (x64 and Arm64), but no vsock (needs a serial mux), GPL, large C TCB, Windows builds from a third party. Keep only if OpenVMM's no-release risk is unacceptable. |
| **libkrun / krunkit** | ❌ | KVM/HVF only; no Windows. |
| **VirtualBox / VMware** | ❌ | Full-VM products, no vsock, no microVM model, heavy/licensed. |
| **Windows Sandbox** | ❌ | Windows guests, disposable, one instance, no custom kernel. |
| **WSL containers (`wslc`)** | ❌ | Containers share the WSL kernel; not a real VM per project. |
| **Microsoft Hyperlight** | ⚠️ watch | WHP microVMs with ~3 ms snapshot restore. The core library has **no guest kernel/OS** (purpose-built `no_std` guests); a newer Unikraft-based integration can run Linux binaries, but it is **not a general Debian + tmux + block-disk VM**. Watch the snapshot speed, not the fit. |
| **Docker Desktop's engine** | ❌ | A container cannot reach the host hypervisor; its VM does not expose nested KVM. |
| **A Linux host + Windows browser** | ✅ zero code | The existing Linux/KVM backend on a home server or cloud VM. The fallback when WSL/WHP is blocked, and the baseline for "Windows users". |

---

# Comparison

| | A. WSL 2 | B. OpenVMM/WHP | C. Hyper-V/HCS | Linux host + browser |
|---|---|---|---|---|
| New driver | none | yes (`openvmm`) | yes (`hyperv`) | none |
| Protocol change | none | **none** | transport inversion (hvsocket is G2H only) | none |
| Feature parity | **full** (virtiofsd, Docker) | full (virtio-fs in-process) | high (no virtiofs) | full |
| Windows versions | **11 x64 only** | 11 x64 + Arm64; 10 2004+ **[verify]** | 10/11 Pro+ (Home unverified) | n/a |
| Windows Home | **yes** | **yes [verify]** | no | n/a |
| Admin after install | no | no | **yes** (service) | no |
| Extra layer | WSL VM | none (WHP) | none | network |
| Performance | nested KVM; good (87–90% bare-metal class [second-hand]) | near-native CPU; NTFS I/O unknown | best integration | network latency |
| Security | CH inside WSL (two layers) | OpenVMM (Rust, minimal) | Hyper-V + privileged service | CH on Linux |
| Disk clone | ext4 full copy; XFS/btrfs-in-file for fast | sparse raw; VHDx maybe | VHDX differencing | reflink/sparse |
| Effort | **2–6 weeks** | **8–12 weeks** (3–4 months product) | 10–12 engineer-months | 0 |
| Biggest risk | Windows-update fragility; ARM64 no | OpenVMM has no releases; host port | admin + HCS | not local |

## What is actually measured

| Path | Boot / create | Restore | Host memory | Source |
|---|---|---|---|---|
| WSL 2 + Firecracker | **178.5 ms** time-to-ready, median of 20 boots | n/a | n/a | mko.run, 2026-11-10 |
| WSL 2 + Cloud Hypervisor | works end-to-end; create time not published | n/a | n/a | izba |
| QEMU/WHPX | ~1.2 s to guest init | **3.95 s** cold; **360 ms** from a warm pool | ~0.7–0.8 GB per 2 GB VM | CUA, 2026-11-07 |
| OpenVMM/WHP | **unmeasured** — the spike's job | n/a | unknown | — |
| Hyper-V/HCS | unmeasured | n/a | `AllowOvercommit` | — |

These are single-source field numbers, not a benchmark suite. They are enough
to set expectations: all four paths are usable for an interactive dev tool;
none matches bare-metal KVM, and only QEMU has a published Windows number.

---

# Recommendation

## 1. Ship WSL 2 as "sadbox for Windows (beta)" — now

It delivers **full feature parity in weeks**, works on Home, keeps the
per-user/no-admin model, and needs **zero** driver or protocol work. It is also
the fastest way to learn whether Windows demand is real before funding a native
backend.

Do it in this order:

1. **One-day demo** on an existing Ubuntu WSL distro: `sadbox setup`,
   `sadbox serve`, `localhost:7070`, create → terminal → sync back. Settles
   `/dev/kvm`, Docker, localhost forwarding and the folder paths on the target.
2. **Launcher + dedicated distro**: `sadbox.exe`, `wsl --import`, system unit,
   preflight, `doctor`, logs, password display, "Restart backend".
3. **Path/sync polish**: Windows folder picker, `/mnt/c` mapping,
   `core.fileMode=false`, large-repo guidance; move VM state to an
   XFS/btrfs-in-file volume for reflink-fast clones.
4. **Packaging**: per-user MSI + `winget`, signed launcher, update path,
   uninstall (unregister the distro), Windows matrix CI.

## 2. Spike OpenVMM/WHP in parallel (3–5 days, time-boxed)

Exit criteria:

- OpenVMM boots the existing `images/kernel` `vmlinuz` + `initrd` and the
  existing ext4 disk, with `--hv`, Linux direct boot, no NIC.
- Agent `ping`, a terminal, one proxy carrier and one port forward over
  `--virtio-vsock-path` with the existing `CONNECT`/`OK` dialer.
- `--virtio-fs` mounts agent history.
- Sparse disk clone on NTFS; measure create→ready and disk write throughput.
- WHP present and usable on **Home** and **Pro**, Intel and AMD; OpenVMM
  Aarch64 on Windows ARM64 **[verify]**.

If the spike passes, budget the 8–12 weeks. If OpenVMM's no-release/CLI churn
is unacceptable, fall back to QEMU/WHPX and add the serial mux — a known,
larger cost.

## 3. Do not start with Hyper-V

It is the most "Windows-native" answer and the least sadbox-shaped: admin,
Pro-only, bootloader/VHDX work, an undocumented HCS surface, and a privileged
service. WHP gives the same hypervisor without the Hyper-V feature.

## 4. Keep the zero-code fallback visible

A Windows user can already run the Linux backend on a Linux host (or a cloud VM
with nested virtualization) and use the Windows browser. That is the escape
hatch when WSL/WHP is blocked by policy.

---

# Product, packaging and trust

Windows support is as much a distribution problem as a hypervisor problem.

## Editions and versions

- **Windows 11 x64 is tier 1.** Windows 11 is ~71% of Windows desktops
  (StatCounter, Oct 2026); Windows is ~49.5% of professional developers' primary
  OS; **~17% of professional devs already use WSL** as their primary
  environment.
- **Windows 10** is ~27.8% of Windows desktops (EOL 2025-10-14) and ~14% of
  professional devs by arithmetic. WSL 2 nested virt excludes it; the native
  OpenVMM/WHP path can support 2004+ **[verify]**. This is the main argument
  for native beyond ARM64.
- **Home is the majority of consumer/small-shop machines.** Never require
  Hyper-V.
- **ARM64 is low single digits today** (TrendForce-derived ~3.2% of laptops in
  2026) and WSL 2 cannot do it. Ship it as native beta only, if at all.
- **Server/LTSC**: offline/MSI install paths matter; the Store may be blocked.
  Design `wsl --import` / MSI from day one.

## Enablement funnel (four leaks you cannot fully fix)

1. No local admin — the dominant enterprise config. Per-user install, one
   elevation prompt ever (platform enablement), never on update.
2. Optional Windows features disabled by policy/Intune — print the exact
   `DISM`/`Enable-WindowsOptionalFeature` command **and** ticket-ready
   justification.
3. BIOS/UEFI virtualization off or locked — detect and say so; do not loop.
4. WDAC/AppLocker/Smart App Control — unknown binaries are blocked outright.
   Sign everything; provide a Store/IT path.

## Packaging

- **Per-user MSI** in `%LOCALAPPDATA%`, no service by default, plus
  `winget install`. This is what Docker Sandboxes does; it works.
- **Machine-wide MSI** for Intune/ConfigMgr; optional privileged helper only
  for a named, narrow need (e.g. binding <1024), never auto-elevated.
- **Portable zip** for CI/air-gapped use.
- **MSIX/Store later** for a SmartScreen-free channel; MSIX cannot enable
  optional Windows features or register a WSL distro, so it cannot be the only
  channel.
- **Signing**: EV certificates **no longer bypass SmartScreen** (Microsoft,
  updated 2026-08-17). Use **Artifact Signing** (~$9.99/mo, HSM-backed,
  1–20 business days for identity validation), one stable identity, hashes +
  SBOM, and a Store listing in parallel. Expect weeks/months of reputation
  building; a signed-but-unknown VM launcher + TLS proxy is malware-shaped.

## Security posture

- **No host root CA.** Guest-only, as sadbox already does. Document it; it is
  a selling point against tools that install one.
- **No Windows service by default.** Per-user process, per-user VMs,
  loopback-only networking; smaller attack surface.
- **Sign the launcher, the OpenVMM binary and the guest agent.** Publish SBOM
  and a vulnerability-disclosure path; you are shipping an OS image.
- **Defender**: write only to `%LOCALAPPDATA%`; document an optional exclusion
  for the VM-disk directory (or use a Dev Drive with Defender performance
  mode); never disable Defender as a first-line fix.

## UX details

- **Paths**: show both `C:\…` and `/mnt/c/…`; preserve absolute paths where
  possible; refuse UNC/OneDrive-redirected workspaces with a clear message.
- **Terminal is the browser**, not ConPTY — sadbox avoids a whole class of
  Windows console pain (VT modes, resize polling, `Ctrl+C` ambiguity). The
  guest PTY is the terminal.
- **Windows Terminal profile**: not required; optionally register one.
- **High DPI**: PMv2 in the launcher manifest if it has UI.
- **Uninstall**: remove VM disks, WSL distro, Task Scheduler entry, PATH
  entries and certificates (guest), and verify removal.

---

# Open questions (must verify before committing)

1. **WSL nested KVM matrix**: Win11 Home/Pro, Intel/AMD, current WSL kernel;
   `/dev/kvm` present and CH boots; create→ready vs bare metal. Re-test after
   the October 2026 AMD regression.
2. **WSL reliability**: hibernate/standby/freeze bugs; what a "Restart
   backend" flow must do; whether `[experimental] autoMemoryReclaim=gradual`
   is needed.
3. **ext4 reflink**: move VM state to XFS/btrfs-in-file and measure clone time;
   confirm `cp --reflink=always` is milliseconds inside WSL.
4. **OpenVMM availability**: build-from-source vs pinned CI artifact; which
   tag is stable; flag stability; Aarch64/WHP support; whether `--virtio-vsock-path`
   supports guest→host announce or only host→guest dial.
5. **OpenVMM device/flag details**: `--memory`/`--processors` syntax, console
   (`--com1` vs virtio console), `--virtio-blk` raw disk, VHDx differencing,
   PCIe root-port topology, and graceful shutdown (it does not exit on guest
   poweroff).
6. **WHPX on Windows Home**: confirm the optional feature is available and
   usable without elevation *after* enablement; confirm on a clean Home image.
7. **Windows 10 native**: does OpenVMM/WHP work on 2004+ x64? If yes, it is a
   meaningful tier-2 market.
8. **Bun on Windows**: AF_UNIX support, named pipes, `bun:sqlite`, detached
   processes, signals, long-running server, compiled `$bunfs` paths.
9. **Serial/vsock throughput**: OpenVMM's vsock for 100 MB repo copy-in, sync
   bundles and port-forward traffic; if weak, add a bulk channel.
10. **Packaging/signing**: Artifact Signing eligibility, Smart App Control
    behaviour, Defender false positives, and whether a Store listing is worth
    the review cycle.
11. **DrvFs costs**: git + tar + checkout on `/mnt/c` for a 100 MB repo;
    whether `metadata`/experimental `virtiofs` is needed.
12. **WHPX vs OpenVMM maturity**: is izba's experimental Windows path a good
    enough signal, or does sadbox need its own VMM fork? Who owns the OpenVMM
    pin and CVE cadence?

---

# As built (WSL 2, `feature/windows-wsl2`)

The WSL 2 half of this document is now in the tree:

- `src/core/wsl.ts` — WSL 2 detection, Windows ↔ `/mnt/<drive>` path
  translation, DrvFs detection, `core.fileMode` / `core.autocrlf` /
  `core.symlinks` git settings, `.wslconfig` parsing, and the `doctor` text.
- The folder picker accepts `C:\...` and returns Windows display paths plus
  "Windows (C:)" / "WSL home" roots (`src/api/http.ts`, `web/app.js`).
- Project create and "connect a folder" normalize Windows paths; host git on
  `/mnt/*` ignores mode/line-ending noise (`src/core/projects.ts`,
  `src/core/sync.ts`, `src/core/push.ts`).
- `sadbox setup`, `doctor` and `serve` recognise WSL, refuse a data dir on a
  Windows drive, and print the `nestedVirtualization=true` fix.
- `install.sh` detects WSL, explains the `/dev/kvm` fix, and rejects ARM64.
- `src/win/launcher.ts` builds `sadbox-windows-x64.exe` (`serve` / `setup` /
  `doctor` / `open`) and drives the distro over `wsl.exe`.
- User guide: [`../windows-wsl2.md`](../windows-wsl2.md); beta release and
  acceptance runbook: [`../windows-wsl2-beta.md`](../windows-wsl2-beta.md);
  README platform table, requirements, install and limitations updated.

Not built yet: a one-click installer or dedicated distro image, a Windows CI
matrix (WSL 2 + nested KVM), and the native OpenVMM/WHP driver.

# Sources

Read on 2026-11-13 unless noted.

**Microsoft / platform**
- WSL advanced settings (`.wslconfig`, `nestedVirtualization` default `true`,
  Windows 11 only; `localhostForwarding`; `autoMemoryReclaim`; `virtiofs`
  experimental) — updated 2026-10-16:
  https://learn.microsoft.com/en-us/windows/wsl/wsl-config
- WSL networking and filesystems (mirrored mode, `/mnt/c` performance,
  localhost forwarding) — 2026:
  https://learn.microsoft.com/en-us/windows/wsl/networking ,
  https://learn.microsoft.com/en-us/windows/wsl/filesystems
- WSL Intune policy ("Allow nested virtualization") — updated 2026-10-30:
  https://learn.microsoft.com/en-us/windows/wsl/intune
- WSL basic commands (`wsl --import`, `--import-in-place`, `--manage
  --set-sparse`): https://learn.microsoft.com/en-us/windows/wsl/basic-commands
- Windows Hypervisor Platform API (user-mode, x64 + Arm64) — updated 2026-06-11:
  https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform
- Hyper-V install (Home excluded) — updated 2026-02-16:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v
- HCS API and JSON schema (`Chipset.LinuxKernelDirect`, `ComPort`, `Scsi`,
  `HvSocket`) — docs last substantively updated 2022-04:
  https://learn.microsoft.com/en-us/virtualization/api/hcs/overview ,
  https://learn.microsoft.com/en-us/virtualization/api/hcs/schemareference
- `hcsshim` (LCOW UVM config, `tar2ext4`, statistics; v0.15.0, 2026-10-15):
  https://github.com/microsoft/hcsshim
- Hyper-V sockets (AF_HYPERV; Linux `hv_sock`; guest-to-host, 16 KB MTU,
  GUID template, HKLM registration):
  https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/make-integration-service ,
  https://github.com/torvalds/linux/blob/master/net/vmw_vsock/hyperv_transport.c
- Docker VMM (beta): Docker's own VMM on WHP + VMP, per-user, x86_64:
  https://docs.docker.com/desktop/features/vmm/
- EFLOW (Linux VM on Windows Pro/Enterprise, AMD64 + ARM64) — updated 2026-03-02:
  https://learn.microsoft.com/en-us/azure/iot-edge/iot-edge-for-linux-on-windows
- Windows Sandbox (Pro+, one instance) — updated 2026-10-08:
  https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
- Smart App Control — updated 2026-10-06:
  https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview
- SmartScreen reputation (EV no longer bypasses) — updated 2026-08-17:
  https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Artifact Signing (price, regions, lead time) — updated 2026-10-08:
  https://learn.microsoft.com/en-us/azure/artifact-signing/overview
- Dev Drive / ReFS — updated 2026-06-01:
  https://learn.microsoft.com/en-us/windows/dev-drive/
- Windows 10 lifecycle (EOL 2025-10-14):
  https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro

**VMMs**
- OpenVMM guide (Windows x64/Aarch64 via WHP; Linux direct boot; virtio-fs,
  virtio-9p, virtio-net, VMBus; raw/VHDx; single exe; MIT):
  https://openvmm.dev/guide/user_guide/openvmm.html ,
  https://github.com/microsoft/openvmm
- OpenVMM virtio-vsock on KVM/MSHV/WHP (test matrix):
  https://github.com/microsoft/nvx/issues/84
- QEMU WHPX (prerequisites, x64 2004+, Arm64 24H2+, known issues):
  https://www.qemu.org/docs/master/system/whpx.html
- QEMU download (11.1.3, Oct 2026; Windows builds via Stefan Weil, unsigned):
  https://www.qemu.org/download/#windows , https://qemu.weilnetz.de/w64/
- QEMU Windows sharp edges: no vhost-user/vhost-kernel/9p (`meson.build`), no
  savevm/migrate (WHPX migration blocker), reboot hang, balloon wedge,
  parallel-VM host crash, ARM64 slowdown:
  https://gitlab.com/qemu-project/qemu/-/issues/3456 ,
  https://gitlab.com/qemu-project/qemu/-/issues/4410 ,
  https://gitlab.com/qemu-project/qemu/-/issues/4805 ,
  https://gitlab.com/qemu-project/qemu/-/issues/3460 ,
  https://gitlab.com/qemu-project/qemu/-/issues/4867
- CUA, *microVMs on Windows: QEMU on WHP with checkpoints, forks and warm
  pools* (PR and Windows results, 2026-11-07):
  https://github.com/trycua/cua/pull/6894
- crosvm hypervisors (WHPX untested upstream) and vsock (`/dev/vhost-vsock`):
  https://crosvm.dev/book/hypervisors.html ,
  https://crosvm.dev/book/devices/vsock.html

**Prior art / competitors**
- Docker Sandboxes (local microVM per agent, host proxy, credential injection,
  free local; Windows 11 x64 + WHP; per-user `winget` install; no Docker
  Desktop): https://docs.docker.com/ai/sandboxes/ ,
  https://docs.docker.com/ai/sandboxes/architecture/ ,
  https://docs.docker.com/ai/sandboxes/install/
- Claude Code sandbox environments (native Windows unsandboxed; WSL 2 /
  containers / VMs): https://code.claude.com/docs/en/sandbox-environments
- izba (Apache-2.0; CH/KVM incl. WSL 2; native Windows OpenVMM/WHP; Windows
  port design and bring-up findings):
  https://github.com/Lupus/izba ,
  https://github.com/Lupus/izba/blob/main/docs/superpowers/specs/2026-06-10-izba-windows-port-design.md
- Hyperlight (WHP microVMs, unmodified Linux binaries, ~3 ms restore) —
  CNCF, 2026-11-09:
  https://www.cncf.io/blog/2026/11/09/run-linux-applications-in-hypervisor-isolated-micro-vms-with-hyperlight/
- WSL containers (`wslc`):
  https://learn.microsoft.com/en-us/windows/wsl/tutorials/wsl-containers

**Field reports and benchmarks**
- Firecracker on WSL 2 without root (Debian 13, kernel 6.18, `/dev/kvm`,
  178.5 ms median ready, vsock half-close, `/dev/kvm` permissions, cgroup
  gotchas) — 2026-11-10:
  https://mko.run/firecracker-wsl2-rootless/
- WSL 2 nested virtualization support and the Oct 2026 AMD regression:
  https://github.com/microsoft/WSL/issues/41917 ,
  https://github.com/microsoft/WSL/issues/41968 ,
  https://github.com/microsoft/WSL/issues/41918
- WSL 2 ARM64 `/dev/kvm` unsupported (open since 2023):
  https://github.com/microsoft/WSL/issues/9794
- WSL 2 laptop reliability: hibernate BSOD, standby hang, freezes:
  https://github.com/microsoft/WSL/issues/41674 ,
  https://github.com/microsoft/WSL/issues/41936 ,
  https://github.com/microsoft/WSL/issues/41777 ,
  https://github.com/microsoft/WSL/issues/40745
- WSL cgroup v2 relocation and rootless Docker:
  https://github.com/microsoft/WSL/issues/41492
- Nested KVM / Firecracker fleet measurements (clone/restore and boot):
  https://plori.ai/blog/firecracker-sandboxes-nested-virtualization ,
  https://www.pandastack.ai/blog/firecracker-nested-virtualization-explained/

**Market**
- Stack Overflow Developer Survey 2025, operating systems:
  https://survey.stackoverflow.co/2025/technology#1-computer-operating-systems
- StatCounter via The Register, 2026-10-05 (Windows 11 71.5%, Windows 10
  27.77%):
  https://www.theregister.com/os-platforms/2026/10/05/windows-11-market-share-creeps-upwards-as-cost-of-staying-on-windows-10-set-to-double/5300870
- Windows on Arm penetration estimates (TrendForce-derived, 2026):
  https://zhichai.net/en/topic/177980931

**Code / local verification**
- `src/driver/types.ts`, `src/driver/agent.ts` (`hybridVsock`), `src/driver/vm.ts`,
  `src/driver/diskimages.ts`, `src/driver/kvm/index.ts`, `src/driver/vz/index.ts`,
  `guest/agent/`, `images/kernel/Dockerfile`, `images/disk/Dockerfile`,
  `src/net/proxy.ts`, `src/core/history.ts`, `src/config.ts`,
  `docs/research/14-intel-mac.md`.
- Local verification: `bun build --compile --target=bun-windows-x64` on Bun
  1.4.4 produced a PE32+ x86-64 executable (2026-11-13).
