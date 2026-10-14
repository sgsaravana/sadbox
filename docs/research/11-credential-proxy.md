# Credential proxy — real secrets never enter the VM

> A secret can be delivered **via the proxy** instead of into the VM. The VM's
> env file gets a *placeholder*; the supervisor's MITM proxy swaps the
> placeholder for the real value on the way out, only toward destinations the
> secret is bound to, and swaps real values back to placeholders in response
> headers. Recorded 2026-10-14. This is option (e) of `05-secrets-management.md`,
> which deferred it; the MITM proxy from `10-network-proxy.md` makes it cheap now.

## Why

Today a secret is written in plain text to `~/.sadbox/env` in the guest
(`src/core/secrets.ts`). Anything the agent can run can read it and send it
out — through an allowed host, a commit message, a pasted log. No in-VM
delivery method can hide a value from the agent that uses it (`research/05`).
With proxy delivery, the strongest thing an agent can steal is a placeholder,
which is worthless outside this VM and outside the bound hosts.

## Requirements (from the brief)

- The VM sees a dummy value (`GITHUB_TOKEN=ghp_sbx…`) in its env / `.env`.
- The proxy matches outgoing requests by **pattern or exact match** and puts the
  real token into the header before the request leaves the supervisor.
- Response headers carrying a real token are rewritten back to the dummy value.
- The real secret lives only in the supervisor.

## What already exists

| Piece | Where | Reused as |
|---|---|---|
| TLS interception for every VM request | `src/net/proxy.ts` | where substitution happens |
| VMs have no NIC; the proxy is the only way out | `src/net/guest.ts` | means substitution can't be bypassed |
| Request / response header hooks | `proxy.ts:193`, `proxy.ts:204` (`applyHeaders`) | where to insert the substitution step |
| Header rules that `set` a header from a secret | `net_header_rules.value_secret_id` | still useful when the client sends no header at all |
| Host matching (`exact`, `*.suffix`, `*`) + path globs | `src/net/rules.ts` | binding matcher |
| Time-boxed approvals | `src/net/approvals.ts` | prompt for an unbound placeholder |

The new parts: placeholders, bindings, value-based substitution (including
inside `Basic` auth), response redaction, and the UI around them.

## Design

### Data model

```sql
ALTER TABLE secrets ADD COLUMN delivery TEXT NOT NULL DEFAULT 'env';  -- 'env' | 'proxy'

-- stable per (project, secret): survives restarts/rebuilds, differs per VM
CREATE TABLE secret_placeholders (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  secret_id   TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  placeholder TEXT NOT NULL UNIQUE,
  PRIMARY KEY (project_id, secret_id)
);

-- where the real value is allowed to go
CREATE TABLE secret_bindings (
  id        TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  host      TEXT NOT NULL,   -- exact, *.suffix (same matcher as net_rules)
  path      TEXT,            -- exact or prefix* (NULL = any)
  method    TEXT,            -- NULL = any
  header    TEXT,            -- NULL = any header; e.g. 'authorization'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Per-project placeholders mean a placeholder copied out of VM A does nothing
when sent from VM B: the proxy only substitutes placeholders that belong to the
source project.

### Placeholder format

Format-preserving, so clients that sniff the prefix or length still accept it:
keep the token's recognisable prefix (`ghp_`, `github_pat_`, `sk-ant-oat01-`,
`sk-ant-api03-`, `sk-`, `xoxb-`…), fill the rest with random characters from
the same alphabet and to the same length, with a fixed `sbx` marker after the
prefix so placeholders are greppable and can't collide with real tokens.
Unknown formats fall back to `sadbox-ph-<32 random>`. The spike decides
whether the marker breaks any client and how to handle checksummed tokens
(GitHub's last 6 characters are a CRC32).

### Request path (after the allow/block verdict, before `applyHeaders`)

```
for each request header:
  value contains a placeholder P of this project?   (also inside base64 of
                                                     "Authorization: Basic …")
    no  → leave it
    yes → secret S = owner of P
          scheme is https and a binding of S matches (host, path, method, header)?
            yes → replace P with S's real value; log "injected S"
            no  → ASK (approval prompt: "send S to <host>?" once/1m/…/forever,
                  forever ⇒ new binding), timeout/deny ⇒ 403
