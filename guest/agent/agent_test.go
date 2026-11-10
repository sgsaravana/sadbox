package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	go reaper()
	os.Exit(m.Run())
}

func TestParseKernelParams(t *testing.T) {
	got := parseKernelParams("console=hvc0 root=/dev/vda sadbox.hostname=web sadbox.announce=1025 sadbox.flag quiet\n")
	if got["hostname"] != "web" || got["announce"] != "1025" || len(got) != 2 {
		t.Fatalf("got %v", got)
	}
}

func TestUserProcess(t *testing.T) {
	for stat, want := range map[string]bool{
		"42 (bash) S 1 42 42 34816 42 4194560 1 0":        true,
		"43 (sleep) Z 42 42 42 0 -1 4194372 0 0":          false, // zombie
		"2 (kthreadd) S 0 0 0 0 -1 2129984 0 0":           false, // PF_KTHREAD
		"77 (my (weird) name) R 1 77 77 0 -1 4194304 0 0": true,
		"garbage": false,
	} {
		if got := userProcess(stat); got != want {
			t.Errorf("userProcess(%q) = %v, want %v", stat, got, want)
		}
	}
}

func TestEnviron(t *testing.T) {
	img := imageConfig{Env: []string{"PATH=/opt/bin:/usr/bin", "LANG=C.UTF-8"}}
	a := &account{name: "agent", home: "/home/agent", shell: "/bin/bash"}
	env := strings.Join(environ(img, a, &request{TTY: &winsize{80, 24}, Env: []string{"LANG=en_GB.UTF-8", "X=1"}}), "\n")
	for _, want := range []string{"PATH=/opt/bin:/usr/bin", "LANG=en_GB.UTF-8", "HOME=/home/agent", "USER=agent", "SHELL=/bin/bash", "TERM=xterm-256color", "X=1"} {
		if !strings.Contains(env+"\n", want+"\n") {
			t.Errorf("missing %s in\n%s", want, env)
		}
	}
	if strings.Contains(environ(img, a, &request{})[0], "TERM") {
		t.Error("TERM set without a tty")
	}
}

func TestLoadImageConfig(t *testing.T) {
	p := filepath.Join(t.TempDir(), "image.json")
	_ = os.WriteFile(p, []byte(`{"Env":["A=1"],"User":"agent","WorkingDir":"/w"}`), 0o644)
	if c := loadImageConfig(p); c.User != "agent" || c.WorkingDir != "/w" || c.Env[0] != "A=1" {
		t.Fatalf("got %+v", c)
	}
	// no file: commands run as the agent's own user
	if c := loadImageConfig(p + ".missing"); c.User == "" {
		t.Fatal("no default user")
	}
}

// ---- the server, in process, over a unix socket ----

// shortDir: unix socket paths are limited to ~104 bytes, and t.TempDir()'s
// are longer than that on macOS
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "sba")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func listenTest(t *testing.T) string {
	t.Helper()
	path := filepath.Join(shortDir(t), "a.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go serve(&conn{Conn: nc, r: bufio.NewReader(nc)})
		}
	}()
	return path
}

type client struct{ *conn }

func dialTest(t *testing.T, path string, req request) client {
	t.Helper()
	nc, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	_ = nc.SetDeadline(time.Now().Add(10 * time.Second))
	c := client{&conn{Conn: nc, r: bufio.NewReader(nc)}}
	if err := c.sendJSON(fReq, req); err != nil {
		t.Fatal(err)
	}
	return c
}

type outcome struct {
	stdout, stderr string
	code, signal   int
	err            string
}

func (c client) collect(t *testing.T) outcome {
	t.Helper()
	var o outcome
	var out, errb strings.Builder
	for {
		ft, p, err := c.read()
		if err != nil {
			t.Fatalf("read: %v (stdout so far %q)", err, out.String())
		}
		switch ft {
		case fStdout:
			out.Write(p)
		case fStderr:
			errb.Write(p)
		case fExit:
			var x struct{ Code, Signal int }
			_ = json.Unmarshal(p, &x)
			o.code, o.signal = x.Code, x.Signal
			o.stdout, o.stderr = out.String(), errb.String()
			return o
		case fError:
			var x struct{ Message string }
			_ = json.Unmarshal(p, &x)
			o.err = x.Message
			return o
		}
	}
}

