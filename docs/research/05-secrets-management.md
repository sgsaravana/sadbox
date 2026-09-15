# 05 — Secrets Management: Supervisor Storage & Worker Injection

Status: research, September 2026. Applies to the sadbox supervisor (single-user, self-hosted)
running microVM workers (macOS 26 / Apple Containerization today; Linux + Firecracker or
docker-compose on EC2 later), each worker running Claude Code autonomously.

---

## 1. Context & threat model

One honest observation shapes everything below: **Claude Code inside a worker runs arbitrary
shell commands as the guest user.** Any secret that reaches the guest — env var, file,
on-demand fetch — is readable by the agent, because the agent *is* the intended consumer.
`env`, `cat ~/.env`, `cat /proc/self/environ`, or invoking the fetch helper itself are all
one tool call away. There is no injection method that both delivers a secret to the agent's
tools and hides it from the agent. The only pattern that truly hides values is an egress
credential-injection proxy (§3e), which we defer.

So the design goals are, in order:

1. **Blast-radius control**: a worker only ever receives the secrets explicitly assigned to
   it. A compromised/prompt-injected worker can leak *its* secrets, never its neighbors' or
   the full store.
2. **Host-side hygiene**: secrets encrypted at rest in the supervisor DB; never baked into
   base images, rootfs templates, or VM snapshots; never in supervisor logs, VM config
   JSON, or kernel cmdlines; redacted from stored tmux/terminal recordings.
3. **Rotation & revocation**: update a value once in the UI and push it to running workers;
   real revocation happens at the issuer (Anthropic console, GitHub, etc.), so prefer
   least-privilege, individually-revocable credentials (fine-grained PATs, per-project API
   keys) as the *values* we store.
4. **Web UI safety**: write-only values (no read-back endpoint), masked display, and the UI
   itself bound to localhost / behind auth.

**In scope**: exfiltration by malicious or prompt-injected code in a worker (bounded by
scoping, not prevented); secrets lingering in images/snapshots/logs/recordings; theft of the
supervisor's DB file; casual host access (laptop backup, synced folder).

**Out of scope**: host root compromise (root reads supervisor memory; game over), hypervisor
escape, Anthropic-side compromise, and misuse of a valid secret *for its intended API* by
the agent (mitigate by issuing narrow credentials, spend caps, and short-lived tokens — a
policy problem, not a storage problem).

---

## 2. Supervisor-side storage options

| Option | Verdict | Notes |
|---|---|---|
| SQLite + app-layer encryption (libsodium secretbox / AES-256-GCM) | **Recommended** | Encrypt only the `value` column; rest of DB stays plain and debuggable. `crypto_secretbox` (XSalsa20/XChaCha20-Poly1305) or `node:crypto` AES-256-GCM both fine in Bun and Go (`golang.org/x/crypto/nacl/secretbox`). Per-row random nonce; bind AAD to secret id + key version. |
| SQLCipher | Viable, not preferred | Encrypts the whole DB. Native-build friction (Bun FFI / cgo), and full-DB encryption forces the key into the hot path for *every* query, not just secret reads. App-layer is simpler and more targeted. |
| macOS Keychain as the store (`security` CLI / `Bun.secrets`) | Master key only | Great for the KEK; wrong for the data. Not portable to the docker-compose/EC2 target, and Keychain ACLs are per-binary — every rebuild of a dev binary re-prompts or silently widens access. Known weakness: any process running as the user can read Claude Code's own Keychain entry (Silverfort writeup), so Keychain ≠ strong isolation anyway. |
| age / sops files | Backup/export format | Excellent for git-ops-style config, wrong shape for a CRUD web UI over a DB. Use `age` as the encrypted **export/backup** format (`sadbox secrets export > secrets.age`). sops (now a CNCF project) is overkill here. |
| Embedded Vault / Infisical / OpenBao | **Overkill** | Another server, its own unseal-key bootstrap problem, own auth model — for one user. Their *concepts* (envelope encryption, audit log, lease/TTL) are worth copying at 1% of the complexity. |

