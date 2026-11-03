# Agent sessions — logins and conversation history kept by the supervisor

> **Status: planned 2026-11-03** (agreed with the owner, not built yet). Step 0
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

## Build steps (agent sessions)

5. History store, mounts at create / rebuild, copy-out before an existing VM's
   first rebuild.
6. Login capture loop, copy-in at create / rebuild / start, Agents page.
7. Docs and the home page's "Good to know".
