# sadbox-agent

The guest agent in sadbox's Linux VMs (Cloud Hypervisor on KVM), from
[Spike E](../../spikes/e-cloud-hypervisor/README.md). It is the VM's init
(PID 1), and the host's only way in: it runs commands and terminals, and
connects the host to unix sockets in the guest. Its host side is
[`src/driver/agent.ts`](../../src/driver/agent.ts). The macOS driver doesn't use
it; Apple's `vminitd` does that job there.

It's a static Go binary of about 3 MB. As init, it mounts `/proc`, `/sys`,
`/dev`, `/dev/pts`, `/dev/shm`, `/run`, `/tmp` and cgroup2, sets the hostname,
brings up loopback, reaps orphans, and serves on vsock.

## Settings

| Kernel command line | Flag | |
|---|---|---|
| `sadbox.listen=PORT` | `-listen vsock:PORT \| unix:PATH \| tcp:HOST:PORT` | Where to serve. Default: vsock port 1024. |
| `sadbox.announce=PORT` | `-announce vsock:CID:PORT \| unix:PATH \| tcp:HOST:PORT` | Who to tell once serving. The kernel setting means the host (CID 2) on that port; under CH it arrives at the unix socket `<vsock socket>_PORT`. |
| `sadbox.hostname=NAME` | | The hostname. Default: `sadbox`. |
| | `-init auto \| on \| off` | Do init's work. `auto` means only when running as PID 1. |

`/etc/sadbox/image.json` holds the image's `{Env, User, WorkingDir}`. Turning
an image into a disk keeps its files but not these settings. Commands run as
`User` by default (or the agent's own user, if none is set), in
`WorkingDir`, with `Env` plus HOME, USER, LOGNAME and SHELL (and TERM when
there's a terminal).

## Protocol (version 1)

Each connection carries one operation. Frames are
`[type u8][length u32 BE][payload]`, and the request is always the first frame.

| Direction | Frame types |
|---|---|
| host → guest | `0` request (JSON) · `1` stdin · `2` stdin EOF · `3` resize `{cols,rows}` · `4` signal (1 byte, to the process group) |
| guest → host | `10` started `{pid}` · `11` stdout · `12` stderr · `13` exit `{code,signal}` · `14` error `{message}` · `15` ok (JSON) |

| Request | Answer |
|---|---|
| `{"op":"ping"}` | ok `{agent, protocol, pid1, uptimeMs, kernel, machine}` |
| `{"op":"exec","argv":[…],"user":"…","env":["K=V"],"cwd":"…","tty":{"cols":80,"rows":24}}` | started, then output, then exit (or an error if the command never started) |
| `{"op":"connect","path":"/run/…/x.sock"}` | ok, then raw bytes both ways |
| `{"op":"poweroff"}` | ok; then everything gets SIGTERM and up to 2 s to exit, the disk is synced and the VM turned off |

How `exec` behaves:
- Every field except `argv` is optional.
- The command runs in its own session.
- With `tty`, stdout carries the terminal's output, and stdin EOF is sent as ^D.
- If the host hangs up before the command exits, its process group is killed.
- After the exit, output is read until EOF or until it has been idle for 1 s,
  so a background child holding the pipe doesn't stall it.
- A signal kills the command with exit code 128 + n, as a shell reports it.

The ready announcement is one ok frame with the same body as `ping`, sent on
a connection the agent opens. The agent retries it for 5 s.

On Cloud Hypervisor the host reaches the guest's vsock through a unix socket:
it writes `CONNECT 1024\n`, reads `OK <n>\n`, and then the frames follow.
CH can accept a `CONNECT` before the guest is listening and never answer it,
so the host gives up on each attempt after a short wait (`hybridVsock`'s
`handshakeMs`). Or it waits for the announcement and doesn't poll at all.

## Building and testing

```sh
cd guest/agent
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w -X main.version=…" -o out/sadbox-agent .
go test ./...                      # also builds and runs on macOS: only the init and vsock parts are Linux-only
bun test src/driver/agent.test.ts  # (from the repo root) the host's client against the real agent, on a unix socket
```

CI: `.github/workflows/guest-agent.yml` runs these on Linux and macOS, and
`spike-e.yml` boots the agent under Cloud Hypervisor on KVM.