### Key-management bootstrap (where does the master key live?)

Envelope scheme: a random 256-bit **DEK** encrypts secret values; the DEK is stored in the DB
**wrapped by a KEK**. Rotating the KEK = rewrap one row; rotating the DEK = re-encrypt all
values (rare). `key_version` on every ciphertext makes both online operations.

Per deployment target, the KEK comes from the first of:

1. `SADBOX_MASTER_KEY_FILE` (path to a 32-byte/hex key file) — the docker-compose answer;
   pair with compose `secrets:` (file-mounted at `/run/secrets/...`, supported without Swarm).
2. `SADBOX_MASTER_KEY` env var — CI / quick starts; documented as least preferred.
3. macOS Keychain via `Bun.secrets` (or `security add-generic-password`) — default on the
   Mac host; created on first run. Caveat: `Bun.secrets` on Linux needs libsecret + an
   unlocked keyring, which containers don't have — hence option 1 for Linux.
4. Future: AWS KMS wrap/unwrap of the DEK for EC2 (`key_provider = kms` in config).

If the KEK is absent at boot, the supervisor starts in "locked" mode: workers list/attach
works, secret values unavailable — same UX shape as Vault's sealed state, trivial to implement.

---

## 3. Injection into workers, compared

Control-plane assumption: on macOS, Apple's Containerization framework gives us a GRPC
channel over **vsock** to `vminitd` in each guest (exec processes, write files); on
Firecracker we get the same via our own tiny guest agent on vsock, plus MMDS. Every method
below rides one of these; none require guest networking.

### (a) Env vars at boot
Supervisor passes assigned secrets as env to the worker's entry process (or writes
`/etc/profile.d/sadbox.sh`). Visible in `/proc/*/environ` and `env` — **which is fine**, the
agent is the consumer (§1). Real drawbacks: (1) **no rotation without restarting** the
session/process tree; (2) env leaks ambiently into every child process, crash reporters, and
`printenv` in logged output, making redaction misses more likely; (3) if passed via VM config
or kernel cmdline it lands in host-side files and `/proc/cmdline` — never do that.
**Use for**: launch-time-only convenience; acceptable, not primary.

### (b) Files in the guest (recommended primary)
At provision (post-boot, pre-agent-start), supervisor writes over vsock/SSH:
`~/worker/.env` (or per-secret files under `/run/sadbox/secrets/<NAME>`, mode 0600, tmpfs so
they never touch the guest disk image). Claude Code and dev tooling read `.env` naturally.
**Rotation on a running worker**: rewrite the file over the same channel — new processes and
anything re-reading `.env` pick it up; a `sadbox` marker file or SIGHUP convention covers
long-lived processes. Files on **tmpfs** also die with the VM, so a stolen rootfs image
contains nothing.
**Use for**: everything by default — repo/app secrets, tool API keys.

