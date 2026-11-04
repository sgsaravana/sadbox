# Spike F — agent sessions and body swapping (step 0)

De-risks `docs/research/13-agent-sessions.md` (history mounts, login copy-in)
and the body swapping of `docs/research/12-vaults.md` (V3) before any code.

**Status (2026-11-03):** F.1 mounts **passed**, F.4 body swapping **passed**,
F.2 login copy-in **passed** for API-key logins, F.3 **failed for OAuth**:
a copied Claude login is revoked as soon as any copy refreshes. That changes
A4 / A5 of `docs/research/13` for OAuth logins — see F.3. F.5 (the supervisor
owns the login, the VM holds placeholders) **passed 2026-11-04** → A7.

## Files

| File | What |
|---|---|
| `body-swap.ts` | F.4, host only: a minimal buffering proxy between real clients and an echo server. `bun spikes/f-agent-sessions/body-swap.ts` |
| `oauth-owner.ts` | F.5: hand a project's Claude login to sadbox (as two proxy secrets), refresh it from sadbox, put placeholders in the VM. `take` / `place` / `refresh` / `status` / `drop <project>` — against the real data dir and the running supervisor. |

## F.1 — a host folder mounted into a VM (passed)

Run by hand on container 1.4.1: `container run -v <host dir>:/home/agent/mnt sadbox-base:latest`.

- Mounted as **virtiofs**, read-write.
- **Ownership maps cleanly both ways:** files on the host (uid 501) show as
  `agent` (uid 1000) in the VM; what the VM writes is owned by the host user.
  No chown step needed.
- **SQLite in WAL mode works** from the VM: 20 200 rows (one transaction plus
  200 single inserts) in 69 ms, `integrity_check` ok, readable from the host
  afterwards (`sqlite3`), still there after a stop / start.
- Atomic replace (`mv tmp creds.json`), `chmod 600`, directories and symlinks all
  behave as on a local disk.
- Only directories were mounted. Single files (omp's `history.db`, Claude's
  `history.jsonl`) will be **symlinked** from the tool's folder into the
  mounted one — to be confirmed with the real tools in F.2.

→ A2 (history mounted per project, single writer) holds.

## F.4 — swapping placeholders in request bodies (passed)

Placeholders are not as long as the real value, so a swapped body is buffered
(textual types only, ≤ 1 MiB) and sent on with a fresh `Content-Length`;
`Transfer-Encoding` and `Expect` are dropped on the upstream side.

| Case | Result |
|---|---|
| fetch, JSON, typed: `"limit": "<ph>"` → `50`, `"cfg": "<ph>"` → `{…}`, `"Bearer <ph>"` → spliced as text | pass |
| fetch with a streamed (chunked) body → re-sent with `Content-Length` | pass |
| `application/x-www-form-urlencoded` (value URL-encoded) | pass |
| `node:http`, chunked, `text/plain` | pass |
| curl with `Expect: 100-continue` | pass |
| binary body (`application/octet-stream`) passed through byte for byte | pass |

Gotchas:
- curl 8 only sends `Expect: 100-continue` for bodies over 1 MiB; the test forces it.
- In JSON, a placeholder that is the **whole** string takes the typed value; one
  inside a longer string is spliced in as escaped text.

→ V3 holds. Body swapping costs buffering of textual request bodies to bound
hosts only — streaming uploads and large or binary bodies are passed through.

## F.2 — a login copied into a fresh VM (passed)

Logins made in a throwaway project (`spike-login`, isolated, behind the proxy),
copied VM → VM through a host pipe (never stored on the host) into a fresh VM
(`spike-f2`, plain NAT network). A one-shot prompt per tool:

| Tool | Login | Copied | Result |
|---|---|---|---|
| Claude Code | Claude Max, OAuth (8 h access token + refresh token) | `~/.claude/.credentials.json` **only** | logged in, answered. `~/.claude.json` is not needed — Claude writes a fresh one. |
| omp | DeepSeek API key | the **rows of `auth_credentials` only**, into the fresh VM's own `agent.db` | logged in, answered. The rest of `agent.db` (settings, usage) stays per VM. |
| opencode | MiniMax API key | `~/.local/share/opencode/auth.json` **only** | login recognised (picked the MiniMax model), but MiniMax rejected the call — **the same in `spike-login` itself**, so the login is the problem, not the copy. |

