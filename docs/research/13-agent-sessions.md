# Agent sessions — logins and conversation history kept by the supervisor

> **Status: steps 5 and 6 built 2026-11-04** (history store and mounts;
> logins and the Agents page — see "As built"); step 7 (docs) next.
> Planned 2026-11-03. Step 0
> (Spike F, `spikes/f-agent-sessions/`) ran the same day: history mounts hold;
> **copying OAuth logins does not** (F.3) — replaced for OAuth by A7, which
> Spike F.5 confirmed end to end (2026-11-04). See "After Spike F". Goes with [12-vaults.md](12-vaults.md).

## The brief

- Logging in to claude, omp, opencode, … inside any VM should save the login in
  the supervisor, so a new, rebuilt or existing VM gets it without logging in
  again.
- Conversation history should be saved in the supervisor too, per project: a
  project destroyed and recreated **under the same name** gets its history back.

## Where each tool keeps things (seen in a VM, 2026-11-03)

| Tool | Login | History |
|---|---|---|
| Claude Code | `~/.claude/.credentials.json`, `~/.claude.json` (account / onboarding state) | `~/.claude/projects/<cwd-slug>/*.jsonl`, `~/.claude/history.jsonl` |
| omp | auth tables (`auth_credentials`, …) inside `~/.omp/agent/agent.db` — which also holds settings and usage | `~/.omp/agent/sessions/-workdir/`, `~/.omp/agent/history.db` |
| opencode | `~/.local/share/opencode/auth.json` | storage under `~/.local/share/opencode/` |

Every VM's workdir is `/home/agent/workdir`, so the per-cwd folders (Claude's
`projects/<slug>`, omp's `sessions/-workdir`) have the same name in every VM —
history has to be kept apart by sadbox, per project.

omp keeps both in **SQLite with WAL**. SQLite over a shared mount written by
two VMs (two kernels) at once is how databases get corrupted.

## Decisions

| # | Decision | Why |
|---|---|---|
| A1 | Host store: `~/.sadbox/agents/logins/<tool>/` (one login per tool, shared by all projects) and `~/.sadbox/agents/history/<project-name>/<tool>/`. | Logins are per person; history is per project. |
| A2 | **History is mounted** (virtiofs bind mount) into the VM at create / rebuild, keyed by the **exact project name**. | Owner's choice. Only one VM per name exists at a time, so each history store has a single writer — SQLite stays safe. |
| A3 | A mount can only be added when a VM is created, so **existing VMs get history on their next Rebuild** — and that first rebuild **copies the VM's current history into the store before destroying it**. | Nothing already in a VM is lost on the switch. |
| A4 | **Logins are copied, not mounted.** The supervisor watches running VMs (about every 30 s) for a changed login, keeps the newest, and copies it into VMs at create, rebuild and start; an "Apply to running VMs" action does it on demand. | A live shared mount would mean SQLite written by many VMs at once (omp), and would let one compromised VM rewrite every VM's tool config (Claude settings can run commands through hooks). |
| A5 | Copied-in logins are **readable by the VM**. Accepted by the owner. | omp and opencode refresh their tokens from inside the VM, so they need the real login there. (Claude could instead use a long-lived `claude setup-token` token as a proxy vault secret — offered, not chosen.) This **reverses** research/05 decision 11 ("never copy `.credentials.json`"). |
| A6 | An **Agents** page: login status per tool (captured from which project, when), "Forget login", stored history per project with size and delete. The create form says when history exists for the name. | Visibility and a way to clean up. |

## After Spike F (2026-11-03)

- **A2 holds** (F.1): virtiofs mounts map ownership cleanly and SQLite WAL is
  fine with one writer.
- **A4 holds for API-key logins** (F.2): copying only the login (Claude's
  `.credentials.json`, omp's `auth_credentials` rows, opencode's `auth.json`)
  into a fresh VM works.
- **A4 / A5 fail for OAuth logins** (F.3): a refresh in any VM revokes the
  access and refresh token every other copy holds, immediately. Claude
  refreshes about every 8 h.
