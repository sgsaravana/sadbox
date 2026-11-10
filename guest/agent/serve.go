package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func hello() map[string]any {
	var u unix.Utsname
	_ = unix.Uname(&u)
	return map[string]any{
		"agent": version, "protocol": protocolVersion,
		"pid1": os.Getpid() == 1, "uptimeMs": time.Since(started).Milliseconds(),
		"kernel": unix.ByteSliceToString(u.Release[:]), "machine": unix.ByteSliceToString(u.Machine[:]),
	}
}

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
		_ = c.sendJSON(fOK, hello())
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
	case "mount":
		if err := mountShare(req.Tag, req.Sub, req.Path, req.File); err != nil {
			c.fail(err)
			return
		}
		_ = c.sendJSON(fOK, map[string]any{})
	case "poweroff":
		_ = c.sendJSON(fOK, map[string]any{})
		c.Close()
		poweroff()
	default:
		c.fail(fmt.Errorf("unknown op %q", req.Op))
	}
}
