//go:build !linux

package main

import (
	"errors"
	"log"
	"net"
	"os"
)

// Not Linux: the agent runs only as a server here (tests), never as init.

var errNoVsock = errors.New("vsock is Linux-only")

func listenVsock(uint32) (net.Listener, error)   { return nil, errNoVsock }
func dialVsock(uint32, uint32) (net.Conn, error) { return nil, errNoVsock }
func kernelParams() map[string]string            { return nil }
func initSystem()                                { log.Printf("init: skipped (not Linux)") }
func poweroff()                                  { os.Exit(0) }