- **Decided instead, for OAuth** (F.3b; owner's choice 2026-11-03, A7 below):
  the supervisor owns the login. VMs get a login file with **placeholder** tokens
  and a far expiry; the proxy swaps in the current real access token; only the
  supervisor refreshes. Claude was seen to send the placeholder as-is. This
  also makes logins unreadable by the VM (the Vaults rule), reversing A5's
  trade-off.

| # | Decision (after Spike F) | Why |
|---|---|---|
| A7 | **OAuth logins are owned by the supervisor.** It keeps the real tokens and is the only one that refreshes them; every VM gets the tool's login file with placeholder tokens (far expiry), and the proxy swaps the placeholder for the current real access token on requests to the provider. A refresh a VM attempts anyway is answered through the proxy (real refresh token swapped in, the new real tokens kept by the supervisor and handed back as the same placeholders), one refresh at a time per login. API-key logins keep A4 (copied). Replaces A5 for OAuth: those logins are not readable by the VM. | F.3: copies revoke each other on refresh. One owner means one refresh chain, and the Vaults rule holds for logins too. Confirmed end to end by Spike F.5 (2026-11-04). |

## Risks to watch

- Token rotation: when one VM refreshes an OAuth login, providers that rotate
  refresh tokens invalidate the copy other VMs hold. The capture loop picks up
  the newest — whether running tools re-read it is a spike question.
- History mounts hold whatever the agent wrote; deleting a project does not
  delete its history (by design — A2), so the Agents page is where it goes.

## Step 0 — Spike F (`spikes/f-agent-sessions/`)

1. **Mount**: a host folder bind-mounted into a VM — owner/permissions as the
   `agent` user (uid 1000 vs the host's), survives stop / start, SQLite WAL from
   one VM works.
2. **Login copy-in**: does a login copied into a fresh VM work, per tool
   (claude, omp, opencode)?
3. **Live pick-up**: does a running tool notice a replaced login file?
4. **Body swapping** (for Vaults V3): substituting in request bodies through the
   proxy, including Content-Length / chunked bodies.

## As built — step 5 (2026-11-04)

`src/core/history.ts`; wired into create / rebuild / destroy in `src/core/projects.ts`.

**Store**: `~/.sadbox/agents/history/<project-name>/` (A1), one folder per tool.
Only history — logins sitting next to it (`.credentials.json`, omp's
`agent.db`, opencode's `auth.json`) are left out.

| Tool | In the VM | In the store | How |
|---|---|---|---|
| Claude | `~/.claude/projects/` (transcripts) | `claude/projects/` | folder mount |
| Claude | `~/.claude/file-history/` (what `/rewind` restores) | `claude/file-history/` | folder mount |
| Claude | `~/.claude/history.jsonl` (prompt history) | `claude/history.jsonl` | **file** mount |
| omp | `~/.omp/agent/sessions/` | `omp/sessions/` | folder mount |
| omp | `~/.omp/agent/history.db` | `omp/db/history.db` | symlink into `~/.sadbox/history/omp` (mounted `omp/db/`) |
| opencode | `~/.local/share/opencode/opencode.db` (sessions) | `opencode/db/opencode.db` | symlink into `~/.sadbox/history/opencode` (mounted `opencode/db/`) |
| opencode | `~/.local/share/opencode/snapshot/` | `opencode/snapshot/` | folder mount |

Why the mix, found while building:

- **A guest cannot mount anything** (`mount --bind` as root: permission
  denied), so every mount is fixed by `container run --volume` at create.
- **Claude opens `history.jsonl` with `O_NOFOLLOW`** ("history.jsonl is not a
  regular file") — a symlink would break it. A single-file virtiofs mount
  works (checked: written through to the host, back after stop / start).
- **SQLite files are linked, not mounted**: a file mount would leave the
  `-wal` / `-shm` files on the VM's disk; through a symlink SQLite puts them
  beside the real file, in the store (checked with bun:sqlite in a VM;
  opencode created its `opencode.db` through the link).
- The runtime makes the mount points' parent folders **root-owned**; they are
  handed to `agent` after create (`linkHistory`), not recursively.

**Older VMs** (`projects.history_mounted = 0`, every VM from before this):
Rebuild and Destroy first copy the VM's history into the store (A3) —
tmux is ended so the agents stop writing, the paths above are tarred in the VM
(links skipped), unpacked on the host into a temp folder (bsdtar: no absolute
paths, no `..`, no extracting through links) and only plain files and folders
are copied into the store. The VM's copy of a file wins; Claude's prompt
history is appended to what an earlier project of the name left; a database
replaces its `-wal` / `-shm` as a set. A stopped VM is booted for it. A copy
that fails stops a Rebuild (VM untouched) but never a Destroy; a VM that will
not boot is skipped. Either way it is logged (`history.copyout`).

**Safety**: the store is written by a VM. Before every create each path from
the data dir down is checked with `lstat` — a symlink where a mount source
should be is refused, since mounting it would hand the VM that part of this
machine. Sizes are counted without following links. The VM only ever sees its
own project's folders, never the store's parents.

**UI / API**: `GET /api/history` (stores with their size per tool; empty ones
are left out). The create form says when history from an earlier project of
that name will be mounted; Rebuild and Destroy say the history is kept.

**Tested for real** (2026-11-04, a throwaway supervisor and VM): the seven
mounts, owners and links in a fresh VM; history written in it (prompt history,
a transcript, an omp database in WAL mode) back in a recreated VM of the same
name, with the create logged; copy-out of `spike-login`'s real history (37
files, Claude / omp / opencode; no links, no login files).

**Not yet**: deleting a store, and seeing them all, is the Agents page (step 6).
Claude still deletes its own transcripts older than `cleanupPeriodDays` (30 by
default) — the mount does not change that.

## As built — step 6 (2026-11-04)

`src/core/logins.ts` (capture, copy-in, Agents views), `src/net/claudeoauth.ts`
(A7), the proxy hook in `src/net/proxy.ts`, the Agents page.

**Store**: table `agent_logins`, one row per tool and provider, the login
**encrypted** like vault items — not files under `~/.sadbox/agents/logins/`
as A1 said: a plain file would be the one place a real token sat unencrypted.
`login_placeholders` holds each project's Claude placeholders (stable across
refreshes and new logins); `login_seen` what sadbox last saw or put in each VM.

| Tool | Shared | How |
|---|---|---|
| Claude (claude.ai OAuth) | **kept by sadbox** (A7) | VM's `~/.claude/.credentials.json` gets its own placeholders, expiry ten years out; the rest of the file is kept |
| omp, API keys (`auth_credentials` api_key rows) | copied (A4) | read with bun:sqlite; written through **omp's own** `SqliteAuthCredentialStore` (it owns the schema and creates `agent.db` in a fresh VM) |
| opencode, API keys (`auth.json` `api` entries) | copied (A4) | merged into the VM's `auth.json` (0600, atomic) |
| omp / opencode OAuth logins | **not shared** | a copy dies on the first refresh elsewhere (F.3); a VM's own OAuth login for a provider is never overwritten |

**Capture** (every 30 s, running VMs; one bun script fed on stdin, so no
secret is on a command line in the VM): an API-key login that differs from
what sadbox last saw in *that* VM is a new login there and becomes the one
kept — so the newest wins, and a VM still holding the old key does not bring
it back. A real Claude login found in a VM (one from before) is taken over if
sadbox has no working one, otherwise replaced; either way the VM gets
placeholders at once. Stale placeholders (shaped `prefix + sbx`) are never
mistaken for a login. A login file Claude emptied gets placeholders again as
soon as sadbox has a working login.

**Copy-in**: at create / rebuild (before tmux starts), at start, and on
"Apply to running VMs". A4 as decided: API keys are not pushed into running
VMs on their own.

**Claude (A7)**:
- The proxy swaps a project's access placeholder for the real token **only
  in the `Authorization` header, only to `api.anthropic.com`**; anywhere else
  it goes as it is and nobody is asked. The refresh placeholder is never
  swapped. Both real tokens are redacted from responses (headers and bodies).
- `POST https://platform.claude.com/v1/oauth/token` (and `console.anthropic.com`)
  is answered by sadbox before any rule runs:
  - a refresh with this VM's placeholder → sadbox refreshes for real (at most
    once a minute — the VM only asks after a 401) and answers with the
    placeholders;
  - a refresh with another VM's placeholder → 400, nothing sent;
  - anything else — the code exchange of a `/login` in the VM, or a refresh
    with a VM's own real token — is sent on **by sadbox**; the tokens that come
    back become the login kept, and the VM gets placeholders. Real tokens
    never reach a VM.
- sadbox refreshes 15 min ahead of expiry, one refresh at a time. A refusal
  (`invalid_grant`) is shown on the login and not retried until a new login;
  a VM's refresh is then answered with 400 and Claude empties its file (as
  seen in F.5), so the VM shows as logged out.
