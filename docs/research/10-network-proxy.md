# Network proxy — egress control for project VMs

> The supervisor is the network chokepoint for every project VM: all HTTP(S)
> egress flows through it so it can filter (allow/block), rewrite headers, and
> show a live request log on the detail view. Recorded 2026-09-16.

## Requirements (from the brief)

- Any incoming/outgoing request goes via the supervisor.
- Filter: allow / block requests.
- Add, remove, or update headers.
- A real-time list of requests in/out, on the VM detail page.
- **Block-by-default**: a request with no rule prompts for permission, with
  time-boxed answers — allow once / 1m / 5m / 30m / 60m / forever.
- Rules exist at **global** (all VMs) and **per-project** scope.

## Network model (Apple `container`)

Every VM sits on the `default` vmnet NAT network `192.168.64.0/24`; the host owns
the gateway `192.168.64.1` on `bridge100`. A guest can reach any port the host
binds there — verified: a guest `curl http://192.168.64.1:PORT` hits a
host-bound listener. So the supervisor runs a forward proxy on the gateway, and
each VM is pointed at it via `HTTP_PROXY`/`HTTPS_PROXY` (+ `NODE_EXTRA_CA_CERTS`,
`GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`), written to
`~/.sadbox/net.env` and sourced from `~/.bashrc`/`~/.profile` — the same
mechanism secrets use. Per-project attribution is by source IP: the proxy maps
`socket.remoteAddress` → project via `container list` addresses.

## MITM (TLS interception)

Almost all agent traffic is HTTPS, so "see paths / edit headers / filter" needs
TLS termination. A per-supervisor CA is generated once in the data dir and
installed into each VM's trust store at create (`update-ca-certificates` +
`NODE_EXTRA_CA_CERTS`). Per-host leaf certs are minted lazily (openssl,
async, cached) and signed by the CA, so the guest's clients see a valid chain
for whatever host they dial. Upstream, the proxy is a normal TLS client and
validates against real CAs.

## Decision flow

```
request (host, path, method) with source VM
  → block rule matches?  → 403 (logged "blocked")
  → allow rule matches (unexpired)? → forward (logged "allowed")
  → else ASK: hold the request, emit a pending approval to the detail view
       user answers Allow(once|1m|5m|30m|60m|forever) or Block
       timed/forever ⇒ persist a project rule (expires_at) so no re-prompt
       held request then completes or 403s; 120s timeout ⇒ deny
```

Block wins over allow. Concurrent requests to the same host coalesce into one
prompt and resolve together. Header rewrites (set/remove, request/response,
host-scoped) apply on the way through.

## Bun implementation gotchas (spiked before building)

Bun's Node compat has sharp edges for a MITM proxy — each of these cost a spike:

1. **`http.createServer().on('connect')` never fires.** Bun's http server does
   not emit the CONNECT event, so the classic forward-proxy shape is out. Use a
   raw `net.createServer`, read the first request line yourself, and branch on
   `CONNECT`.
2. **`server.emit('connection', socket)` does not drive Bun's HTTP/TLS parser.**
   Handing an already-accepted (or TLS-wrapped) socket to an `http`/`tls` server
   via `emit` parses nothing. You must feed a **real accepted connection** — so
   pipe the client socket through a loopback `net.connect` into a server that is
   actually `listen()`ing.
3. **`new tls.TLSSocket(sock, {isServer})` throws** (`socket.@end is not a
   function`) — upgrading a raw socket in place is broken. Terminate TLS with a
   real `https.createServer(...).listen()` instead, reached over the loopback.
4. **`https.createServer({SNICallback})` is broken** — the callback is never
   invoked and the handshake fails. Since CONNECT already tells us the host,
   stand up **one static-cert `https` server per host** (lazily, cached) and
   route the loopback to it.
5. **Never call `socket.resume()` by hand after CONNECT.** `.pipe()` resumes the
   source; a manual resume races ahead of the pipe and drops the client's TLS
   ClientHello, hanging the handshake.
6. **openssl must run async** (`Bun.spawn`, not `spawnSync`). A sync spawn blocks
   Bun's single event loop — including the handshake whose cert it is minting —
   and deadlocks. (This also silently broke every early spike whose test driver
   used `spawnSync("curl", …)`.)

Final shape that works:

```
guest tool ──HTTP(S)_PROXY──▶ net.createServer (host:7071)
   CONNECT host  ─▶ 200, pipe raw socket ─▶ loopback ─▶ https.createServer(host cert)
   GET http://…  ─▶            pipe raw socket ─▶ loopback ─▶ http.createServer
                                            │ decrypted request
                                   filter · header-rewrite · approve/hold · log
                                            ▼
                                 http(s).request upstream ─▶ real server
```

Loopback context (which client a decrypted connection belongs to) is threaded by
mapping the loopback connection's local port → `{scheme, clientIp, connectHost}`
and reading it back as `req.socket.remotePort` in the handler.

## Data & API

- `net_rules` (scope, project_id, action, host, path, method, expires_at, note)
- `net_header_rules` (scope, project_id, host, direction, op, header, value,
  value_secret_id) — a `set` value is a literal or resolved from a secret at
  proxy time (globals, or the rule's own project secret), so a real token is
  injected per-host without ever living in the VM.
- Live feed is in-memory (a per-project ring + a pub/sub); the detail view
  subscribes over SSE. Not persisted — it's a live monitor, resets on restart.
- Approvals are in-memory holds keyed by `projectId|host`, resolved by the UI.

## Not built yet

- **Transparent enforcement.** The proxy is cooperative (env-var based): it
  covers proxy-aware tooling (curl/git/bun/node/pip — everything the agent
  uses), but a program opening raw non-proxy sockets bypasses it. A guest
  nftables ruleset that forces all egress through the proxy port (and blocks the
  rest) is the follow-up for a hard boundary.
- **Ingress.** VMs have no public inbound on the NAT network; "incoming" today
  means the response half of egress (captured and logged). Port-forwarded
  inbound would be a separate feature.
