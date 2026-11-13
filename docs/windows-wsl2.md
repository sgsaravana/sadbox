# sadbox on Windows (WSL 2)

> **Status: beta, 2026-11-13.** Windows 11 x64 only. sadbox itself is the
> ordinary Linux/KVM build; WSL 2 supplies the Linux host and `/dev/kvm`.
> Windows 10 and Windows on ARM64 have no nested KVM and are not supported.
> The path translation, WSL detection, git settings and doctor text are
> unit-tested; the end-to-end run on a real Windows 11 + WSL 2 host is the next
> step. Cutting and testing a pre-release:
> [`windows-wsl2-beta.md`](windows-wsl2-beta.md).
> Design background and alternatives: [`docs/research/16-windows.md`](research/16-windows.md).

## What you need

- **Windows 11 x64**, fully updated.
- **WSL 2** with **nested virtualization** on. This is what gives the distro
  `/dev/kvm`; without it sadbox cannot boot a VM.
- **Docker Engine with BuildKit inside WSL** (not Docker Desktop required). It
  builds the VM image and the guest kernel.
- ~10 GB free for the base image and VM disks, more for projects.
- Admin rights **once**, to enable WSL/virtualization. After that, sadbox and
  its VMs run as your user.

Not supported: Windows 10 (nested virtualization is Windows 11 only), Windows
on ARM64 (WSL starts at EL1 and has no `/dev/kvm`), and Windows Server.

## 1. Enable WSL 2 and nested virtualization (once)

In an **elevated PowerShell**:

```powershell
wsl --install
```

Reboot if it asks. Then make nested virtualization explicit (the default has
changed before) — create or edit `%UserProfile%\.wslconfig`:

```ini
[wsl2]
nestedVirtualization=true
memory=16GB
processors=8
```

Adjust `memory`/`processors` to leave room for Windows. Then, in PowerShell:

```powershell
wsl --shutdown
```

Open your distro (Ubuntu from the Store, or the dedicated `sadbox` distro) and
check:

```sh
ls -l /dev/kvm
```