- Which VMs: every project, one login per person (A1).

**Agents page** (`#agents`; `GET /api/agents`, `POST /api/agents/apply`,
`POST /api/agents/claude/refresh`, `DELETE /api/agents/logins/:tool/:provider`,
`DELETE /api/agents/history/:name`): each login — how VMs get it, where and
when it was captured, Claude's expiry and refresh state; Forget (a copied key
stays in the VMs that have it; Claude's placeholders stop working
everywhere). History per project name with size; Delete, refused while a
project of that name exists (its VM has it mounted).

**Tested for real** (2026-11-04, a throwaway supervisor and two VMs, fake
credentials): keys made in one VM (omp through its real store, opencode's
file) captured within one pass and copied into a fresh VM, where omp's store
reads its key back; Claude placeholders written, swapped on every call to
`api.anthropic.com` (Anthropic answered 401 to the fake token), the VM's
refresh answered by sadbox, which refreshed for real and was refused
(`invalid_grant`, shown on the login); placeholders put back into the emptied
file once the login was marked working; copy-in on stop / start; the Agents
page in Chrome (Apply, Forget). The supervisor on :7070 picked up the code
live and captured two API keys from running VMs (omp/deepseek from
cash-compass, opencode/minimax from spike-login).

**Not tested live**: a real `claude /login` in a VM through the proxy, and
sadbox refreshing a real Claude login (both covered by unit tests against a
stand-in token server; F.5 did the refresh by hand).

## Build steps (agent sessions)

5. History store, mounts at create / rebuild, copy-out before an existing VM's
   first rebuild.
6. Login capture loop, copy-in at create / rebuild / start, Agents page.
7. Docs and the home page's "Good to know".
