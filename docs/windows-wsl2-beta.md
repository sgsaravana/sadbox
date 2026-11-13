# Windows (WSL 2) beta — release and test runbook

> For cutting a pre-release, installing it on a Windows 11 machine, and
> recording what works. The user-facing guide is
> [`windows-wsl2.md`](windows-wsl2.md); the design and alternatives are in
> [`research/16-windows.md`](research/16-windows.md).
>
> **Scope of this beta:** Windows 11 x64 + WSL 2 only. It is the ordinary
> Linux/KVM build inside WSL, plus WSL-aware path handling, doctor text and a
> small Windows launcher. It is **not** a native Windows VMM: Windows 10 and
> Windows on ARM64 have no nested KVM and are out of scope.

Use placeholders consistently below:

```text
VERSION   v0.6.0-beta.1
DISTRO    Ubuntu-24.04          (or the distro you test with)
REPO      sgsaravana/sadbox
```

`v0.6.0-beta.1` is a suggestion — any `vX.Y.Z-beta.N` works. The dash is what
makes GitHub publish it as a **pre-release**.

---

## 1. Cut the beta

### 1.1 Commit the branch

The branch is `feature/windows-wsl2`, based on `main` at v0.5.1. The changes are
currently in the working tree (the repo's rule is no commits without an explicit
instruction). Commit them on the feature branch:

```sh
git switch feature/windows-wsl2
git status                    # review: code, docs, workflows, tests
# do not add docs/TODO.md (untracked user work)
git add src docs/windows-wsl2.md docs/windows-wsl2-beta.md \
  docs/research/16-windows.md docs/research/README.md \
  README.md install.sh package.json web .github/workflows
git commit -m "feat(windows): WSL 2 support (beta)"
git push -u origin feature/windows-wsl2
```

Two ways to tag:

