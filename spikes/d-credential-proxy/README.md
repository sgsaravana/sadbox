# Spike D — credential proxy (placeholders swapped on the wire)

De-risks `docs/research/11-credential-proxy.md` before any schema or UI work:
can a VM hold only placeholder tokens while real clients (git, gh, Claude Code,
SDKs) keep working, because the supervisor's proxy swaps placeholder → real on
the way out and real → placeholder in response headers?

**Status:** host smoke test and VM round 1 (all major clients, dummy real
values) **passed 2026-10-14**, and the feature was then built (C1–C5,
`docs/research/11`). Round 2 (real tokens, upstream 200s) not run yet: it now
runs against the built feature, no patch. Findings below.

## Files

| File | What |
|---|---|
| `e2e.ts` | Host-only end-to-end run of the **built** credential proxy against httpbin.org with dummy tokens: bound / Basic / plain-http / approval deny + allow / redaction / in-URL; and since vault step 3 (2026-11-04) URL and body swapping, typed values, and body redaction (plain, gzip, streamed) — 16 checks, all passing. Because response bodies are redacted now, "sent upstream" is shown by the log recording a redaction of httpbin's echo. `bun spikes/d-credential-proxy/e2e.ts` |

The spike-only harness (a `proxy.patch` hook, the standalone swap `subst.ts`
and its tests, `smoke.ts`, the placeholder printer and map-file helper) was
retired once the feature was built. It lives in git history (`15f3c09`) and
its results are recorded below. Its swap logic became `src/net/credentials.ts`
and its placeholder generator became `src/core/placeholders.ts`.

## Setup (round 1, as run)

Round 1 used a throwaway supervisor with the patch applied
(`SADBOX_SPIKE_SUBST=<map.json>`), secrets created with their **placeholder**
as the value so the normal env file carried only placeholders, and `[spike-d]`
lines on stdout reporting `injected=` / `UNBOUND=` / `REFUSED-plain-http=` /
`IN-URL=` / `redacted=`. Use a short `SADBOX_DATA` (e.g. `/tmp/sbxd`): a long
path overflows the unix-socket path limit.

## Experiments

### 1. Client acceptance matrix

For each client, with the placeholder in the env var it normally reads, record:
**accepted locally?**, **header + encoding seen at the proxy**, **real call succeeded after swap?**

| Client | Env var | Call |
|---|---|---|
| curl | `$GITHUB_TOKEN` in `-H "Authorization: Bearer …"` | `GET api.github.com/user` |
| git (https, credential helper from env) | `GITHUB_TOKEN` | `git ls-remote`, `git push` to the private test repo |
| gh | `GH_TOKEN` | `gh api user`, `gh pr list` |
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | `claude -p "say hi"` and an interactive streaming session |
| Claude Code | `ANTHROPIC_API_KEY` | same |
| Anthropic SDK (Bun / Node / Python) | `ANTHROPIC_API_KEY` | one streaming message |
| OpenAI SDK (optional) | `OPENAI_API_KEY` | one call |
| Bun `fetch` / Node `fetch` / Python `requests` | any | bearer GET |

Placeholder variants to try per client:
- (a) prefix kept + same length + `sbx` marker
- (b) prefix kept + same length, no marker
- (c) generic `sadbox-ph-<32>`

For `ghp_` tokens, also check whether anything validates the CRC32 tail.

### 2. Encodings

Confirm what the matcher must cover: `Bearer`, `token`, `Basic base64(user:token)`
(git), `x-api-key`, and any client that puts a key in the **query string**
(decide whether v1 needs query substitution).

### 3. Response redaction

- `httpbin.org/response-headers?X-Echo=<placeholder>` → after the swap upstream
  the header holds the real value; verify the VM sees the placeholder.
- `httpbin.org/headers` (body echo) → document that the body leaks the real
  value (expected; v1 limitation). Measure whether a simple streaming body
  redactor is worth it.
- Inspect real responses from GitHub / Anthropic for any auth echo in headers or bodies.

### 4. Robustness

- Keep-alive: several requests on one TLS connection, each substituted.
- Streaming: Anthropic SSE and `git push` packfile upload unaffected.
- Overhead: per-request latency with and without substitution (header scan + decrypt).
- Placeholder sent to an **unbound** host (`https://example.com` with the GitHub
  placeholder) → must arrive as the placeholder (and later: trigger an approval).
- Plain `http://` request carrying a placeholder → never substituted.

### 5. Local leakage of the placeholder

Where do clients persist the token inside the VM (`~/.config/gh/hosts.yml`,
`~/.claude/…`, git credential store)? Persisting a placeholder is harmless.
The question is whether any client then refuses it later (e.g. a stored-token
format check on next start).

## Exit criteria

- git, gh and Claude Code work end to end with placeholder-only env.
- A placeholder format is chosen that every tested client accepts.
- The list of encodings the matcher must handle is final (and whether query-string substitution is in v1).
- Response-header redaction verified; body-echo risk documented with a recommendation.
- Findings and a measured table written up here; `docs/research/11` updated with the decisions.

## Findings

### Host smoke test (`smoke.ts`, 2026-10-14) — all passed

