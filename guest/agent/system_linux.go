//go:build linux

package main

import (
	"errors"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"
)

// how long processes get to exit on SIGTERM before a shutdown kills them
const stopGrace = 2 * time.Second

func listenVsock(port uint32) (net.Listener, error) { return vsock.Listen(port, nil) }
func dialVsock(cid, port uint32) (net.Conn, error)  { return vsock.Dial(cid, port, nil) }

func kernelParams() map[string]string {
	b, _ := os.ReadFile("/proc/cmdline")
	return parseKernelParams(string(b))
}

func must(what string, err error) {
	if err != nil && !errors.Is(err, unix.EBUSY) {
		log.Printf("init: %s: %v", what, err)
	}
}

func initSystem() {
	type m struct {
		src, dst, fs, data string
		flags              uintptr
		mode               os.FileMode
	}
	for _, x := range []m{
		{"proc", "/proc", "proc", "", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, 0o555},
		{"sysfs", "/sys", "sysfs", "", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, 0o555},
		{"devtmpfs", "/dev", "devtmpfs", "mode=0755", unix.MS_NOSUID, 0o755},
		{"devpts", "/dev/pts", "devpts", "newinstance,ptmxmode=0666,mode=0620,gid=5", unix.MS_NOSUID | unix.MS_NOEXEC, 0o755},
		{"tmpfs", "/dev/shm", "tmpfs", "mode=1777", unix.MS_NOSUID | unix.MS_NODEV, 0o1777},
		{"tmpfs", "/run", "tmpfs", "mode=0755", unix.MS_NOSUID | unix.MS_NODEV, 0o755},
		{"tmpfs", "/tmp", "tmpfs", "mode=1777", unix.MS_NOSUID | unix.MS_NODEV, 0o1777},
		{"cgroup2", "/sys/fs/cgroup", "cgroup2", "", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, 0o555},
	} {
		_ = os.MkdirAll(x.dst, x.mode)
		must("mount "+x.dst, unix.Mount(x.src, x.dst, x.fs, x.flags, x.data))
	}
	_ = os.Remove("/dev/ptmx")
	must("ptmx", os.Symlink("pts/ptmx", "/dev/ptmx"))
	for name, target := range map[string]string{"/dev/fd": "/proc/self/fd", "/dev/stdin": "/proc/self/fd/0", "/dev/stdout": "/proc/self/fd/1", "/dev/stderr": "/proc/self/fd/2"} {
		_ = os.Symlink(target, name)
	}

	host := kernelParams()["hostname"]
	if host == "" {
		host = "sadbox"
	}
	must("hostname", unix.Sethostname([]byte(host)))
	if b, _ := os.ReadFile("/etc/hosts"); len(strings.TrimSpace(string(b))) == 0 {
		_ = os.WriteFile("/etc/hosts", []byte("127.0.0.1\tlocalhost "+host+"\n::1\tlocalhost ip6-localhost\n"), 0o644)
	}

	// loopback: apps listen on 127.0.0.1, and port forwards dial it
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, 0)
	if err == nil {
		ifr, _ := unix.NewIfreq("lo")
		if unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr) == nil {
			ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
			must("lo up", unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr))
		}
		unix.Close(fd)
	}

	// the host asks for a shutdown over vsock (poweroff); a signal works too
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, unix.SIGTERM, unix.SIGINT, unix.SIGPWR)
	go func() { <-sig; poweroff() }()
}

// poweroff: everything gets SIGTERM and up to stopGrace to exit (no longer
// than it takes), then SIGKILL; the disk is synced and the VM turned off.
func poweroff() {
	if os.Getpid() != 1 {
		os.Exit(0)
	}
	_ = unix.Kill(-1, unix.SIGTERM)
	for t0 := time.Now(); time.Since(t0) < stopGrace && othersRunning(); {
		time.Sleep(20 * time.Millisecond)
	}
	_ = unix.Kill(-1, unix.SIGKILL)
	unix.Sync()
	_ = unix.Reboot(unix.LINUX_REBOOT_CMD_POWER_OFF)
}

func othersRunning() bool {
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == 1 {
			continue
		}
		if b, err := os.ReadFile("/proc/" + e.Name() + "/stat"); err == nil && userProcess(string(b)) {
			return true
		}
	}
	return false
}
