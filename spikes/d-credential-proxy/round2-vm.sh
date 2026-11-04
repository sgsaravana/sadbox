#!/bin/sh
# Spike D round 2, the VM side: real tokens, held by sadbox, used through the
# proxy. Run in the throwaway project's terminal (paste it, or copy it in):
#   sh round2-vm.sh OWNER/PRIVATE_TEST_REPO
# Needs proxy vault items GITHUB_TOKEN (GitHub preset) and, for the Claude
# API-key run, ANTHROPIC_API_KEY (Anthropic preset), assigned to this project.
# Prints one line per check; the host side (round2-report.ts) then reads the
# request log and checks no real value is anywhere in the VM.
REPO="$1"
[ -n "$REPO" ] || { echo "usage: sh round2-vm.sh OWNER/REPO" >&2; exit 2; }
[ -f ~/.sadbox/env ] && . ~/.sadbox/env
[ -f ~/.sadbox/net.env ] && . ~/.sadbox/net.env
pass=0 fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1${2:+  — $2}"; fail=$((fail+1)); }
has() { printf %s "$1" | grep -q "$2"; }

echo "== placeholders in the env (value shapes only) =="
for v in GITHUB_TOKEN ANTHROPIC_API_KEY; do
  eval "x=\${$v:-}"
  if [ -z "$x" ]; then echo "  $v: not set"
  elif has "$x" sbx; then echo "  $v: placeholder (${x%%sbx*}sbx…)"
  else echo "  $v: NOT a placeholder"; fi
done

echo "== GitHub =="
code=$(curl -s -o /tmp/r2-user.json -w '%{http_code}' -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user)
[ "$code" = 200 ] && ok "curl api.github.com/user: 200 ($(grep -o '"login": *"[^"]*"' /tmp/r2-user.json))" || bad "curl api.github.com/user" "$code"

dir=$(mktemp -d)
if git clone -q "https://github.com/$REPO.git" "$dir/repo" 2>/tmp/r2-git.err; then
  ok "git clone (credential helper → Basic)"
  cd "$dir/repo" && b="sadbox-spike-d-$(date +%s)" && git checkout -qb "$b" \
    && echo "spike d round 2 $(date -u)" > spike-d.txt && git add spike-d.txt \
    && git -c user.name=sadbox -c user.email=spike@sadbox.invalid commit -qm "spike d round 2" \
    && git push -q origin "$b" 2>>/tmp/r2-git.err \
    && ok "git push (branch $b — delete it afterwards)" \
    && git push -q origin --delete "$b" 2>>/tmp/r2-git.err && ok "git push --delete $b" \
    || bad "git push" "$(tail -1 /tmp/r2-git.err)"
  cd - >/dev/null
else bad "git clone" "$(tail -1 /tmp/r2-git.err)"; fi
rm -rf "$dir"

if command -v gh >/dev/null || { sudo -E apt-get update -qq >/dev/null 2>&1; sudo -E apt-get install -qq -y gh >/dev/null 2>&1; command -v gh >/dev/null; }; then
  GH_TOKEN="$GITHUB_TOKEN" gh api user -q .login >/tmp/r2-gh 2>&1 && ok "gh api user ($(cat /tmp/r2-gh))" || bad "gh api user" "$(cat /tmp/r2-gh)"
  GH_TOKEN="$GITHUB_TOKEN" gh pr list -R "$REPO" -L 1 >/dev/null 2>/tmp/r2-gh && ok "gh pr list (GraphQL)" || bad "gh pr list" "$(tail -1 /tmp/r2-gh)"
else bad "gh" "not installed and apt install failed"; fi

echo "== Claude =="
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  out=$(cd /tmp && timeout 120 claude -p "reply with the single word: hi" 2>&1)
  has "$out" '[Hh]i' && ok "claude -p with ANTHROPIC_API_KEY" || bad "claude -p (API key)" "$(printf %s "$out" | tail -1)"
  code=$(curl -sN -o /tmp/r2-sse -w '%{http_code}' https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}')
  [ "$code" = 200 ] && grep -q message_stop /tmp/r2-sse && ok "API streaming (SSE) via curl" || bad "API streaming" "$code"
else echo "  skip API key: ANTHROPIC_API_KEY not set"; fi

if [ -f ~/.claude/.credentials.json ]; then
  # the sadbox-owned login: the VM's copy holds placeholders only
  grep -q 'sbx' ~/.claude/.credentials.json && ok "~/.claude/.credentials.json holds placeholders" || bad "credentials file" "no placeholder shape"
  out=$(cd /tmp && env -u ANTHROPIC_API_KEY timeout 120 claude -p "reply with the single word: hi" 2>&1)
  has "$out" '[Hh]i' && ok "claude -p with the sadbox-owned login" || bad "claude -p (login)" "$(printf %s "$out" | tail -1)"
else echo "  skip login: no ~/.claude/.credentials.json (run /login in claude first)"; fi

rm -f /tmp/r2-*
echo "== $pass passed, $fail failed =="
echo "Now on the host: bun spikes/d-credential-proxy/round2-report.ts <project name>"