| Check | Result |
|---|---|
| Bearer placeholder → real on a bound host | ✓ |
| git-style `Basic base64(x-access-token:…)` swapped | ✓ |
| Placeholder of a secret bound elsewhere left alone (logged `UNBOUND`) | ✓ |
| Plain `http://` never swapped (logged `REFUSED-plain-http`) | ✓ |
| Real value in a response header comes back as the placeholder | ✓ |
| Body echo (`httpbin.org/headers`) returns the real value | leaks, as expected (v1 limitation) |
| Swap cost per request | ~40–170 µs (first call ~0.9 ms, JSON load) |

The hook sits after the allow/block verdict and before the existing header
rules, so blocked requests never reach the swap, and `set` header rules still
override it.

### VM experiments, round 1: placeholders + dummy "real" values (2026-10-14)

A throwaway supervisor (`SADBOX_DATA=/tmp/sbxd`, ports 17070/17071, patch
applied) with one network-less project VM. Four project secrets created
through the normal API **with their placeholder as the value**, so the VM's
`~/.sadbox/env` held only placeholders. The map's "real" values were dummies,
so upstreams answer 401. What's measured is whether each client sends the
placeholder, where, how it is encoded, and whether the proxy swapped it. Exact
bytes on the wire after the swap were verified by the host smoke test
(httpbin echo).

Note: `SADBOX_DATA` under the session scratchpad is too long for a unix socket
path. Use a short path.

| # | Client | Env var | Header / encoding seen | Swapped? |
|---|---|---|---|---|
| 1 | curl | `GITHUB_TOKEN` | `authorization` Bearer | ✓ |
| 4 | curl, 3 requests on one connection | `GITHUB_TOKEN` | `authorization` `token` | ✓ each request |
| 5 | git ls-remote via credential helper | `GITHUB_TOKEN` | `authorization` **Basic** (after 401 challenge) | ✓ (decoded, swapped, re-encoded) |
| 6 | Bun `fetch` | `GITHUB_TOKEN` | `authorization` Bearer | ✓ |
| 7 | curl, fine-grained `github_pat_` | `GH_TOKEN` | `authorization` Bearer | ✓ |
| 8 | Claude Code 2.1.272, OAuth | `CLAUDE_CODE_OAUTH_TOKEN` | `authorization` Bearer, on `/v1/messages`, `/api/claude_cli/bootstrap`, `/api/claude_code/{settings,policy_limits}`, `/api/eval/…` | ✓ |
| 9 | Claude Code, API key | `ANTHROPIC_API_KEY` | `x-api-key` raw, same endpoints + `/api/event_logging/v2/batch`, `/api/claude_code_penguin_mode`, `…/metrics_enabled` | ✓ |
| 10 | gh 2.46 | `GH_TOKEN` | `authorization` `token`, REST + `/graphql` | ✓ |
| 12 | gh | `GITHUB_TOKEN` (no `GH_TOKEN`) | `authorization` `token` | ✓ |
| 13 | Python `requests` 2.32 | `GITHUB_TOKEN` | `authorization` Bearer | ✓ |

| Edge case | Result |
|---|---|
| 2. Placeholder sent to an unbound host (httpbin) | arrived as the placeholder, logged `UNBOUND` ✓ |
| 3. Plain `http://api.github.com` | not swapped, logged `REFUSED-plain-http` ✓ |
| 14. Token in the query string (`?access_token=`) | detected (`IN-URL`), not swapped. No tested client does this |
| 15. Streaming response (httpbin `/drip`) | unaffected ✓ |
| Placeholder format: generic `sadbox-ph-…` and a `ghp_` with a bad CRC32 tail, in Claude Code (both modes) and gh | all sent to the server; **no client validates token format locally** |
| 16. Token persisted in the VM by clients | none: no `~/.config/gh`, nothing matching in `~/.claude*` |
| Hosts Claude Code reaches with a credential | only `api.anthropic.com` (Datadog intake gets none) |
| Swap cost | 50–480 µs per request (one sample 788 µs) |

**Conclusions**

- **Literal match + `Basic` decoding covers every client tested.**
  Bearer, `token` and `x-api-key` are all literal substrings. Query-string
  substitution is **not needed in v1**: detect and log it only.
- **Placeholder format: variant (a)**, prefix + `sbx` + random to the same
  length and alphabet. Nothing checks format, so (a) is chosen for being
  greppable and keeping prefix-based token-type detection working.
- **Bindings are host-level in practice.** Claude Code spreads one credential
  over 8+ `api.anthropic.com` paths, and gh over REST + GraphQL. Path/method
  narrowing stays optional.
- **Unbound placeholders are rare in normal use** (none from Claude Code, gh or
  git against their own hosts), so prompting on them won't be noisy.

### VM experiments, round 2: real tokens

_Not run yet._ Confirms upstream success (200s) with real tokens against the
built feature, and checks real API responses for any echoed credential.

1. Make **least-privilege, short-lived** tokens, revoked afterwards: a GitHub
   fine-grained PAT (one private test repo, contents read/write) and
   `claude setup-token` (and/or an `ANTHROPIC_API_KEY`).
2. In the UI, add them under **Secrets** as **via the proxy** with the GitHub /
   Anthropic presets, and assign them to a throwaway project. The real value
   goes from the password field straight to the supervisor; the VM gets only
   placeholders.
3. In the VM: `git push` to the test repo, `gh api user` (install `gh` with apt),
   `claude -p hi` with each credential. Expect 200s and 🔑 chips in the request
   log, with no ⚠ rows and no 🔑 approval prompts for these hosts.
4. Revoke the tokens and destroy the project.
