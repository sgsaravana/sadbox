# sadbox — Requirements & Constraints

> Captured 2026-09-15 from the project owner's brief and clarifying answers.
> This is the reference point for all research docs in this folder.

## What we're building

A **supervisor** application that deploys and manages any number of **projects** —
microVMs running on the host machine — plus a web UI to operate them.

Working name: **sadbox** (sandbox for AI agents).

## Primary use case

**AI coding agent sandboxes.** Each project is an isolated VM in which Claude Code
(or a similar agent) works autonomously on a *copy* of a local repo. The user
watches and interacts through tmux, and pulls the results back to the host only
when satisfied. Isolation is the point: agent-generated code must not be able to
touch the original source folder or the host.

## Functional requirements

### Project lifecycle (per VM)
1. **Workdir copy-in** — a user-selected local folder (the *source folder*) is
   copied into the VM's home directory as `workdir`. A copy, not a live mount.
2. **App provisioning** — a user-selected set of apps is installed in the guest
   (examples given: curl, Bun, Claude Code, tmux).
3. **tmux access** — each project runs a tmux session the user can attach to.

### Supervisor web UI
1. **Inventory** — list all project instances and their state.
2. **Terminal** — a web view into each project's tmux instance. Each project's
   terminal must be openable in its **own browser tab** (the user works with
   multiple projects side by side).
3. **Secrets** — manage secrets assigned per project (API keys, tokens, .env
   values the agent inside needs).
4. **Sync-back** — on demand, sync the project's `workdir` back into the source
   folder on the host.

## Isolation model (hard constraint, clarified 2026-09-15)

- **Projects are microVMs, not shared-kernel containers.** Every project gets its
  own Linux kernel under a hardware hypervisor (Virtualization.framework on
  macOS, KVM on Linux). Docker/runc-style containers sharing the host (or a
  single helper VM's) kernel are **not** an acceptable substitute.
- Docker appears in the design in exactly two build/packaging roles, never as
  the project runtime: (a) OCI/Dockerfile as the *format* for building guest
  filesystem images; (b) docker-compose as *packaging* for the supervisor
  process itself on Linux hosts.
- The supervisor **wraps** an existing VM-lifecycle tool where a good one exists
  (Apple `container` CLI on macOS — one microVM per instance; Cloud
  Hypervisor's REST API on Linux) rather than reimplementing virtualization.

## Platform constraints

| Fact | Implication |
|---|---|
| Host today: macOS 26 (Tahoe), Apple **M1 Max**, arm64 | Firecracker/KVM impossible locally; must use Virtualization.framework-based tech (incl. Apple Containerization) |
| `kern.hv_support = 1` | Hypervisor.framework available |
| M1/M2 have **no nested virtualization** (M3+ only) | MicroVMs cannot run inside Docker Desktop/OrbStack's Linux VM on this machine — the macOS backend must run natively |
| Future goal: ship as a **docker-compose** app runnable anywhere (another Mac, Linux server, EC2) | Backend abstraction required; deployment story differs per platform (see `02-deployment-portability.md`) |

## Non-functional notes

- Single user (one developer), self-hosted. No multi-tenancy.
- Multiple projects run concurrently; creation should be fast enough to feel
  disposable.
- Secrets hygiene matters despite single-user: untrusted, agent-generated code
  executes inside projects.
- Tech stack: no preference stated — to be recommended by research
  (`07-supervisor-stack.md`).

## Vocabulary

> **Terminology note (2026-09-16):** a managed microVM instance is now called a
> **project** (previously "worker"). Code, API, and UI use "project"; research
> docs `01`–`09` predate the rename and still say "worker" — read them as
> synonymous. The base VM image is the **base image** (previously "worker image").

| Term | Meaning |
|---|---|
| **supervisor** | The main app: web UI + API + VM orchestration |
| **project** | One microVM instance managed by the supervisor (formerly "worker") |
| **source folder** | The original local folder chosen by the user |
| **workdir** | The copy of the source folder inside the project's home dir |
| **sync-back** | On-demand project→host sync of workdir into source folder |

## Research index

| Doc | Topic |
|---|---|
| `01-virtualization-backends.md` | MicroVM/VM tech per platform, driver abstraction |
| `02-deployment-portability.md` | docker-compose story on macOS / Linux / EC2 |
| `03-guest-image-provisioning.md` | Guest images, app install, boot, networking |
| `04-tmux-web-terminal.md` | Browser ⇄ tmux terminal architecture |
| `05-secrets-management.md` | Secret storage, injection, Claude Code auth |
| `06-workdir-sync.md` | Copy-in and on-demand sync-back mechanisms |
| `07-supervisor-stack.md` | Supervisor tech stack recommendation |