func TestPing(t *testing.T) {
	c := dialTest(t, listenTest(t), request{Op: "ping"})
	ft, p, err := c.read()
	if err != nil || ft != fOK || !strings.Contains(string(p), `"protocol":1`) {
		t.Fatalf("%d %s %v", ft, p, err)
	}
}

func TestExec(t *testing.T) {
	path := listenTest(t)
	o := dialTest(t, path, request{Op: "exec", Argv: []string{"sh", "-c", "echo out; echo err >&2; exit 7"}}).collect(t)
	if o.stdout != "out\n" || o.stderr != "err\n" || o.code != 7 {
		t.Fatalf("%+v", o)
	}
	o = dialTest(t, path, request{Op: "exec", Argv: []string{"sh", "-c", "kill -TERM $$"}}).collect(t)
	if o.code != 143 || o.signal != 15 {
		t.Fatalf("%+v", o)
	}
	o = dialTest(t, path, request{Op: "exec", Argv: []string{"no-such-binary"}}).collect(t)
	if !strings.Contains(o.err, "not found") {
		t.Fatalf("%+v", o)
	}
	o = dialTest(t, path, request{Op: "exec", Argv: []string{"pwd"}, Cwd: "/", Env: []string{"X=y"}}).collect(t)
	if o.stdout != "/\n" {
		t.Fatalf("%+v", o)
	}
}

func TestExecStdin(t *testing.T) {
	c := dialTest(t, listenTest(t), request{Op: "exec", Argv: []string{"wc", "-c"}})
	chunk := make([]byte, 1<<20)
	for i := 0; i < 8; i++ {
		_ = c.send(fStdin, chunk)
	}
	_ = c.send(fStdinEOF, nil)
	if o := c.collect(t); strings.TrimSpace(o.stdout) != "8388608" {
		t.Fatalf("%+v", o)
	}
}

func TestExecBackgroundChildDoesNotHang(t *testing.T) {
	t0 := time.Now()
	o := dialTest(t, listenTest(t), request{Op: "exec", Argv: []string{"sh", "-c", "sleep 30 & echo started"}}).collect(t)
	if o.stdout != "started\n" || time.Since(t0) > 5*time.Second {
		t.Fatalf("%+v after %s", o, time.Since(t0))
	}
}

func TestTTY(t *testing.T) {
	c := dialTest(t, listenTest(t), request{Op: "exec", Argv: []string{"sh", "-c", "stty size; read x; echo got-$x; exit 3"}, TTY: &winsize{Cols: 100, Rows: 30}})
	var out strings.Builder
	sent := false
	for {
		ft, p, err := c.read()
		if err != nil {
			t.Fatalf("read: %v (%q)", err, out.String())
		}
		if ft == fStdout {
			out.Write(p)
			if !sent && strings.Contains(out.String(), "30 100") {
				sent = true
				_ = c.send(fStdin, []byte("hi\n"))
			}
		}
		if ft == fExit {
			var x struct{ Code int }
			_ = json.Unmarshal(p, &x)
			if x.Code != 3 || !strings.Contains(out.String(), "got-hi") {
				t.Fatalf("code %d, output %q", x.Code, out.String())
			}
			return
		}
	}
}

func TestConnect(t *testing.T) {
	sock := filepath.Join(shortDir(t), "echo.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			_, _ = io.Copy(c, c)
			c.Close()
		}
	}()
	c := dialTest(t, listenTest(t), request{Op: "connect", Path: sock})
	if ft, _, err := c.read(); err != nil || ft != fOK {
		t.Fatalf("%d %v", ft, err)
	}
	_, _ = c.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c.r, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("%q %v", buf, err)
	}
}
