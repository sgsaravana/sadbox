# Spike D — credential proxy (placeholders swapped on the wire)

De-risks `docs/research/11-credential-proxy.md` before any schema or UI work:
can a VM hold only placeholder tokens while real clients (git, gh, Claude Code,
SDKs) keep working, because the supervisor's proxy swaps placeholder → real on
the way out and real → placeholder in response headers?

**Status:** harness built and smoke-tested on the host (2026-10-14). The
experiments with real VMs and real clients haven't been run yet.

## Files

| File | What |
|---|---|
| `subst.ts` | The swap: placeholder → real in request headers (literal and inside `Basic`), https + bound hosts only; real → placeholder in all response headers. Logs `[spike-d] …` lines with secret and header names, never values |
| `proxy.patch` | Two hook lines + an import in `src/net/proxy.ts`, enabled only when `SADBOX_SPIKE_SUBST` is set. **Never merged.** |
| `placeholder.ts` | Prints placeholder variants (a)/(b)/(c) for a real token |
| `subst.test.ts` | Unit tests for the swap and the placeholder generator (`bun test spikes/d-credential-proxy`) |
| `smoke.ts` | Host-only end-to-end run of the patched proxy against httpbin.org, with dummy tokens |

```sh
git apply spikes/d-credential-proxy/proxy.patch      # hook in
bun spikes/d-credential-proxy/smoke.ts                # host smoke test
git apply -R spikes/d-credential-proxy/proxy.patch   # hook out before committing anything
```

## Setup for the VM experiments

1. Real, **least-privilege, short-lived** test credentials, revoked after the spike:
   - GitHub fine-grained PAT (one private test repo, contents read/write) + a classic `ghp_` PAT
   - `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) and/or an `ANTHROPIC_API_KEY`
   - optionally an OpenAI key
2. Make placeholders: `pbpaste | bun spikes/d-credential-proxy/placeholder.ts`.
3. Write the map file outside the repo, `chmod 600`, delete it afterwards:
   ```json
   { "secrets": [
     { "name": "GITHUB_TOKEN", "placeholder": "ghp_sbx…", "value": "ghp_…",
       "hosts": ["github.com", "api.github.com", "*.githubusercontent.com"] },
     { "name": "CLAUDE_CODE_OAUTH_TOKEN", "placeholder": "sk-ant-oat01-sbx…", "value": "sk-ant-oat01-…",
       "hosts": ["api.anthropic.com"] } ] }
   ```
4. Apply the patch and run the supervisor with `SADBOX_SPIKE_SUBST=~/spike-d-map.json bun run dev`.
5. In the UI, create the secrets with the **placeholder** as their value and
   assign them to a throwaway project. The normal env-file delivery then puts
   only placeholders in the VM, with no other change needed.
6. Allow the target hosts for the project. Watch the supervisor's stdout for
   `[spike-d]` lines: `injected=` / `UNBOUND=` / `REFUSED-plain-http=` / `IN-URL=` / `redacted=`.
   An `UNBOUND=` line for a host you expected shows a missing binding (e.g. a
   host Claude Code talks to that isn't `api.anthropic.com`).

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

### VM experiments

_To be filled in when experiments 1–5 run._