then applyHeaders(request)   — existing set/remove rules still run
```

- **Plain HTTP never gets a real value.** Substitution only happens on TLS-intercepted requests.
- **Logged values are always placeholders.** The request log records which
  secret names were injected (a 🔑 badge), never values.
- **Real value only in memory.** Decrypted when a request needs it; no
  long-lived plaintext cache, or a short TTL one if the spike shows decrypt cost matters.
- **Rotation is instant.** The VM only knows the placeholder, so updating the
  value takes effect on the next request; no env re-injection.

### Response path

Before `res.writeHead`, scan every response header for the real value of any
proxy-delivered secret of this project (and its Basic-encoded form) and replace
it with the project's placeholder. Then the existing `applyHeaders(response)` runs.

**Bodies are not redacted in v1.** An endpoint that echoes request headers into
its body (e.g. `httpbin.org/headers`) would return the real value. Mitigations:
bindings are narrow, so a token only goes to its own API, and real APIs don't
echo auth. A streaming body redactor (decompress, rolling window of
`len(secret)-1` bytes, text content types only) is a follow-up, scoped by what
the spike finds.

### Env file

`injectSecrets` writes `NAME='<placeholder>'` for `delivery='proxy'` secrets
instead of the decrypted value. Optional: a "write `.env` into workdir"
action that writes the same placeholder lines, for apps that read `.env`
directly.

### UI

- Secret form: **Delivery: In VM / Via proxy (placeholder)**. With "via proxy",
  set **bindings** (host + optional path/method/header), with presets for
  common services (GitHub → `api.github.com`, `github.com`, `*.githubusercontent.com`;
  Anthropic → `api.anthropic.com`; OpenAI → `api.openai.com`).
- The project's secret list shows the placeholder (copyable) for proxy secrets.
- The request log shows 🔑 `GITHUB_TOKEN` on rows where a value was injected.
- Unbound placeholder → approval card "*project* wants to send **GITHUB_TOKEN** to
  `evil.example`" with the usual allow once/1m/5m/30m/60m/forever and block.

### Threat model

| Protects against | Does not protect against |
|---|---|
| Exfiltration of the token string (env dump, logs, commits, pastes) | The agent *using* the credential against a bound host (confused deputy). Narrow bindings (path/method) and least-privilege tokens limit it |
| Reuse of a leaked placeholder from elsewhere or another VM | Response bodies that echo request headers (see above) |
| Sending the real value to an unapproved host | APIs that mint new credentials from the bound one (e.g. OAuth refresh, token-creation endpoints). These return real secrets in bodies |
| Sending a real value over plain HTTP | |

## Open questions → Spike D

1. Do common clients accept a placeholder token (prefix/length/checksum checks)?
2. Exactly which headers and encodings carry the token per client (Bearer, `token`, `Basic`, `x-api-key`, query string)?
3. Does any client cache, transform, or hash the token locally in a way substitution can't follow?
4. Does Claude Code authenticate with `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` placeholders end to end (including streaming)?
5. Do any responses from real APIs carry the token back in headers or bodies?

See [`spikes/d-credential-proxy/`](../../spikes/d-credential-proxy/README.md).

## Build plan (after the spike)

1. **Schema + model**: `delivery`, `secret_placeholders`, `secret_bindings`; placeholder generator.
2. **Proxy**: substitution (incl. Basic), unbound → approval, response redaction, 🔑 logging.
3. **Delivery**: env file writes placeholders; optional workdir `.env` writer.
4. **API + UI**: delivery toggle, bindings editor + presets, placeholder display, log badge, approval card.
5. **Tests**: unit (matcher, Basic round-trip, redaction, cross-project placeholder refused,
   plain-HTTP refused); proxy integration in `src/net/proxy.test.ts`.
6. **Docs**: README (Secrets + Known limitations), `research/05` §(e) marked built.
