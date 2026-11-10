//go:build linux

package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unsafe"

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

	growRoot()

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

// growRoot: the host makes a project's disk bigger than the image's filesystem
// (a sparse file, so it costs nothing until used); grow the filesystem to fill
// it. ext4 grows online, mounted.
func growRoot() {
	dev := "vda"
	cmdline, _ := os.ReadFile("/proc/cmdline")
	for _, f := range strings.Fields(string(cmdline)) {
		if v, ok := strings.CutPrefix(f, "root=/dev/"); ok {
			dev = v
		}
	}
	b, err := os.ReadFile("/sys/class/block/" + dev + "/size")
	if err != nil {
		return
	}
	sectors, _ := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	var st unix.Statfs_t
	if unix.Statfs("/", &st) != nil || st.Bsize <= 0 {
		return
	}
	blocks := sectors * 512 / uint64(st.Bsize)
	if blocks <= st.Blocks+st.Blocks/50 { // f_blocks leaves out ext4's overhead: within 2% is full size
		return
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return
	}
	defer unix.Close(fd)
	const ext4IocResizeFs = 0x40086610 // _IOW('f', 16, __u64)
	if _, _, e := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), ext4IocResizeFs, uintptr(unsafe.Pointer(&blocks))); e != 0 {
		log.Printf("init: grow /: %v", e)
		return
	}
	log.Printf("init: / grown to %d MB", blocks*uint64(st.Bsize)>>20)
}

// mountShare puts a virtiofs share (or a file or folder in it) at path. Each
// share is mounted once under /run/sadbox/fs and bind-mounted from there.
func mountShare(tag, sub, path string, file bool) error {
	if tag == "" || !filepath.IsAbs(path) || strings.Contains(tag, "/") {
		return fmt.Errorf("bad mount %q → %q", tag, path)
	}
	base := "/run/sadbox/fs/" + tag
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	var st unix.Statfs_t
	if unix.Statfs(base, &st) != nil || st.Type != unix.FUSE_SUPER_MAGIC {
		if err := unix.Mount(tag, base, "virtiofs", 0, ""); err != nil && !errors.Is(err, unix.EBUSY) {
			return fmt.Errorf("mount share %s: %w", tag, err)
		}
	}
	src := filepath.Join(base, filepath.Clean("/"+sub))
	if file {
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		if f, err := os.OpenFile(path, os.O_CREATE|os.O_RDONLY, 0o644); err == nil {
			f.Close()
		}
	} else if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(src, path, "", unix.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind %s → %s: %w", src, path, err)
	}
	return nil
}
