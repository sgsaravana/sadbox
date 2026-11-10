package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

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
	name, _, _ = strings.Cut(name, ":") // USER may be user:group
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

// The image's Config (ENV, USER, WORKDIR): turning an image into a disk keeps
// its files but not these, so the image pipeline writes them here.
type imageConfig struct {
	Env        []string `json:"Env"`
	User       string   `json:"User"`
	WorkingDir string   `json:"WorkingDir"`
}

const imageConfigPath = "/etc/sadbox/image.json"

func loadImageConfig(path string) imageConfig {
	var c imageConfig
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if c.User == "" {
		// no USER: whoever the agent runs as (root, as init)
		c.User = strconv.Itoa(os.Getuid())
	}
	return c
}

var image = loadImageConfig(imageConfigPath)

func environ(img imageConfig, a *account, req *request) []string {
	env := map[string]string{"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	order := []string{"PATH"}
	set := func(kv string) {
		k, v, _ := strings.Cut(kv, "=")
		if _, ok := env[k]; !ok {
			order = append(order, k)
		}
		env[k] = v
	}
	for _, kv := range img.Env {
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
	return "", fmt.Errorf("%s: not found", file)
}

// ---- exec ----
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
	env := environ(image, a, req)
	bin, err := lookPath(req.Argv[0], env)
	if err != nil {
		c.fail(err)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = a.home
		if img, _ := lookupUser(image.User); img != nil && img.uid == a.uid && image.WorkingDir != "" {
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
