#!/usr/bin/env bash
# test-gopublic.sh -- scripts/go-public.sh: account gate, scan, and "nothing changes without --yes-i-reviewed".
#
# A fake `gh` and a recording `git` wrapper (delegates to the real git, logs every call) sit first on PATH, so nothing
# touches GitHub, your real HOME or config. Every secret-looking string below is assembled at run time from pieces so
# this file itself stays clean under scripts/test-privacy.sh.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GP="$KIT/scripts/go-public.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALGIT="$(command -v git)" || { echo "git is required" >&2; exit 2; }
export HOME="$SB/home"; mkdir -p "$HOME/bin" "$HOME/.config"
export XDG_CONFIG_HOME="$HOME/.config" TMPDIR="$SB/tmp"; mkdir -p "$TMPDIR"
unset TALOS_GITHUB_ACCOUNT TALOS_PRIVACY_DENYLIST GH_TOKEN GITHUB_TOKEN

cat > "$HOME/bin/gh" <<FAKE
#!/bin/bash
echo "gh \$*" >> "$SB/gh.calls"
if [ "\$1" = api ] && [ "\$2" = user ]; then
  [ -n "\${FAKE_GH_LOGIN:-}" ] && { echo "\$FAKE_GH_LOGIN"; exit 0; }
  exit 1