If that file exists and is readable/writable by you, you are ready. If not, see
[Troubleshooting](#troubleshooting).

## 2. Install sadbox inside the distro

Run this **inside WSL**, not in PowerShell:

```sh
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh
```

The installer detects WSL and checks `/dev/kvm`, Docker, `git` and `openssl`.
Then:

```sh
sadbox setup     # fetches Cloud Hypervisor + kernel, builds the VM image (a few minutes)
sadbox serve     # http://localhost:7070
```

Open **http://localhost:7070** in your Windows browser. WSL forwards
`localhost` to Windows by default. The first start prints a sign-in password;
it is also in `~/.sadbox/initial-password`. Change it with `sadbox passwd`.

### Docker inside WSL

Use **Docker Engine in the distro** (the installer expects the `docker` and
`docker buildx` commands):

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-buildx-plugin
sudo usermod -aG docker "$USER"
# reopen the distro (or `newgrp docker`), then:
docker info
```

If you already use Docker Desktop, its WSL integration can provide the socket,
but a self-contained Docker Engine is the recommended setup for a dedicated
`sadbox` distro.

## 3. Create a project from a Windows folder

In the create form, **Browse…** now shows:

- **Windows (C:)**, **Windows (D:)**, … — your Windows drives through
  `/mnt/c`, `/mnt/d`;
- **WSL home** — the fast Linux filesystem.

Both work. The picker shows Windows paths (`C:\Users\me\repo`) and sends the
WSL form (`/mnt/c/Users/me/repo`) to the supervisor. You can also paste either
form into the folder field.

**Performance tip:** keep large repositories in the WSL filesystem
(`~/projects/...`) if you can, or clone from a git remote inside the VM. A
Windows folder works, but every git/tar operation crosses the WSL boundary.
For a repo on `/mnt/c`, sadbox automatically tells host git to ignore file
modes and line-ending conversion so sync-back does not report spurious
changes. If **Windows** git then reports every file as modified, set it there
too:

```powershell
git config core.autocrlf false
```

## 4. Run it at logon (optional)

`systemd` in WSL makes this clean. In the distro, edit `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Then restart WSL (`wsl --shutdown`) and install the service:

```sh
sadbox service install     # a systemd user unit; needs systemd in WSL
```

To start it when you sign in to Windows, the simplest option is a **Startup
shortcut** to the launcher:

```text
sadbox-windows-x64.exe serve
```

The launcher opens a login shell with `~/.local/bin` on `PATH`, so it finds a
binary installed by `install.sh`. A **Task Scheduler** task at logon can do the
same explicitly:

```text
wsl.exe -d <distro> -u <user> -- sh -lc "PATH=$HOME/.local/bin:$PATH exec sadbox serve"
```

There is no Windows "boot" trigger for WSL 2; the distro starts when something
runs in it.

## Troubleshooting

### `/dev/kvm` is missing

1. Check `%UserProfile%\.wslconfig` contains:
   ```ini
   [wsl2]
   nestedVirtualization=true
   ```
2. Run `wsl --shutdown` in PowerShell, then reopen the distro.
3. Confirm Windows is **11 x64** and virtualization is on in the firmware.
4. Run `sadbox doctor`; it prints the WSL-specific fix.

On **AMD** machines, a Windows cumulative update in October 2026 silently
removed nested virtualization for about two weeks. Update Windows fully; if
`svm` is absent from `/proc/cpuinfo` and `modprobe kvm_amd` fails, the host
update is the fix.

### `/dev/kvm` is "permission denied"

Add yourself to the `kvm` group and reopen the distro:

```sh
sudo usermod -aG kvm "$USER"
```

WSL has no seat/udev session, so avoid ACLs; the group is the durable fix.

### `sadbox` says the data dir is on a Windows drive

Unix sockets, file modes and sparse disks need the Linux filesystem. Keep
`SADBOX_DATA` (default `~/.sadbox`) inside the distro:

```sh
export SADBOX_DATA="$HOME/.sadbox"
```

### The browser cannot reach `localhost:7070`

- Make sure `sadbox serve` is still running in the distro.
- Check `.wslconfig` has `localhostForwarding=true` (the default) and you are
  not in `networkingMode=mirrored` with a firewall rule blocking it.
- In mirrored mode, use `127.0.0.1` explicitly.
- If Windows asked to allow a Hyper-V/WSL firewall rule on first start, allow
  it for the private network.
- As a fallback, bind the WSL side to all interfaces:
  `SADBOX_HOST=0.0.0.0 sadbox serve` (it is still behind WSL's NAT).

### VMs stop after sleep, hibernate, or `wsl --shutdown`

WSL 2 is a VM; Windows can pause or restart it. Project **disks** persist, and
the supervisor reconciles state on restart. If the backend wedges after resume,
run `wsl --shutdown` and start `sadbox serve` again. This is a known WSL
laptop behaviour, not a lost project.

### The distro is using too much memory

Set `memory=` in `.wslconfig`, and consider
`[experimental] autoMemoryReclaim=gradual`. Each project VM's memory is real;
size projects with **Settings → default VM memory** or per-project.

## Updating and uninstalling

Update sadbox inside the distro the same way you installed it:

```sh
curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh
```

Your projects, vault and agent history stay in `~/.sadbox`. To remove
everything, uninstall the service (`sadbox service uninstall`), remove the
binary and `~/.sadbox`, then unregister the distro in PowerShell:

```powershell
wsl --unregister <distro>
```

## Security notes

- The egress proxy's CA is installed **only in the guest VM's trust store**,
  never in Windows. Windows traffic is not intercepted.
- VMs have **no network interface**; all egress goes through the supervisor's
  proxy, with block-by-default rules and approvals.
- The UI listens on WSL's `localhost` and is forwarded to Windows
  `localhost`; it is not exposed to the LAN unless you configure Windows
  portproxy/mirrored networking deliberately.
- `SADBOX_PASSWORD` / `sadbox passwd` work the same as on Linux.

## Known limitations (beta)

- Windows 11 x64 only; no Windows 10, no ARM64.
- WSL 2 is an extra virtualization layer; expect somewhat slower I/O than a
  native Linux host. Keep VM/state on the distro's ext4, not `/mnt/c`.
- The folder picker translates drive paths; **UNC** paths (`\\server\share`)
  are not mounted by WSL and are refused with a message.
- `sadbox service install` needs systemd enabled in WSL.
- Windows sleep/hibernate can restart WSL; VMs stop but their disks persist.
- A Windows launcher (`sadbox-windows-x64.exe`, in the release assets) can run
  `serve`/`setup`/`doctor` in WSL and open the browser, but there is no
  one-click installer or dedicated distro image yet: install the Linux binary
  inside WSL first. `sadbox.exe` picks `SADBOX_WSL_DISTRO`, else the `sadbox`
  distro, else the first WSL distro.
