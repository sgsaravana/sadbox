//go:build linux

// sadbox-agent — Spike E's guest agent for Cloud Hypervisor VMs.
//
// Runs as the VM's init (PID 1): mounts the basics, brings up loopback, reaps
// orphans, and serves the host over vsock. It is the Linux twin of what Apple's
// vminitd does for `container exec`: run commands (captured or streamed, with
// or without a PTY) and splice a host connection onto a unix socket in the guest
// (the proxy's carriers). Outside PID 1 (local testing in any Linux box or
// container) it skips the init work and only serves, on TCP if asked.
//
// Protocol (one operation per connection), frames of [type u8][len u32 BE][payload]:
//   host → guest  0 request (JSON, first frame)   1 stdin   2 stdin EOF
//                 3 resize (JSON {cols,rows})      4 signal (1 byte)
//   guest → host  10 started (JSON {pid})   11 stdout   12 stderr
//                 13 exit (JSON {code,signal})   14 error (JSON {message})   15 ok (JSON)
// Requests: {"op":"ping"} → ok
//           {"op":"exec","argv":[…],"user":"agent","env":["K=V"],"cwd":"…","tty":{"cols":80,"rows":24}}
//           {"op":"connect","path":"/run/sadbox/proxy.sock"} → ok, then raw bytes both ways
//           {"op":"poweroff"} → ok, then the VM powers off
// Closing the connection before the process exits kills its process group.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"
)

const (
	fReq      = 0
	fStdin    = 1
	fStdinEOF = 2
	fResize   = 3
	fSignal   = 4
	fStarted  = 10
	fStdout   = 11
	fStderr   = 12
	fExit     = 13
	fError    = 14
	fOK       = 15

	maxFrame = 16 << 20
	// after the process exits, its output is read to the end — unless nothing
	// has arrived for this long (a background child can hold the pipe open
	// forever without writing)
	drainIdle = time.Second
)

var started = time.Now()

type winsize struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

type request struct {
	Op   string   `json:"op"`
	Argv []string `json:"argv"`
	User string   `json:"user"`
	Env  []string `json:"env"`
	Cwd  string   `json:"cwd"`
	TTY  *winsize `json:"tty"`
	Path string   `json:"path"`
}

// ---- framing ----
type conn struct {
	net.Conn
	r   *bufio.Reader
	wmu sync.Mutex
	// output progress: when a pump last read or sent, and whether one is
	// sending now (the host may be slow to take it)
	lastOutput atomic.Int64
	sending    atomic.Int32
}

func (c *conn) send(t byte, p []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	var h [5]byte
	h[0] = t
	binary.BigEndian.PutUint32(h[1:], uint32(len(p)))
	if _, err := c.Write(h[:]); err != nil {
		return err
	}
	_, err := c.Write(p)
	return err
}

func (c *conn) sendJSON(t byte, v any) error {
	b, _ := json.Marshal(v)
	return c.send(t, b)
}

func (c *conn) fail(err error) { _ = c.sendJSON(fError, map[string]string{"message": err.Error()}) }

func (c *conn) read() (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(c.r, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:])
	if n > maxFrame {
		return 0, nil, fmt.Errorf("frame too large: %d", n)
	}
	p := make([]byte, n)
	_, err := io.ReadFull(c.r, p)
	return h[0], p, err
}