fi
if [ "\$1 \$2" = "repo create" ]; then   # what the real one does with --source: add an origin (here a local bare repo)
  src=""; while [ \$# -gt 0 ]; do [ "\$1" = "--source" ] && src="\$2"; shift; done
  "$REALGIT" init -q --bare "$SB/remote.git" && "$REALGIT" -C "\$src" remote add origin "$SB/remote.git"
fi
exit 0
FAKE
cat > "$HOME/bin/git" <<FAKE
#!/bin/bash
echo "git \$*" >> "$SB/git.calls"
exec "$REALGIT" "\$@"
FAKE
chmod +x "$HOME/bin/gh" "$HOME/bin/git"
export PATH="$HOME/bin:$PATH"
export GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@example.com
: > "$SB/gh.calls"; : > "$SB/git.calls"

mkrepo() { # $1 dir
  mkdir -p "$1" && ( cd "$1" && "$REALGIT" init -q -b main && echo "# Demo" > README.md && echo "MIT" > LICENSE \
    && echo "print('hi')" > app.py && "$REALGIT" add -A && "$REALGIT" commit -q -m init )
}
CLEAN="$SB/clean"; mkrepo "$CLEAN"
DIRTY="$SB/dirty"; mkrepo "$DIRTY"
KEY="sk-""abcdefghijklmnopqrstuvwxyz0123456789"
MAIL="dana.ruiz""@gmail.com"
HP="/Us""ers/danaruiz/projects/x"
printf 'api = "%s"\nowner = %s\nroot = %s\n' "$KEY" "$MAIL" "$HP" > "$DIRTY/config.py"
( cd "$DIRTY" && "$REALGIT" add -A && "$REALGIT" commit -q -m "add config" )

# ---- account gate
out=$(FAKE_GH_LOGIN=dana-ruiz bash "$GP" account 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -qi "no GitHub account is configured"; } && ok "refuses when no account is configured (and says how to set one)" || no "no-config case" "rc=$rc $out"
grep -q 'api user' "$SB/gh.calls" && no "gh was queried although no account is configured" || ok "does not even ask gh when nothing is configured"

out=$(FAKE_GH_LOGIN=dana-ruiz bash "$GP" --account acme-bot account 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -q "MISMATCH" && echo "$out" | grep -q "will not switch"; } && ok "refuses on mismatch (flag)" || no "mismatch via --account" "rc=$rc $out"
out=$(TALOS_GITHUB_ACCOUNT=acme-bot FAKE_GH_LOGIN=dana-ruiz bash "$GP" account 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -q "MISMATCH"; } && ok "refuses on mismatch (env var)" || no "mismatch via env" "rc=$rc $out"
mkdir -p "$XDG_CONFIG_HOME/talos"; echo "acme-bot" > "$XDG_CONFIG_HOME/talos/github-account"
out=$(FAKE_GH_LOGIN=dana-ruiz bash "$GP" account 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -q "MISMATCH"; } && ok "refuses on mismatch (config file)" || no "mismatch via file" "rc=$rc $out"
out=$(FAKE_GH_LOGIN=Acme-Bot bash "$GP" account 2>&1); rc=$?
{ [ $rc -eq 0 ] && echo "$out" | grep -q "^OK"; } && ok "matches (case-insensitive) when the config agrees" || no "match case" "rc=$rc $out"
out=$(bash "$GP" account 2>&1); rc=$?
[ $rc -ne 0 ] && ok "refuses when gh cannot report a login" || no "gh failure should refuse" "$out"
grep -Eq 'auth (switch|login)' "$SB/gh.calls" && no "script tried to change the gh account" || ok "never switches or logs in to a gh account"

# ---- scan
out=$(bash "$GP" scan "$DIRTY" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "scan exits non-zero on a planted key/email/path" || no "scan should fail on the dirty repo" "$out"
echo "$out" | grep -q "config.py:1  an sk- API key" && ok "scan finds the planted key at file:line" || no "key not found" "$out"
echo "$out" | grep -q "config.py:2  an email address" && ok "scan finds the planted email" || no "email not found" "$out"
echo "$out" | grep -q "config.py:3  an absolute home-folder path" && ok "scan finds the planted home path" || no "path not found" "$out"
echo "$out" | grep -q "\[history\]" && ok "scan also covers history" || no "no history hit" "$out"
echo "$out" | grep -Fq -e "$KEY" -e "$MAIL" -e "danaruiz" && no "scan printed a secret value" || ok "scan never prints the value"

out=$(bash "$GP" scan "$CLEAN" 2>&1); rc=$?
{ [ $rc -eq 0 ] && echo "$out" | grep -q "no automated findings"; } && ok "scan passes a clean repo" || no "clean repo failed" "$out"

DL="$SB/denylist.txt"; echo "springfield-secret" > "$DL"; echo "see springfield-secret office" > "$CLEAN/notes.txt"
( cd "$CLEAN" && "$REALGIT" add -A && "$REALGIT" commit -q -m notes )
out=$(TALOS_PRIVACY_DENYLIST="$DL" bash "$GP" scan "$CLEAN" 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -q "denylist term (entry #1)"; } && ok "the private denylist is applied" || no "denylist ignored" "$out"
echo "$out" | grep -q "springfield-secret" && no "denylist term echoed" || ok "denylist terms are not echoed"
cp "$DL" "$CLEAN/dl.txt"; out=$(TALOS_PRIVACY_DENYLIST="$CLEAN/dl.txt" bash "$GP" scan "$CLEAN" 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -q "INSIDE the repo"; } && ok "refuses a denylist inside the repo" || no "inside-repo denylist accepted" "$out"
rm -f "$CLEAN/dl.txt" "$CLEAN/notes.txt"; ( cd "$CLEAN" && "$REALGIT" add -A && "$REALGIT" commit -q -m cleanup )

# ---- check mode never mutates
: > "$SB/gh.calls"; : > "$SB/git.calls"
mkdir -p "$SB/clean2"; mkrepo "$SB/clean2"; : > "$SB/git.calls"
FAKE_GH_LOGIN=acme-bot bash "$GP" check "$SB/clean2" >"$SB/check.out" 2>&1; rc=$?
{ [ $rc -eq 0 ] && grep -q "CHECK PASSED" "$SB/check.out"; } && ok "check passes on a clean repo with the right account" || no "check run" "rc=$rc $(cat "$SB/check.out")"
FAKE_GH_LOGIN=acme-bot bash "$GP" "$SB/clean2" >/dev/null 2>&1   # a bare path is not a command: usage, still read-only
FAKE_GH_LOGIN=acme-bot bash "$GP" >/dev/null 2>&1                # no args = check of "."
FAKE_GH_LOGIN=acme-bot bash "$GP" plan "$SB/clean2" demo >"$SB/plan.out" 2>&1
FAKE_GH_LOGIN=acme-bot bash "$GP" recreate "$SB/clean2" demo >>"$SB/plan.out" 2>&1
FAKE_GH_LOGIN=acme-bot bash "$GP" publish acme-bot/demo >>"$SB/plan.out" 2>&1
grep -Eq 'repo (create|edit)|visibility|^gh .*--push' "$SB/gh.calls" && no "a create/visibility command ran without --yes-i-reviewed" "$(cat "$SB/gh.calls")" || ok "no create/visibility command without --yes-i-reviewed"
grep -Eq '^git .*(push|remote add|tag )' "$SB/git.calls" && no "git push/tag ran in read-only mode" "$(cat "$SB/git.calls")" || ok "no git push/tag in read-only modes"
grep -q "read-only: nothing executed" "$SB/plan.out" && ok "plan/recreate dry output says nothing ran, with the steps" || no "dry output" "$(cat "$SB/plan.out")"
[ ! -e "$TMPDIR/go-public-demo" ] && ok "no work dir created without --yes-i-reviewed" || no "work dir was created"

# ---- with the flag: still gated
out=$(FAKE_GH_LOGIN=dana-ruiz bash "$GP" recreate "$SB/clean2" demo --yes-i-reviewed 2>&1); rc=$?
{ [ $rc -ne 0 ] && ! grep -q 'repo create' "$SB/gh.calls"; } && ok "recreate --yes-i-reviewed still refuses on account mismatch" || no "mismatch bypass" "$out"
out=$(FAKE_GH_LOGIN=acme-bot bash "$GP" recreate "$DIRTY" demo --yes-i-reviewed 2>&1); rc=$?
{ [ $rc -ne 0 ] && ! grep -q 'repo create' "$SB/gh.calls"; } && ok "recreate --yes-i-reviewed still refuses on scan findings" || no "dirty recreate went ahead" "$out"
out=$(FAKE_GH_LOGIN=acme-bot bash "$GP" recreate "$SB/clean2" demo --yes-i-reviewed 2>&1); rc=$?
{ [ $rc -eq 0 ] && grep -q 'repo create acme-bot/demo --private' "$SB/gh.calls"; } && ok "recreate --yes-i-reviewed on a clean repo creates a PRIVATE repo under the configured account" || no "happy path" "rc=$rc $out"
grep -q -- '--visibility' "$SB/gh.calls" && no "recreate changed visibility" || ok "recreate never touches visibility"
n=$("$REALGIT" -C "$TMPDIR/go-public-demo" rev-list --count HEAD 2>/dev/null); [ "$n" = "1" ] && ok "the fresh repo has exactly one commit" || no "commit count is '$n'"
out=$(FAKE_GH_LOGIN=acme-bot bash "$GP" publish acme-bot/demo --yes-i-reviewed 2>&1); rc=$?
grep -q 'private repo I can see' <<<"$out" && [ $rc -ne 0 ] && ok "publish refuses unless gh reports the repo as private" || no "publish gate" "rc=$rc $out"

echo "gopublic: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
