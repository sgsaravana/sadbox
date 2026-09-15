# Mac mini deployment — containerized supervisor vs. native

> Follow-up to `02-deployment-portability.md`, prompted by the plan to push the
> supervisor image to ECR and run it on a Mac mini server. Recorded 2026-09-16.

## The question

Can the sadbox supervisor image (pushed to ECR, pulled on a Mac mini) create
worker microVMs while running inside a container on that Mac mini?

## Answer: no — run it natively on the Mac mini

A Mac mini runs macOS. Any container runtime there (Docker Desktop, OrbStack,
Apple `container`) runs Linux containers **inside a Linux VM**. That inner VM:

1. **Cannot reach the host's Virtualization.framework.** The supervisor's
   `container` driver shells out to Apple's `container` CLI, which talks to a
   host daemon using Virtualization.framework. A process inside the Linux VM
   has no channel to that host API — the CLI isn't there and XPC doesn't
   traverse the VM boundary.
2. **Cannot run its own microVMs instead**, because that needs nested
   virtualization: absent entirely on M1/M2, and not exposed as `/dev/kvm`
   inside Docker Desktop/OrbStack even on M3+ (`02-deployment-portability.md`).

So a containerized supervisor on the Mac mini gets a working web UI/API and a
dead **Create worker** button. Verified: the app image serves `/api/workers`
correctly from inside a container, but it has no route to spawn VMs there.

## What to do

- **Mac mini (the box with the workers): run the supervisor natively** — `bun
  run start`, ideally under a launchd plist for boot persistence. This is the
  only configuration where Apple `container` can create worker microVMs. The
  supervisor is a Bun process shelling out to `container`; there's no benefit
  to wrapping it in a container on the same host, only the fatal downside above.
- **Still push the ECR image.** It's the deployment artifact for the *Linux*
  path (a Linux server / EC2 with `/dev/kvm`) once the `kvm` (Cloud Hypervisor)
  driver is built, and it runs the UI/API anywhere for demos.

## Split-host option (future)

The clean way to get "supervisor in a container" AND "microVMs on the Mac
mini" is the control-plane / host-agent split already anticipated in
`02-deployment-portability.md`:

- **Host agent**: a small native process on the Mac mini exposing the
  `WorkerDriver` operations over a local socket / HTTP, driving Apple
  `container`.
- **Control plane**: the containerized supervisor (UI, API, SQLite, secrets),
  which calls the host agent instead of shelling out to `container` directly.

Not needed for a single Mac mini — native is simpler. It becomes worthwhile
when one control plane manages workers across several hosts.

## Bottom line

The ECR push is fine and useful; just don't *run* the pulled image on the Mac
mini expecting workers. On the Mac mini, native. The image is for Linux hosts
(pending the `kvm` driver) and for serving the UI.