- **Recommended — merge to `main` first.** Open the PR from
  `feature/windows-wsl2` (the repo's `feature-to-main` workflow can create it),
  review, merge, then tag `main`. The beta then matches `main`.
- **Private beta from the branch.** Push the branch and tag that commit. The
  release workflow checks out the tag, so the artifact contains the branch code.
  `main` is not touched either way for a pre-release.

### 1.2 Tag and push

```sh
# from main (recommended), after merging:
git switch main
git pull
git tag v0.6.0-beta.1
git push origin v0.6.0-beta.1
```

Or, from the branch:

```sh
git switch feature/windows-wsl2
git tag v0.6.0-beta.1
git push origin v0.6.0-beta.1
```

The tag push triggers [`release.yml`](../.github/workflows/release.yml). It:

- stamps `VERSION` into `src/config.ts` and `package.json`;
- runs `bun run compile:all` (darwin/linux arm64+x64, plus
  `sadbox-windows-x64.exe`);
- creates a **pre-release** because the tag contains a dash;
- skips the `main` version/README/Homebrew bump for pre-releases.

### 1.3 Watch it and verify the assets

```sh
gh run watch
gh release view v0.6.0-beta.1
gh release view v0.6.0-beta.1 --json assets --jq '.assets[].name'
```

Expected assets:

```text
sadbox-darwin-arm64
sadbox-darwin-x64
sadbox-linux-arm64
sadbox-linux-x64
sadbox-windows-x64.exe
SHA256SUMS
```

If the run failed or the Windows asset is missing, re-run the workflow with the
tag as input (Actions → **release** → **Run workflow**), or:

```sh
gh workflow run release.yml -f tag=v0.6.0-beta.1
```

The workflow's skip check now waits for `sadbox-windows-x64.exe`, so a re-run
rebuilds if an earlier attempt only produced the POSIX binaries.

---

## 2. Prepare the Windows machine

### 2.1 Confirm the platform

In PowerShell:

```powershell
winver
systeminfo | findstr /C:"Hyper-V"
```

Requirements:

- **Windows 11 x64**, fully updated.
- Virtualization enabled in the firmware (VT-x/AMD-V; SLAT).
- ~15 GB free disk for WSL, Docker layers and VM disks.

Do **not** use Windows 10 or an ARM64 machine for this beta.

### 2.2 Enable WSL 2 and nested virtualization

In an **elevated** PowerShell:

```powershell
wsl --install
wsl --update
```

Reboot if prompted. Then create or edit `%UserProfile%\.wslconfig`:

```powershell
notepad $env:USERPROFILE\.wslconfig
```

```ini
[wsl2]
nestedVirtualization=true
memory=16GB
processors=8
```

Adjust `memory`/`processors` to leave room for Windows. Then:

```powershell
wsl --shutdown
```

Open the distro:

```powershell
wsl -l -v
wsl -d Ubuntu-24.04
```

Inside it:

```sh
uname -a
grep -i microsoft /proc/version
ls -l /dev/kvm
id
```

`/dev/kvm` **must exist** and be readable/writable by you. If it is missing,
stop and fix the `.wslconfig`/Windows update before installing sadbox. If it is
`permission denied`:

```sh
sudo usermod -aG kvm "$USER"
# then reopen the distro (from PowerShell: wsl --terminate Ubuntu-24.04)
```

### 2.3 Docker Engine with BuildKit

Inside the distro:

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# reopen the distro, or: newgrp docker
docker info
docker buildx version
```

Both must succeed. If you use Docker Desktop instead, enable its WSL
integration for this distro and still check `docker buildx version`. A
self-contained Docker Engine is the recommended test setup.

### 2.4 Basic tools

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
```

`openssl` and `virtiofsd` are checked by `sadbox doctor`; install them if the
distro does not have them:

```sh
sudo apt-get install -y openssl virtiofsd
```

`virtiofsd` is optional: without it, agent history stays in each VM.

---

## 3. Install and run the beta inside WSL

Use the **tag's** `install.sh` (not `main`), so the WSL-aware installer is the
one you test. Install into a separate bin/data pair so a stable install is not
clobbered:

```sh
VERSION=v0.6.0-beta.1

curl -fsSL "https://raw.githubusercontent.com/sgsaravana/sadbox/$VERSION/install.sh" \
  | SADBOX_VERSION="$VERSION" SADBOX_BIN_DIR="$HOME/.local/bin-beta" sh

export PATH="$HOME/.local/bin-beta:$PATH"
export SADBOX_DATA="$HOME/.sadbox-beta"

sadbox version        # must print 0.6.0-beta.1
sadbox doctor
```

`sadbox doctor` should show, among other lines:

```text
Windows: WSL 2, Ubuntu-24.04
✓ /dev/kvm (nested virtualization is on)
✓ docker with BuildKit
✓ openssl
```

Before `sadbox setup`, it is normal for Cloud Hypervisor and the VM disk to say
`✗ ... (fix: sadbox setup)`. The `data dir` must be under `/home/...`, **not**
`/mnt/c/...`.

Then build the VM image (a few minutes, once):

```sh
sadbox setup
```

Run `sadbox doctor` again; Cloud Hypervisor, its kernel and the VM disk should
now all be `✓`.

Finally:

```sh
sadbox serve
```

Open **http://localhost:7070** in Windows. The generated sign-in password is in
`~/.sadbox-beta/initial-password`; change it with `sadbox passwd`.

> Keep `SADBOX_DATA` and `PATH` set for every beta command in this shell. If
> you open a new shell, re-export them.

---

## 4. Test the Windows launcher

The beta also ships `sadbox-windows-x64.exe`. It is optional, but it is part of
what this beta is testing.

In PowerShell:

```powershell
$VERSION = "v0.6.0-beta.1"
$dir = "$env:USERPROFILE\sadbox-beta"
New-Item -ItemType Directory -Force $dir | Out-Null

curl.exe -fL "https://github.com/sgsaravana/sadbox/releases/download/$VERSION/sadbox-windows-x64.exe" -o "$dir\sadbox.exe"
curl.exe -fL "https://github.com/sgsaravana/sadbox/releases/download/$VERSION/SHA256SUMS" -o "$dir\SHA256SUMS"

Get-FileHash "$dir\sadbox.exe" -Algorithm SHA256
notepad "$dir\SHA256SUMS"     # compare the sadbox-windows-x64.exe line
```

The launcher is **unsigned**: SmartScreen may show "Windows protected your PC".
Use **More info → Run anyway**, or `Unblock-File "$dir\sadbox.exe"`. Only do
that for a build you verified against `SHA256SUMS`.

Point the launcher at the isolated beta (get the absolute Linux home first):

```powershell
wsl -d Ubuntu-24.04 -- sh -lc 'echo $HOME'
# e.g. /home/saravana

$env:SADBOX_WSL_DISTRO = "Ubuntu-24.04"
$env:SADBOX_WSL_BIN    = "/home/saravana/.local/bin-beta/sadbox"
$env:SADBOX_DATA       = "/home/saravana/.sadbox-beta"
$env:SADBOX_PORT       = "7070"

cd $dir
.\sadbox.exe doctor
.\sadbox.exe serve
```

`serve` opens the browser once `localhost:7070` answers. Stop a manually started
`sadbox serve` first, or the port is already in use.

If you installed the beta into `~/.local/bin` (no stable install), you can omit
`SADBOX_WSL_BIN`; the launcher puts `~/.local/bin` first.

---

## 5. Acceptance checklist

Record pass/fail and notes. A small repo on `C:\dev\...` is the best first
project; avoid OneDrive-redirected folders for the first run.

### Environment

- [ ] `sadbox version` prints the beta (`0.6.0-beta.1`).
- [ ] `sadbox doctor` shows WSL 2, `✓ /dev/kvm`, Docker, openssl.
- [ ] The data dir is under `/home`, not `/mnt/c`.
- [ ] `sadbox setup` completes and the base image is built.

### UI and project

- [ ] `http://localhost:7070` loads and sign-in works.
- [ ] Create a project from a **Windows folder**:
      Browse → **Windows (C:)** → `C:\dev\<repo>`; the input shows `C:\...`.
- [ ] The project reaches **running**; the detail view shows CPU/memory/disk.
- [ ] The project card shows the Windows path (`C:\dev\...`), not `/mnt/c/...`.

### Inside the VM

- [ ] Terminal opens; `uname -a` shows Linux; `tmux ls` shows `main`.
- [ ] `claude --version`, `omp --version`, `opencode --version` work.
- [ ] Editor opens a file, save works, and the git panel shows status.
- [ ] A command that needs a new host (e.g. `curl https://example.com`) shows
      the approval popup; **Allow** lets it through; the request log records it.

### Sync and ports

- [ ] Change a file in the VM, then **Sync back**; the file appears in
      `C:\dev\<repo>` and `git diff` there shows it.
- [ ] Change a file on Windows, then **Push to VM**; `cat` in the terminal
      shows the change.
- [ ] Start `python3 -m http.server 8000` in the VM, add a port forward
      host `8000` → guest `8000`, and open `http://localhost:8000` in Windows.
- [ ] Remove the forward.

### Lifecycle

- [ ] **Stop** then **Start**: files installed in the VM are still there.
- [ ] **Rebuild**: the VM comes back from the original source; vault access and
      agent history survive.
- [ ] Restart `sadbox serve` (Ctrl-C then again): projects reconnect.
- [ ] `wsl --shutdown` in PowerShell, reopen the distro, start `sadbox serve`:
      project disks persist and projects start again.
- [ ] `sadbox.exe doctor` and `sadbox.exe serve` work from Windows.

### Cleanup (after recording results)

- [ ] `sadbox service uninstall` if you installed a service.
- [ ] Remove `~/.local/bin-beta`, `~/.sadbox-beta` (or keep for follow-up).
- [ ] If this was a dedicated distro: `wsl --unregister <distro>`.
- [ ] Remove `%USERPROFILE%\sadbox-beta` and the `SADBOX_*` PowerShell variables.

---

## 6. If something fails, capture this

Paste the whole output, not a summary. On the Windows side:

```powershell
winver
wsl --version
wsl --status
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber
wsl -d Ubuntu-24.04 -- sh -lc 'uname -a; cat /proc/version; ls -l /dev/kvm; id; groups'
```

Inside WSL:

```sh
sadbox version
sadbox doctor
docker info                # last ~20 lines
docker buildx version
dmesg | grep -iE 'kvm|hyperv|svm|vmx' | tail -40
```

For a failed create/start:

```sh
sadbox doctor
ls -l ~/.sadbox-beta/kvm/vms/
# the project's VM folder:
cat ~/.sadbox-beta/kvm/vms/sadbox-<name>/ch.log
tail -50 ~/.sadbox-beta/kvm/vms/sadbox-<name>/console.log
```

For a UI/API failure:

```sh
curl -s http://localhost:7070/api/system/status
```

Also capture: a screenshot, the browser console/network tab, the CPU vendor
(Intel/AMD), the Windows build, and whether `wsl --shutdown` + retry changes the
result.

---

## 7. Known limitations and expected failures

- **Windows 10 / Windows on ARM64**: no `/dev/kvm`; not supported. Stop here.
- **AMD + the October 2026 Windows update**: nested virtualization was removed
  for ~2.5 weeks by one cumulative update; update Windows fully and check
  `svm` in `/proc/cpuinfo` and `modprobe kvm_amd`. If it is still missing, the
  host update is the fix.
- **OneDrive / `\\server\share`**: OneDrive-redirected folders and UNC paths
  are not good test workspaces. Use `C:\dev\...`.
- **`/mnt/c` performance**: git/tar on a Windows folder cross the WSL boundary.
  A small repo is fine; a large one is expected to be slower than a repo in
  `~/projects`.
- **Unsigned launcher**: SmartScreen warnings are expected until signing.
- **No one-click installer / dedicated distro image**: this beta installs with
  `install.sh` inside WSL; that is deliberate.
- **`sadbox service install`**: needs `systemd=true` in `/etc/wsl.conf`. If it
  fails, run `sadbox serve` manually for the beta.
- **`wsl --shutdown`, sleep/hibernate, Windows reboot**: running VMs stop; their
  disks persist. Start the projects again.
- **Beta version**: `sadbox version` shows the beta; `/releases/latest`, the
  Homebrew formula and `main` stay on stable.

---

## 8. After the beta

1. Record the checklist and logs in the release notes or an issue.
2. Fix blockers; cut `v0.6.0-beta.2` with the same steps.
3. When the checklist is green on Intel and AMD Windows 11, promote a stable
   `v0.6.0` (no dash). That tag **does** bump `main`, the README and the
   Homebrew formula.
4. Update [`research/16-windows.md`](research/16-windows.md)'s "As built"
   section with what the beta proved, and decide whether the native
   OpenVMM/WHP spike is next.

---

## Quick copy-paste (happy path)

```sh
# Inside WSL
VERSION=v0.6.0-beta.1
curl -fsSL "https://raw.githubusercontent.com/sgsaravana/sadbox/$VERSION/install.sh" \
  | SADBOX_VERSION="$VERSION" SADBOX_BIN_DIR="$HOME/.local/bin-beta" sh
export PATH="$HOME/.local/bin-beta:$PATH"
export SADBOX_DATA="$HOME/.sadbox-beta"
sadbox version && sadbox doctor && sadbox setup && sadbox serve
```