## F.3 — what a refresh does to the other copies (failed for OAuth)

Claude, the one OAuth login: the copy in `spike-f2` was made to refresh
(its `expiresAt` set in the past). It got a **new access and refresh token**,
and the copy in `spike-login`:

- refreshing with the old refresh token → `OAuth token revoked`;
- using the old access token (expiry put back, so no refresh) → also
  `OAuth token revoked`.

**A refresh anywhere revokes every other copy, at once.** Claude refreshes
about every 8 h, so a login copied into several VMs breaks within hours. The
same is to be expected of any OAuth login that rotates (omp's Anthropic login
in `cash-compass` is one). API-key logins have no refresh and are unaffected.

Whether a running tool re-reads a replaced login file was not tested: for
OAuth the answer no longer matters (copies cannot work), for API keys nothing
changes under it.

### F.3b — can the supervisor own the login instead? (promising)

In `spike-f2`, `~/.claude/.credentials.json` was rewritten with **fake** tokens
(`sk-ant-oat01-sbx…`) and an expiry a year out, and `ANTHROPIC_BASE_URL`
pointed at a local listener:

- Claude did no local check of the token: it sent
  `Authorization: Bearer sk-ant-oat01-sbx…` on `POST /v1/messages`.
- Only after the (spike's) 401 did it try to refresh — with the fake refresh
  token, to the OAuth server, which failed.

So a VM can hold **placeholder** OAuth tokens with a far expiry, the proxy
swaps the placeholder for the supervisor's current real access token (as for
any proxy secret), and **the supervisor alone refreshes**. The VM never holds
the real login — the Vaults rule too. Not yet tested end to end through the
sadbox proxy, nor what to do with a refresh a VM attempts anyway (block it,
or answer it with placeholders).

## F.5 — the supervisor owns the login, end to end (passed)

`spike-login` (isolated, all traffic through the sadbox proxy), after a fresh
Claude login there. `oauth-owner.ts take` moved the real access and refresh
token into sadbox as proxy secrets (access bound to `api.anthropic.com`,
`Authorization` header) and wrote the VM's `.credentials.json` with their
placeholders and an expiry ten years out.

1. **The VM uses a login it cannot read.** `claude -p` answered. Every
   request Claude made to `api.anthropic.com` (`/v1/messages`, `/api/oauth/…`,
   bootstrap, event logging) had the placeholder swapped for the real token.
   Claude talks to no other host with it (one Datadog log call, no token, was
   blocked by the rules).
2. **A refresh the VM starts on its own** (its copy made to look expired) goes
   to `POST platform.claude.com/v1/oauth/token`, the placeholder refresh token
   in the **JSON body** → 400 from the server (today's proxy only swaps
   headers). Harmless to the real login — but Claude then **clears the tokens
   in its login file**, logging the VM out. So the proxy must answer that
   request itself (A7), not let it through.
3. **The supervisor refreshes alone**: `POST platform.claude.com/v1/oauth/token`
   with `{grant_type: "refresh_token", refresh_token, client_id}` (client id and
   URL read from the `claude` binary) → new access token, **rotated refresh
   token**, `expires_in` 28 800 s; response fields `token_type, access_token,
   expires_in, refresh_token, scope, token_uuid, refresh_token_expires_in,
   organization, account`.
4. **The VM carries on unchanged**: same placeholders in the VM, sadbox
   swapping in the new real token — `claude -p` answered again.

Not run, as it follows from the design: a second VM. Every VM gets its own
placeholders, all swapped for the one real token sadbox holds, so a refresh
no longer revokes anyone.

What A7 still needs that F.5 did not build: the proxy answering a VM's
`/v1/oauth/token` call (from sadbox's own refresh, with placeholders back),
one refresh at a time, refreshing ahead of expiry, and redacting tokens in
token-endpoint response bodies.

## Side effects

- `spike-login`'s first Claude login was revoked by F.3. Its omp and opencode
  logins are untouched. `spike-f2` was destroyed with the one live copy.
- After F.5 the spike secrets were dropped: sadbox holds no Claude token, and
  `spike-login`'s login file holds placeholders only — Claude there needs a
  fresh login. The real login of F.5 was not revoked; it lapses on its own.
