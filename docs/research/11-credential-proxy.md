# Credential proxy — real secrets never enter the VM

> **Status: built 2026-10-14** on `feature/proxy-credentials` (C1–C5); real-token
> round 2 pending before merge.
>
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

## Spike D results (2026-10-14)

Host smoke test + VM round 1 passed; details in
[`spikes/d-credential-proxy/`](../../spikes/d-credential-proxy/README.md).
Decisions it settles:

| Question | Answer |
|---|---|
| Do clients accept placeholders? | Yes. curl, git, gh, Claude Code (OAuth + API key), Bun `fetch` and Python `requests` all send them without any local format check, including a generic `sadbox-ph-…` and a `ghp_` with a bad checksum |
| Placeholder format | **Variant (a)**: prefix + `sbx` + random, same length and alphabet |
| Encodings to handle | Literal substring (covers Bearer, `token`, `x-api-key`) + `Basic` decode/re-encode (git). **No query-string substitution in v1**: detect and log only |
| Where credentials go | Claude Code: only `api.anthropic.com`, but 8+ paths. gh: REST + GraphQL on `api.github.com`. git: `github.com`. Bindings are host-level by default; path/method narrowing is optional |
| Local persistence | None observed (gh keeps no `hosts.yml` with `GH_TOKEN`; nothing in `~/.claude*`) |
| Overhead | 50–500 µs per request |
| Response redaction | Header redaction works; body echo leaks, as designed for v1 |

Still open: **round 2** with real short-lived tokens, to confirm upstream 200s
end to end and check real API responses for echoed credentials. It doesn't
block C1–C3, but should run before C2 merges.

## Build plan

Branch `feature/proxy-credentials`. Each phase is a reviewable commit with tests.

### C1 — Schema + secret model (`src/db.ts`, `src/core/secrets.ts`) ✓ done 2026-10-14
- `secrets.delivery TEXT NOT NULL DEFAULT 'env'` (add-column check like the
  existing `projects` columns in `db.ts`); `secret_placeholders`,
  `secret_bindings` tables as above, `ON DELETE CASCADE` from `secrets`.
- `src/core/placeholders.ts`: generator (variant (a), from the spike's
  `placeholder.ts`), `placeholderFor(projectId, secretId)` that creates on first
  use and is stable after, and purge on project destroy (`purgeProjectSecrets`).
- Secret create/update API accepts `delivery` and `bindings[]`; validation:
  `proxy` requires ≥ 1 binding; hosts go through the same `normalizeHost`.
- Secret values stay write-only. A secret's placeholder is readable (it's not sensitive).
- Tests: placeholder stability/uniqueness, per-project difference, cascade on secret delete, purge on project destroy.

### C2 — Proxy substitution (`src/net/credentials.ts`, `src/net/proxy.ts`) ✓ done 2026-10-14
Verified three ways: unit tests (`src/net/credentials.test.ts`), the host
end-to-end script `spikes/d-credential-proxy/e2e.ts` (10 checks against
httpbin), and a throwaway VM running curl, git, Claude Code and an approval
answered over the API. Approval cards in `web/` show credential asks (🔑, the
secret's name; Block refuses that request only, never a host rule). The
request-log chip is still C4.
- `credentials.ts` = productionised `subst.ts`: load this project's
  placeholders → `{placeholder → secretId}` (cache, invalidated on secret/binding change);
  `substituteRequest(projectId, scheme, host, path, method, headers)` and
  `redactResponse(projectId, headers)`; decrypt only on a hit.
- Hook at the two spike points: after the verdict, before `applyHeaders`.
- **Unbound placeholder → approval**: extend `approvals.ts` with a `kind:
  "credential"` (secret name + host). Allow once/1m…/forever. Timed/forever
  answers create a `secret_bindings` row (with `expires_at`, so add that
  column). Block → 403 `sadbox: GITHUB_TOKEN is not allowed to <host>`.
- Plain HTTP with a placeholder → 403 with that reason (fail loudly rather than
  send a placeholder that just 401s).
- Placeholder in the URL → logged on the row (`credentialInUrl`), not substituted.
- `RequestEntry` gets `credentials?: string[]` (secret names injected) and
  `redacted?: string[]`. Never values.
- Tests: port the 13 spike unit tests; integration tests against a local TLS
  upstream (the proxy CA, a stub project like `smoke.ts`), covering bound /
  unbound-ask / plain-http / Basic / response-redaction / cross-project placeholder.

### C3 — Delivery (`src/core/secrets.ts`)
- ~~`injectSecrets` writes the placeholder for `delivery='proxy'` secrets.~~ Done in C1,
  so a proxy secret can never put its real value in a VM, even before C2 lands.
- Switching a secret between `env` ⇄ `proxy` re-injects every dependent project.
- Updating a proxy secret's value needs **no** re-injection (next request uses it).
- Optional action: write the project's placeholder lines into `~/workdir/.env`
  (append/replace only sadbox-managed keys, never clobber the user's file).

### C4 — UI (`web/index.html`, `web/app.js`, `web/net-asks.js`, `web/style.css`) ✓ done 2026-10-14
Checked in headless Chrome against a throwaway VM (create via form + preset,
add/remove bindings, bad-binding error, project-dialog placeholder + copy, log
chips, credential approval card). Bindings are entered as `host[/path*]` with
an optional method; header narrowing stays API-only. A credential approval
defaults to a 5-minute window, never "forever".
- Secret form: **Delivery** toggle (In VM / Via proxy) + bindings editor
  (host, optional path/method/header) with presets: GitHub
  (`api.github.com`, `github.com`, `uploads.github.com`), Anthropic
  (`api.anthropic.com`), OpenAI (`api.openai.com`).
- Secret lists show a "via proxy" badge and, per project, the copyable placeholder.
- Request log: 🔑 `NAME` chip on injected rows, ⚠ on redacted or in-URL rows.
- Approval card for `kind: "credential"`: "*project* wants to send
  **GITHUB_TOKEN** to `host`".

### C5 — Docs + cleanup ✓ done 2026-10-14
The spike harness was retired entirely (not only `proxy.patch`); round 2 now
runs against the built feature. C3's two unbuilt items (switching delivery on
an existing secret, which needs a secret-update API, and the workdir `.env`
writer) moved to the ROADMAP backlog (6a, 6b).
- README: Secrets section (delivery modes, bindings, what's protected and
  what's not), Known limitations (response bodies, query strings, OAuth refresh flows).
- `research/05` §(e) → built; ROADMAP: credential proxy → Shipped.
- Delete `spikes/d-credential-proxy/proxy.patch` (keep the README as the record).

### Deliberately out of v1
- Response **body** redaction (backlog item; streaming + gzip work).
- Query-string and request-body substitution.
- Credential minting/refresh flows (OAuth refresh tokens, token-creation APIs).