### (c) Runtime fetch over vsock (recommended for the Anthropic credential)
A ~50-line guest helper (`sadbox-secret NAME`) connects to the supervisor's per-VM vsock
port and asks for one secret; the supervisor knows which VM is asking (per-VM vsock CID /
per-VM host socket), so a worker can *only* resolve its own assignments — scoping enforced
host-side, not by guest configuration. No at-rest copy in the guest at all.
This pairs perfectly with Claude Code's **`apiKeyHelper`** setting: point it at the helper
and Claude Code re-runs it every 5 minutes by default (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`
to tune) — instant, restart-free rotation of the model credential.
**Rotation**: trivially immediate (next fetch). **Cost**: a guest binary + host RPC to build.

### (d) MMDS / metadata service
Firecracker's MMDS: host `PUT/PATCH /mmds` updates the store at runtime (thread-safe);
guest fetches over HTTP at 169.254.169.254; use **V2** (session tokens) only; data store is
deliberately **not persisted in snapshots**. Works, and rotation-on-running-worker is a
`PATCH`. But: it needs a guest network interface + route, 169.254.169.254 is the most
SSRF-probed address on the internet, and — decisive for us — **Apple Containerization has no
MMDS equivalent**; its idiom is vsock (`vminitd` GRPC). A vsock-based (c) is portable across
both hypervisors; MMDS is not.
**Use for**: nothing primary. Revisit only if we're Firecracker-only and want zero guest agents.

### (e) Egress credential-injection proxy (deferred, note for the roadmap)
The 2025–26 state of the art for untrusted agents (Cloudflare Sandbox auth, agentgateway,
Hermes iron-proxy, k8s agent-sandbox #1045): the guest holds *placeholder* strings; all
egress is forced through a host-side proxy that swaps placeholders for real values on the
wire to approved destinations. The only method where exfiltration of what the agent can read
yields nothing. Requires TLS interception or per-API awareness — real engineering. Design the
data model so a secret can later be flagged `delivery = proxy` (see §6), but don't build it now.

**Summary**: (b) files-on-tmpfs as the default; (c) vsock fetch for the Claude credential
(via `apiKeyHelper`) and later for anything rotation-sensitive; (a) allowed as sugar;
(d) skipped; (e) roadmap.

---

## 4. Claude Code auth specifics (verified against code.claude.com docs, Sept 2026)

Credential sources, in Claude Code's own precedence order (abridged): Bedrock/Vertex/Foundry
→ `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN`
→ Anthropic profiles → interactive `/login` OAuth. Relevant facts:

- **`claude setup-token`** (run interactively once, on the host, with a browser): mints a
  **one-year OAuth token** for a Pro/Max/Team/Enterprise subscription; you export it as
  `CLAUDE_CODE_OAUTH_TOKEN` wherever needed. It's model-requests-only (no Remote Control,
  no claude.ai connectors) — exactly what headless workers need. This is the documented CI
  path, i.e. officially sanctioned for non-interactive use.
- **`ANTHROPIC_API_KEY`**: console API key, pay-per-token, never expires. Note it *outranks*
  the OAuth token — don't inject both.
- **Storage**: macOS keeps login in the Keychain (falling back to `~/.claude/.credentials.json`
  0600 when Keychain is locked); Linux always uses `.credentials.json`. **Do not**
  lift-and-shift `.credentials.json` from the Mac host into N workers: on macOS it's in the
  Keychain anyway, the short-lived access token inside refreshes via a refresh token, and N
  copies racing to refresh one token causes invalidation-style breakage (cf. anthropics/
  claude-code#10039 for cross-OS credential-file conflicts). Inject the long-lived
  setup-token instead.
- **`apiKeyHelper`**: a script returning a credential, re-run every 5 min by default — our
  hook for vsock-served, rotating credentials (§3c). (Helper output is used as an API-key-
  style credential; for the subscription token the plain env var is the simple path.)
- **Bare mode** (`--bare`) does not read `CLAUDE_CODE_OAUTH_TOKEN` — if we ever use bare
  mode, we must use `ANTHROPIC_API_KEY`/`apiKeyHelper`.

**Billing for N parallel VMs**: one subscription token in N workers means all N draw from
the *same* rolling 5-hour and weekly usage buckets (Opus and Sonnet metered separately on
Max). Max 20x realistically sustains a small handful of concurrent sessions before
throttling. So: **default to the user's Max subscription token** (fixed cost), and let the
user optionally store an `ANTHROPIC_API_KEY` secret to assign to overflow/burst workers
(metered cost, no shared cap). Sharing an account between *people* violates ToS; one person's
own automation across their own VMs is normal same-account use.

**Recommended flow**: sadbox onboarding runs `claude setup-token` on the host (interactive,
one time per year) → stores the token as the built-in secret `CLAUDE_CODE_OAUTH_TOKEN` →
every worker gets it via §3c/§3b unless the worker is configured to use an API-key secret.

---

## 5. UI patterns from comparable tools

- **GitHub Actions secrets**: flat name/value; **write-only** (update/delete but never read
  back); auto-masked in logs; scoped repo/org/environment; 48 KB cap; values sealed-box
  encrypted (libsodium) client-side for API writes. The masking + write-only combo is the
  baseline users already expect.
- **Fly.io secrets**: `fly secrets set NAME=value`; `fly secrets list` shows **name, digest,
  created-at only**; secrets become env vars in machines; `--stage` defers rollout — staged
  secrets apply only to machines started/updated afterwards. Their staged-vs-deployed split
  maps exactly to our "assigned vs injected" status per worker.
- **Coder workspace secrets**: explicitly warns that template parameters are cleartext and
  unsuitable; user secrets are encrypted in the DB and injected at workspace start; SSH keys
  are fetched on demand and held in memory, never stored in the workspace — prior art for our
  §3c on-demand model.

**Adopt**: name + value form where value is write-only after save (show `sk-ant-…7f2a`
first-4/last-4 hint at most); per-secret "used by N workers" chips; per-worker assignment at
create time **and** a live "push to worker" action with per-worker status `pending → injected
→ stale` (stale = value rotated after last injection); a "Rotate" flow = paste new value →
auto-push to running assignees. No reveal button in v1 (single-user; the user pasted it and
can re-paste it).

---

## 6. Recommendation

1. **Storage**: SQLite + column-level encryption via libsodium secretbox (XChaCha20-Poly1305,
   random 24-byte nonce per write, AAD = `secret_id || key_version`). Envelope keys: DEK in
   DB wrapped by KEK; KEK from macOS Keychain (`Bun.secrets`) on Mac, key file via compose
   `secrets:` on Linux, KMS later (§2). `age`-encrypted export for backup.
2. **Injection**: files on guest **tmpfs** written over the control channel (vsock exec /
   vminitd) after boot, before the agent starts — never in the image, never in VM config.
   Claude credential via `CLAUDE_CODE_OAUTH_TOKEN` in the agent-session environment file;
   migrate it to the vsock `apiKeyHelper` pattern when the guest agent lands. Rotation on a
   running worker = rewrite file over vsock; env-only injection kept as an option but marked
   restart-to-rotate. MMDS: no. Egress proxy: roadmap.
3. **Claude Code auth**: `claude setup-token` once → stored subscription token as the default
   model credential for all workers; optional per-worker `ANTHROPIC_API_KEY` for burst
   capacity beyond Max-plan buckets. Never copy `~/.claude/.credentials.json` between machines.
4. **Hygiene**: supervisor keeps an in-memory set of live plaintext values and scrubs them
   (plus base64 of them) from persisted tmux recordings and UI log streams — best-effort,
   documented as such; snapshots taken only after a `secrets wipe` of tmpfs, or accept that
   tmpfs isn't in disk snapshots and exclude guest RAM snapshots for assigned workers.

### Minimal data model (SQLite)

```sql
CREATE TABLE keyring (
  key_version   INTEGER PRIMARY KEY,
  wrapped_dek   BLOB NOT NULL,           -- DEK wrapped by KEK
  kek_source    TEXT NOT NULL,           -- 'keychain' | 'file' | 'env' | 'kms'
  created_at    TEXT NOT NULL
);

CREATE TABLE secrets (
  id            TEXT PRIMARY KEY,        -- ulid
  name          TEXT NOT NULL UNIQUE,    -- e.g. GITHUB_TOKEN; [A-Z0-9_]+
  description   TEXT,
  ciphertext    BLOB NOT NULL,           -- secretbox(value)
  nonce         BLOB NOT NULL,
  key_version   INTEGER NOT NULL REFERENCES keyring(key_version),
  value_hint    TEXT,                    -- 'sk-ant…7f2a' (first4/last4), nullable
  kind          TEXT NOT NULL DEFAULT 'generic',  -- 'generic'|'anthropic_oauth'|'anthropic_api_key'
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL            -- doubles as last_rotated_at
);

CREATE TABLE worker_secrets (
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  secret_id     TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  target_name   TEXT,                    -- env/file name override; default secrets.name
  delivery      TEXT NOT NULL DEFAULT 'file',   -- 'file' | 'env' | 'vsock' | (future 'proxy')
  status        TEXT NOT NULL DEFAULT 'pending',-- 'pending'|'injected'|'stale'|'error'
  injected_at   TEXT,
  PRIMARY KEY (worker_id, secret_id)
);

CREATE TABLE secret_events (             -- append-only audit
  id            INTEGER PRIMARY KEY,
  secret_id     TEXT NOT NULL,
  worker_id     TEXT,
  event         TEXT NOT NULL,           -- 'created'|'rotated'|'assigned'|'unassigned'|'injected'|'deleted'
  at            TEXT NOT NULL
);
```

Rotation sets `secrets.updated_at`, flips every assignment row to `stale`, and the injector
reconciles running workers back to `injected`.

---

## 7. Open questions

- **Guest agent scope**: do we standardize one sadbox guest agent (vsock) across Apple
  Containerization and Firecracker, or use `vminitd`'s GRPC directly on macOS and only ship
  our agent on Linux? (Affects how §3c is built.)
- **Snapshot policy**: are we snapshotting RAM (Firecracker snapshots) at all? If yes,
  secrets in guest RAM are in the snapshot regardless of delivery method — may need to
  restrict snapshots to workers with no secrets assigned.
- **Redaction depth**: is best-effort literal + base64 scrubbing of recordings enough, or do
  we also hash-scan for high-entropy strings (gitleaks-style) before persisting recordings?
- **setup-token expiry UX**: token lives ~1 year; supervisor should track mint date and
  prompt re-run — can we detect impending expiry other than by auth failures?
- **Per-worker GitHub credentials**: do we push users toward fine-grained PATs per repo (real
  blast-radius win) or accept one `GITHUB_TOKEN` global secret?
- **Web UI exposure**: localhost-only vs LAN — if ever non-localhost, secrets endpoints need
  auth + CSRF before anything else does.

---

## 8. Sources

- Claude Code authentication (setup-token, precedence, apiKeyHelper, credential storage): https://code.claude.com/docs/en/authentication
- Claude Code cross-OS credentials conflict: https://github.com/anthropics/claude-code/issues/10039
- macOS Keychain weakness for Claude Code creds (Silverfort): https://www.silverfort.com/blog/skipping-the-lock-a-claude-code-cli-weakness-lets-any-macos-process-read-stored-credentials/
- Firecracker MMDS user guide (V2 tokens, PATCH updates, snapshot exclusion): https://github.com/firecracker-microvm/firecracker/blob/main/docs/mmds/mmds-user-guide.md
- Firecracker design (vsock, device model): https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md
- Apple Containerization (vminitd GRPC over vsock, virtiofs): https://github.com/apple/containerization
- Bun.secrets (OS keychain API): https://bun.com/docs/runtime/secrets and access-control caveat: https://github.com/oven-sh/bun/issues/28071
- libsodium secretbox: https://doc.libsodium.org/secret-key_cryptography/secretbox
- age: https://github.com/FiloSottile/age · sops (CNCF): https://github.com/getsops/sops · SQLCipher: https://www.zetetic.net/sqlcipher/
- Docker Compose file-based secrets: https://docs.docker.com/compose/how-tos/use-secrets/
- GitHub Actions secrets model: https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
- Fly.io secrets (write-only list, staged rollout): https://fly.io/docs/apps/secrets/ and https://fly.io/docs/flyctl/secrets-set/
- Coder secrets guidance: https://coder.com/docs/admin/security/secrets
- Egress credential-injection prior art: https://blog.cloudflare.com/sandbox-auth/ · https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/ · https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/ · https://github.com/kubernetes-sigs/agent-sandbox/issues/1045 · https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy
