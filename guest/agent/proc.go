package main

import (
	"strconv"
	"strings"
)

// parseKernelParams picks the sadbox.* settings off a kernel command line:
// "… sadbox.hostname=web sadbox.announce=1025" → {hostname: web, announce: 1025}.
func parseKernelParams(cmdline string) map[string]string {
	out := map[string]string{}
	for _, f := range strings.Fields(cmdline) {
		if kv, ok := strings.CutPrefix(f, "sadbox."); ok {
			if k, v, ok := strings.Cut(kv, "="); ok {
				out[k] = v
			}
		}
	}
	return out
}

// userProcess reads a /proc/PID/stat line: true for a live process, false for
// a zombie (the reaper is about to take it) or a kernel thread (signals do not
// reach those, and they do not keep anything from shutting down).
func userProcess(stat string) bool {
	i := strings.LastIndexByte(stat, ')') // the name may hold spaces and parentheses
	if i < 0 {
		return false
	}
	f := strings.Fields(stat[i+1:]) // state ppid pgrp session tty_nr tpgid flags …
	if len(f) < 7 || f[0] == "Z" || f[0] == "X" {
		return false
	}
	flags, _ := strconv.ParseUint(f[6], 10, 64)
	const pfKthread = 0x00200000
	return flags&pfKthread == 0
}
