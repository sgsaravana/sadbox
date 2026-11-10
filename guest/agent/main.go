// sadbox-agent — the guest agent in sadbox's Linux (Cloud Hypervisor) VMs.
//
// It runs as the VM's init (PID 1): mounts the basics, brings up loopback,
// reaps orphans, and serves the host over vsock. It is the Linux twin of what
// Apple's vminitd does for `container exec`: run commands (captured or
// streamed, with or without a PTY) and splice a host connection onto a unix
// socket in the guest (the proxy's carriers). See README.md for the protocol;
// src/driver/agent.ts is the host's side of it.
//
// Outside PID 1 (tests, or any Linux box or container) it skips the init work
// and only serves, on a unix or TCP socket if asked.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// version is stamped at build time: -ldflags "-X main.version=…"
var version = "dev"

// protocolVersion changes when the host and the agent stop understanding each
// other; the host reads it from ping and the ready announcement.
const protocolVersion = 1

var started = time.Now()

func main() {
	listen := flag.String("listen", "", "where to serve: vsock:PORT, unix:PATH or tcp:HOST:PORT (default: vsock:1024, or sadbox.listen=PORT on the kernel command line)")
	announce := flag.String("announce", "", "who to tell once serving: vsock:CID:PORT, unix:PATH or tcp:HOST:PORT (default: the host, CID 2, on sadbox.announce=PORT from the kernel command line)")
	doInit := flag.String("init", "auto", "do init's work (mounts, loopback, hostname): auto = when PID 1, on, off")
	flag.Parse()
	log.SetFlags(log.Lmicroseconds)
	log.SetPrefix("sadbox-agent: ")

	if *doInit == "on" || (*doInit == "auto" && os.Getpid() == 1) {
		initSystem()
	}
	params := kernelParams()
	if *listen == "" {
		*listen = "vsock:1024"
		if p := params["listen"]; p != "" {
			*listen = "vsock:" + p
		}
	}
	if *announce == "" && params["announce"] != "" {
		*announce = "vsock:2:" + params["announce"]
	}
	go reaper()

	ln, err := listenOn(*listen)
	if err != nil {
		log.Printf("listen: %v", err)
		if os.Getpid() == 1 {
			select {} // PID 1 must not exit: the kernel would panic
		}
		os.Exit(1)
	}
	log.Printf("%s ready on %s after %s", version, *listen, time.Since(started).Round(time.Millisecond))
	if *announce != "" {
		go announceReady(*announce)
	}
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

func listenOn(addr string) (net.Listener, error) {
	kind, rest, _ := strings.Cut(addr, ":")
	switch kind {
	case "vsock":
		port, err := strconv.ParseUint(rest, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("bad vsock port in %q", addr)
		}
		return listenVsock(uint32(port))
	case "unix":
		_ = os.Remove(rest)
		return net.Listen("unix", rest)
	case "tcp":
		return net.Listen("tcp", rest)
	}
	return nil, fmt.Errorf("bad address %q", addr)
}

func dialTo(addr string) (net.Conn, error) {
	kind, rest, _ := strings.Cut(addr, ":")
	switch kind {
	case "vsock":
		c, p, _ := strings.Cut(rest, ":")
		cid, err1 := strconv.ParseUint(c, 10, 32)
		port, err2 := strconv.ParseUint(p, 10, 32)
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("bad vsock address %q", addr)
		}
		return dialVsock(uint32(cid), uint32(port))
	case "unix", "tcp":
		return net.DialTimeout(kind, rest, 2*time.Second)
	}
	return nil, fmt.Errorf("bad address %q", addr)
}

// announceReady tells the host the agent is serving, so it need not poll: one
// ok frame carrying hello(), on a connection the agent opens. Retried for a
// few seconds, in case the host is not listening yet.
func announceReady(addr string) {
	var err error
	for i := 0; i < 50; i++ {
		var nc net.Conn
		if nc, err = dialTo(addr); err == nil {
			c := &conn{Conn: nc, r: bufio.NewReader(nc)}
			err = c.sendJSON(fOK, hello())
			nc.Close()
			if err == nil {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	log.Printf("announce to %s: %v", addr, err)
}