// pump copies r to the host as frames of type t until EOF, then closes done.
func (c *conn) pump(t byte, r io.Reader, done chan<- struct{}) {
	defer close(done)
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		c.lastOutput.Store(time.Now().UnixNano())
		if n > 0 {
			c.sending.Add(1)
			serr := c.send(t, buf[:n])
			c.sending.Add(-1)
			c.lastOutput.Store(time.Now().UnixNano())
			if serr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// drain waits for every output to reach EOF, or to go idle for drainIdle.
func (c *conn) drain(outputs []chan struct{}) {
	for _, o := range outputs {
		for waiting := true; waiting; {
			select {
			case <-o:
				waiting = false
			case <-time.After(50 * time.Millisecond):
				idle := time.Since(time.Unix(0, c.lastOutput.Load()))
				if c.sending.Load() == 0 && idle > drainIdle {
					return
				}
			}
		}
	}
}

// ---- child processes: PID 1 reaps everything, so exits are routed here ----
var (
	reapMu  sync.Mutex
	waiters = map[int]chan unix.WaitStatus{}
)

func reaper() {
	sig := make(chan os.Signal, 128)
	signal.Notify(sig, unix.SIGCHLD)
	for range sig {
		for {
			var ws unix.WaitStatus
			pid, err := unix.Wait4(-1, &ws, unix.WNOHANG, nil)
			if pid <= 0 || err != nil {
				break
			}
			reapMu.Lock()
			if ch, ok := waiters[pid]; ok {
				ch <- ws
				delete(waiters, pid)
			}
			reapMu.Unlock()
		}
	}
}

// start runs fn (which starts a process) with the reaper held off, and returns
// the channel its exit status will arrive on.
func start(fn func() (int, error)) (int, chan unix.WaitStatus, error) {
	reapMu.Lock()
	defer reapMu.Unlock()
	pid, err := fn()
	if err != nil {
		return 0, nil, err
	}
	ch := make(chan unix.WaitStatus, 1)
	waiters[pid] = ch
	return pid, ch, nil
}

// ---- users and environment ----
type account struct {
	uid, gid uint32
	groups   []uint32
	home     string
	shell    string
	name     string
}

func lookupUser(name string) (*account, error) {
	u, err := user.Lookup(name)
	if err != nil {
		if u, err = user.LookupId(name); err != nil {
			return nil, err
		}
	}
	a := &account{name: u.Username, home: u.HomeDir, shell: "/bin/sh"}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	a.uid, a.gid = uint32(uid), uint32(gid)
	if ids, err := u.GroupIds(); err == nil {
		for _, g := range ids {
			if n, err := strconv.Atoi(g); err == nil {
				a.groups = append(a.groups, uint32(n))
			}
		}
	}
	if b, err := os.ReadFile("/etc/passwd"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Split(line, ":")
			if len(f) >= 7 && f[0] == a.name {
				a.shell = f[6]
			}
		}
	}
	return a, nil
}

// The image's Config (ENV, USER, WORKDIR), written by build-rootfs.sh:
// `docker export` keeps the files but not the image's settings.
type imageConfig struct {
	Env        []string `json:"Env"`
	User       string   `json:"User"`
	WorkingDir string   `json:"WorkingDir"`
}

func loadImageConfig() imageConfig {
	var c imageConfig
	if b, err := os.ReadFile("/etc/sadbox/image.json"); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if c.User == "" {
		c.User = "root"
	}
	return c
}

var image = loadImageConfig()

func environ(a *account, req *request) []string {
	env := map[string]string{"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	order := []string{"PATH"}
	set := func(kv string) {
		k, v, _ := strings.Cut(kv, "=")
		if _, ok := env[k]; !ok {
			order = append(order, k)
		}
		env[k] = v
	}
	for _, kv := range image.Env {
		set(kv)
	}
	for _, kv := range []string{"HOME=" + a.home, "USER=" + a.name, "LOGNAME=" + a.name, "SHELL=" + a.shell} {
		set(kv)
	}
	if req.TTY != nil {
		set("TERM=xterm-256color")
	}
	for _, kv := range req.Env {
		set(kv)
	}
	out := make([]string, 0, len(order))
	for _, k := range order {
		out = append(out, k+"="+env[k])
	}
	return out
}

func lookPath(file string, env []string) (string, error) {
	if strings.Contains(file, "/") {
		return file, nil
	}
	path := ""
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			path = kv[5:]
		}
	}
	for _, dir := range filepath.SplitList(path) {
		p := filepath.Join(dir, file)
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: not found in PATH", file)
}

// ---- operations ----
func serve(c *conn) {
	defer c.Close()
	t, p, err := c.read()
	if err != nil || t != fReq {
		return
	}
	var req request
	if err := json.Unmarshal(p, &req); err != nil {
		c.fail(err)
		return
	}
	switch req.Op {
	case "ping":
		var u unix.Utsname
		_ = unix.Uname(&u)
		_ = c.sendJSON(fOK, map[string]any{
			"pid1": os.Getpid() == 1, "uptimeMs": time.Since(started).Milliseconds(),
			"kernel": unix.ByteSliceToString(u.Release[:]), "machine": unix.ByteSliceToString(u.Machine[:]),
		})
	case "exec":
		execOp(c, &req)
	case "connect":
		up, err := net.Dial("unix", req.Path)
		if err != nil {
			c.fail(err)
			return
		}
		defer up.Close()
		if c.sendJSON(fOK, map[string]any{}) != nil {
			return
		}
		go func() { _, _ = io.Copy(up, c.r); _ = up.(*net.UnixConn).CloseWrite() }()
		_, _ = io.Copy(c, up)
	case "poweroff":
		_ = c.sendJSON(fOK, map[string]any{})
		c.Close()
		poweroff()
	default:
		c.fail(fmt.Errorf("unknown op %q", req.Op))
	}
}

func execOp(c *conn, req *request) {
	if len(req.Argv) == 0 {
		c.fail(errors.New("argv is empty"))
		return
	}
	name := req.User
	if name == "" {
		name = image.User
	}
	a, err := lookupUser(name)
	if err != nil {
		c.fail(fmt.Errorf("user %s: %w", name, err))
		return
	}
	env := environ(a, req)
	bin, err := lookPath(req.Argv[0], env)
	if err != nil {
		c.fail(err)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = a.home
		if name == image.User && image.WorkingDir != "" {
			cwd = image.WorkingDir
		}
	}
	attr := &syscall.SysProcAttr{Setsid: true}
	if a.uid != uint32(os.Getuid()) || os.Getuid() == 0 {
		attr.Credential = &syscall.Credential{Uid: a.uid, Gid: a.gid, Groups: a.groups}
	}

	var (
		stdin     io.WriteCloser // what the host's stdin frames go to
		ptmx      *os.File
		outputs   []chan struct{}
		childEnds []*os.File
	)
	files := make([]*os.File, 3)
	if req.TTY != nil {
		m, s, err := pty.Open()
		if err != nil {
			c.fail(err)
			return
		}
		_ = s.Chown(int(a.uid), int(a.gid))
		_ = pty.Setsize(m, &pty.Winsize{Cols: req.TTY.Cols, Rows: req.TTY.Rows})
		ptmx, stdin = m, m
		files[0], files[1], files[2] = s, s, s
		childEnds = []*os.File{s}
		attr.Setctty = true
		attr.Ctty = 0
	} else {
		inR, inW, _ := os.Pipe()
		outR, outW, _ := os.Pipe()
		errR, errW, _ := os.Pipe()
		stdin = inW
		files[0], files[1], files[2] = inR, outW, errW
		childEnds = []*os.File{inR, outW, errW}
		o, e := make(chan struct{}), make(chan struct{})
		outputs = []chan struct{}{o, e}
		defer outR.Close()
		defer errR.Close()
		go c.pump(fStdout, outR, o)
		go c.pump(fStderr, errR, e)
	}

	pid, exited, err := start(func() (int, error) {
		return syscall.ForkExec(bin, req.Argv, &syscall.ProcAttr{
			Dir: cwd, Env: env, Sys: attr,
			Files: []uintptr{files[0].Fd(), files[1].Fd(), files[2].Fd()},
		})
	})
	for _, f := range childEnds {
		f.Close()
	}
	if err != nil {
		stdin.Close()
		c.fail(fmt.Errorf("start %s: %w", bin, err))
		return
	}
	if ptmx != nil {
		o := make(chan struct{})
		outputs = []chan struct{}{o}
		go c.pump(fStdout, ptmx, o)
	}
	_ = c.sendJSON(fStarted, map[string]int{"pid": pid})

	// host → process
	hostGone := make(chan struct{})
	go func() {
		defer close(hostGone)
		for {
			t, p, err := c.read()
			if err != nil {
				return
			}
			switch t {
			case fStdin:
				_, _ = stdin.Write(p)
			case fStdinEOF:
				if ptmx == nil {
					stdin.Close()
				} else {
					_, _ = ptmx.Write([]byte{4}) // ^D
				}
			case fResize:
				var w winsize
				if ptmx != nil && json.Unmarshal(p, &w) == nil {
					_ = pty.Setsize(ptmx, &pty.Winsize{Cols: w.Cols, Rows: w.Rows})
				}
			case fSignal:
				if len(p) == 1 {
					_ = unix.Kill(-pid, unix.Signal(p[0]))
				}
			}
		}
	}()

	var ws unix.WaitStatus
	select {
	case ws = <-exited:
	case <-hostGone:
		// the host hung up: the process goes with it
		_ = unix.Kill(-pid, unix.SIGKILL)
		ws = <-exited
	}
	c.lastOutput.Store(time.Now().UnixNano()) // the idle clock starts at exit
	c.drain(outputs)
	if ptmx != nil {
		ptmx.Close()
	} else {
		stdin.Close()
	}
	code, sig := ws.ExitStatus(), 0
	if ws.Signaled() {
		sig = int(ws.Signal())
		code = 128 + sig
	}
	_ = c.sendJSON(fExit, map[string]int{"code": code, "signal": sig})
}

// ---- PID 1 ----
func must(what string, err error) {
	if err != nil && !errors.Is(err, unix.EBUSY) {
		log.Printf("init: %s: %v", what, err)
	}
}

func initSystem() {
	type m struct{ src, dst, fs, data string; flags uintptr; mode os.FileMode }
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

	host := "sadbox"
	if b, err := os.ReadFile("/proc/cmdline"); err == nil {
		for _, f := range strings.Fields(string(b)) {
			if v, ok := strings.CutPrefix(f, "sadbox.hostname="); ok {
				host = v
			}
		}
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

func poweroff() {
	if os.Getpid() != 1 {
		os.Exit(0)
	}
	_ = unix.Kill(-1, unix.SIGTERM)
	time.Sleep(time.Second)
	_ = unix.Kill(-1, unix.SIGKILL)
	unix.Sync()
	_ = unix.Reboot(unix.LINUX_REBOOT_CMD_POWER_OFF)
}

func main() {
	listen := flag.String("listen", "vsock:1024", "vsock:PORT or tcp:HOST:PORT")
	doInit := flag.String("init", "auto", "do init's work (mounts, loopback, hostname): auto = when PID 1, on, off")
	flag.Parse()
	log.SetFlags(log.Lmicroseconds)
	log.SetPrefix("sadbox-agent: ")

	if *doInit == "on" || (*doInit == "auto" && os.Getpid() == 1) {
		initSystem()
	}
	go reaper()

	var ln net.Listener
	var err error
	if p, ok := strings.CutPrefix(*listen, "vsock:"); ok {
		port, _ := strconv.Atoi(p)
		ln, err = vsock.Listen(uint32(port), nil)
	} else if a, ok := strings.CutPrefix(*listen, "tcp:"); ok {
		ln, err = net.Listen("tcp", a)
	} else {
		err = fmt.Errorf("bad -listen %q", *listen)
	}
	if err != nil {
		log.Printf("listen: %v", err)
		if os.Getpid() == 1 {
			select {} // PID 1 must not exit: the kernel would panic
		}
		os.Exit(1)
	}
	log.Printf("ready on %s after %s", *listen, time.Since(started).Round(time.Millisecond))
	for {
		nc, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go serve(&conn{Conn: nc, r: bufio.NewReader(nc)})
	}
}
