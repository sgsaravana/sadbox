package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// One operation per connection. Frames are [type u8][length u32 BE][payload].
const (
	// host → guest
	fReq      = 0 // the request (JSON), always first
	fStdin    = 1
	fStdinEOF = 2
	fResize   = 3 // JSON {cols,rows}
	fSignal   = 4 // one byte

	// guest → host
	fStarted = 10 // JSON {pid}
	fStdout  = 11
	fStderr  = 12
	fExit    = 13 // JSON {code,signal}
	fError   = 14 // JSON {message}
	fOK      = 15 // JSON

	maxFrame = 16 << 20
	// after the process exits, its output is read to the end — unless nothing
	// has arrived for this long (a background child can hold the pipe open
	// forever without writing)
	drainIdle = time.Second
)

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
	// mount: a virtiofs share (Tag), and what of it (Sub, "" = all) goes at
	// Path; File when that is a single file
	Tag  string `json:"tag"`
	Sub  string `json:"sub"`
	File bool   `json:"file"`
}

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
	buf := make([]byte, 128<<10)
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
