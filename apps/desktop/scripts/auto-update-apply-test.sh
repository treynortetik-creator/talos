#!/usr/bin/env bash
# Tests the updater's last step (auto-update-apply.sh, git and archive checkouts) and install.sh --check-only, with temp folders only: a local bare "public repo"
# with two commits, a clone of it as the bridge checkout, stub pnpm, osascript and open on PATH, and, for --check-only, the REAL
# install.sh against zips made here (one unsigned, one signed ad hoc, one whose sha256 is not the one given). Nothing real is
# installed, quit or opened; no Talos home is read. Run by guards-test.sh. Usage: auto-update-apply-test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APPLY="$HERE/scripts/auto-update-apply.sh"
INSTALL="$HERE/scripts/install.sh"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(mktemp -d "${TMPDIR:-/tmp}/talos-au-apply-test-XXXXXX")"
LINKDIR=""
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; [ -z "$LINKDIR" ] || { rm -f "$LINKDIR"/*; rmdir "$LINKDIR"; }' EXIT
unset TALOS_APP_HOME TALOS_RELEASE_TEAM
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export HOME="$T/home"; mkdir -p "$HOME" "$T/tmp"; export TMPDIR="$T/tmp"

STUB="$T/stub"; mkdir -p "$STUB"
export STUBLOG="$T/stub.log"
# pnpm: logs, then fails when PNPM_FAIL_AT names its call number (1, 2, ...), or sends TERM to the apply script at PNPM_TERM_AT
cat > "$STUB/pnpm" <<'S'
#!/bin/bash
n=$(( $(grep -c '^pnpm ' "$STUBLOG" 2>/dev/null || true) + 1 ))
echo "pnpm $* (call $n, in $(git rev-parse --short HEAD 2>/dev/null))" >> "$STUBLOG"
# the apply script is the parent of the subshell that runs pnpm
[ "${PNPM_TERM_AT:-}" = "$n" ] && kill -TERM "$(ps -o ppid= -p "$PPID" | tr -d ' ')"
[ "${PNPM_FAIL_AT:-}" = "$n" ] && exit 1
exit 0
S
printf '#!/bin/bash\necho "osascript $*" >> "$STUBLOG"\necho false\n' > "$STUB/osascript"
printf '#!/bin/bash\necho "open $*" >> "$STUBLOG"\n' > "$STUB/open"
chmod +x "$STUB"/*
export PATH="$STUB:$PATH"
# The script takes every system tool (open and osascript included) by full path from the ONE TOOL_DIRS line; no variable of the environment can
# name a folder. THIS TEST therefore runs a copy of the script whose TOOL_DIRS line is rewritten to try the stub folder first (stand-ins for
# open and osascript), checks that the rewrite really happened, and runs the real file only where a test says so ($APPLY_REAL).
APPLY_REAL="$APPLY"
tool_dirs_copy() {  # tool_dirs_copy <name> <dirs>: the script with its TOOL_DIRS line rewritten (to <dirs>, escaped for sed)
  local esc; esc="$(printf '%s' "$2" | sed 's/[&|\\]/\\&/g')"
  sed "s|^TOOL_DIRS=.*|TOOL_DIRS=\"$esc\"|" "$APPLY_REAL" > "$T/$1.sh"
  if grep -F -q -x "TOOL_DIRS=\"$2\"" "$T/$1.sh" && ! cmp -s "$APPLY_REAL" "$T/$1.sh"; then return 0; fi
  bad "the TOOL_DIRS line of the script was not rewritten for $1 (the test would run the real folders)"
}
# The script's tool() splits TOOL_DIRS on spaces, so a stub folder whose path has one (a TMPDIR with a space) is never found and the
# script would run the REAL /usr/bin/open and osascript. Such a stub is reached through a link folder with no space in its path.
# (made here, in this shell, not inside nospace: that runs in a command substitution, where a variable set is lost and the folder never cleaned up)
case "$T" in *[[:space:]]*) LINKDIR="$(mktemp -d /private/tmp/talos-stub.XXXXXX)";; esac
nospace() {  # nospace <dir>: <dir> itself, or (when its path has a space) a link to it under a folder whose path has none
  case "$1" in *[[:space:]]*) ;; *) printf '%s' "$1"; return;; esac
  local l="$LINKDIR/$(basename "$1")"; [ -e "$l" ] || ln -s "$1" "$l"; printf '%s' "$l"
}
TOOLSTUB="$(nospace "$STUB")"
tool_dirs_copy apply-tools "$TOOLSTUB /usr/bin /bin /usr/sbin /sbin"; APPLY="$T/apply-tools.sh"
# a stand-in that the copy does not resolve is a FAILED test, never a fall back to the real tool
for t in open osascript; do
  got="$(/bin/bash -c "$(grep '^TOOL_DIRS=' "$APPLY")"$'\n'"$(grep '^tool() {' "$APPLY")"$'\n'"tool $t")"
  [ "$got" = "$TOOLSTUB/$t" ] && ok "the copy resolves $t to the stand-in ($TOOLSTUB/$t)" || bad "the copy resolves $t to $got, not the stand-in $TOOLSTUB/$t (the real tool would run)"
done

# The public repo: commit A (where the checkout is) and commit B (the release). B's install.sh is a stub that logs its arguments and
# exits with INSTALL_RC; A's would say "A" if it were ever run.
ORIGIN="$T/origin.git"; SRC="$T/src"
git init -q --bare "$ORIGIN"; git init -q -b main "$SRC"
mkdir -p "$SRC/apps/desktop/scripts"
# the stub install.sh: --rollback exits ROLLBACK_RC, an install INSTALL_RC; an install that succeeds writes the health report after
# HEALTH_AFTER seconds when HEALTH_AFTER is set (the new app coming up healthy), in the background as a real app would
stub_install() {
  printf '#!/bin/bash\necho "install %s $*" >> "$STUBLOG"\n[ "$1" = --rollback ] && exit ${ROLLBACK_RC:-0}\nrc=${INSTALL_RC:-0}\nif [ -n "${STUB_PLIST:-}" ]; then /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string 9.9.9" "$STUB_PLIST" >/dev/null; sleep "${INSTALL_SLEEP:-0}"; fi\nif [ "$rc" = 0 ] && [ -n "${HEALTH_AFTER:-}" ]; then ( sleep "$HEALTH_AFTER"; echo "{\\"v\\":1}" > "$HEALTH_OUT" ) & fi\nexit $rc\n' "$1" > "$SRC/apps/desktop/scripts/install.sh"
}
stub_install A; echo '{}' > "$SRC/package.json"; echo 'node_modules/' > "$SRC/.gitignore"
git -C "$SRC" add -A; git -C "$SRC" commit -qm A; A="$(git -C "$SRC" rev-parse HEAD)"
stub_install B; echo '{"v":2}' > "$SRC/package.json"
git -C "$SRC" add -A; git -C "$SRC" commit -qm B; B="$(git -C "$SRC" rev-parse HEAD)"
# commit R: the REAL install.sh answers --rollback (an install is a stub that logs and succeeds)
cp "$INSTALL" "$SRC/apps/desktop/scripts/install-real.sh"
printf '#!/bin/bash\nif [ "$1" = --rollback ]; then echo "install R $*" >> "$STUBLOG"; exec bash "$(dirname "$0")/install-real.sh" "$@"; fi\necho "install R $*" >> "$STUBLOG"\nexit 0\n' > "$SRC/apps/desktop/scripts/install.sh"
git -C "$SRC" add -A; git -C "$SRC" commit -qm R; R="$(git -C "$SRC" rev-parse HEAD)"
git -C "$SRC" push -q "$ORIGIN" "$A:refs/heads/main" "$B:refs/tags/v9.9.9" "$R:refs/tags/v9.9.10"; git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
ZIP="$T/Talos-9.9.9.zip"; echo zip > "$ZIP"
PIN="$(printf 'a%.0s' $(seq 64))"
DEST="$T/Applications"; mkdir -p "$DEST/Talos.app"

fresh() {  # a new clone on main at A
  rm -rf "$T/co" "$T/result.json"; : > "$STUBLOG"
  git clone -q "$ORIGIN" "$T/co" && git -C "$T/co" checkout -q main
}
prepare() { bash "$APPLY" --prepare --checkout "$T/co" --commit "${REL:-$B}" --result "$T/result.json" "$@" >"$T/out.log" 2>&1; }
swap() {
  bash "$APPLY" --swap --checkout "$T/co" --commit "${REL:-$B}" --to main --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" \
    --result "$T/result.json" "$@" >"$T/out.log" 2>&1
}
# HEAD read straight from the files, never through git: a checkout the test arms on purpose (a planted config key) can make
# git refuse to read it at all, and what that does must not depend on what this machine holds (a /tmp/x folder did).
# the git folder: .git itself, or where a "gitdir: <path>" file in its place points (the test arms that case too)
git_dir() { if [ -f "$T/co/.git" ]; then sed -n 's/^gitdir: //p' "$T/co/.git"; else printf '%s' "$T/co/.git"; fi; }
head_ref() { local h; h="$(cat "$(git_dir)/HEAD" 2>/dev/null)"; case "$h" in "ref: "*) printf '%s' "${h#ref: }" ;; *) printf '' ;; esac; }
head_sha() {
  local d h ref; d="$(git_dir)"; h="$(cat "$d/HEAD" 2>/dev/null)"
  case "$h" in
    "ref: "*) ref="${h#ref: }"
      if [ -f "$d/$ref" ]; then cat "$d/$ref"
      else awk -v r="$ref" '$2 == r { print $1; exit }' "$d/packed-refs" 2>/dev/null; fi ;;
    *) printf '%s\n' "$h" ;;
  esac
}
head_is() { [ "$(head_sha)" = "$1" ]; }
on_main() { [ "$(head_ref)" = refs/heads/main ]; }
res() { cat "$T/result.json" 2>/dev/null; }

echo "auto-update-apply.sh"
fresh; prepare; rc=$?
if [ "$rc" = 0 ] && head_is "$B" && [ "$(res)" = '{"v":1,"ok":true,"step":"prepare"}' ] \
  && grep -q "^pnpm install --frozen-lockfile (call 1, in ${B:0:7})" "$STUBLOG" && ! grep -q '^install' "$STUBLOG"; then
  ok "prepare: the checkout is on the release's commit with its packages installed, and nothing is swapped yet"
else bad "prepare: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi
# a Mac with no pnpm (bun only, as a bare Mac running the prebuilt app): the packages come from bun, with the install-js.sh flags
STUB2="$T/stub2"; mkdir -p "$STUB2"; cp "$STUB/osascript" "$STUB/open" "$STUB2/"
printf '#!/bin/bash\necho "bun $* (hooks=${TALOS_NO_HOOKS:-}, in $(git rev-parse --short HEAD 2>/dev/null))" >> "$STUBLOG"\nexit ${BUN_RC:-0}\n' > "$STUB2/bun"; chmod +x "$STUB2"/*
fresh; PATH="$STUB2:/usr/bin:/bin" prepare; rc=$?
if [ "$rc" = 0 ] && head_is "$B" && grep -q "^bun install --frozen-lockfile --ignore-scripts (hooks=1, in ${B:0:7})" "$STUBLOG" && ! grep -q '^pnpm' "$STUBLOG"; then
  ok "prepare on a Mac with no pnpm: the packages come from bun (no scripts, no git hooks) and pnpm is never run"
else bad "bun-only prepare: exit $rc, log: $(cat "$STUBLOG")"; fi
fresh; BUN_RC=1 PATH="$STUB2:/usr/bin:/bin" prepare; rc=$?
if [ "$rc" = 21 ] && head_is "$A" && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"deps","restored":true}' ]; then ok "a failing bun install puts the checkout back, as pnpm's does"; else bad "bun failure: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res)"; fi
fresh; prepare >/dev/null; : > "$STUBLOG"; swap; rc=$?
if [ "$rc" = 0 ] && head_is "$B" && [ "$(res)" = '{"v":1,"ok":true,"step":"swap"}' ] \
  && grep -q "^install B --from-release $ZIP --sha256 $PIN --team ABCDE12345 --dest $DEST --no-relay-wait$" "$STUBLOG"; then
  ok "swap: the release's own install.sh swaps the app, without waiting for the relay"
else bad "swap: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi

# the swap runs the release's install.sh with the system bash, never a `bash` found through the caller's PATH
FAKEB="$T/fakebash"; mkdir -p "$FAKEB"; printf '#!/bin/sh\ntouch "%s/fake-bash-ran"\nexit 0\n' "$T" > "$FAKEB/bash"; chmod +x "$FAKEB/bash"; rm -f "$T/fake-bash-ran"
fresh; prepare >/dev/null; : > "$STUBLOG"
PATH="$FAKEB:$PATH" /bin/bash "$APPLY" --swap --checkout "$T/co" --commit "$B" --to main --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" --result "$T/result.json" >"$T/out.log" 2>&1; rc=$?
if [ "$rc" = 0 ] && [ ! -e "$T/fake-bash-ran" ] && grep -q "^install B --from-release" "$STUBLOG" && [ "$(res)" = '{"v":1,"ok":true,"step":"swap"}' ]; then
  ok "git swap: install.sh is run by the system bash, not by a fake bash first in the caller's PATH"
else bad "fake bash in PATH: exit $rc, fake ran: $([ -e "$T/fake-bash-ran" ] && echo yes || echo no), result $(res), log: $(cat "$STUBLOG")"; fi

fresh; echo stray > "$T/co/untracked.txt"; prepare; rc=$?
if [ "$rc" = 20 ] && head_is "$A" && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"dirty"}' ] && ! grep -q '^install\|^pnpm' "$STUBLOG"; then
  ok "a checkout with an untracked file is refused before anything moves"
else bad "untracked file: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi

fresh; echo edited >> "$T/co/apps/desktop/scripts/install.sh"; prepare; rc=$?
if [ "$rc" = 20 ] && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"dirty"}' ] && ! grep -q '^install' "$STUBLOG"; then
  ok "a checkout with an edited install.sh is refused, and the edited script never runs"
else bad "edited tracked file: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi

fresh; bash "$APPLY" --prepare --checkout "$T/co" --commit "$(printf 'b%.0s' $(seq 40))" --result "$T/result.json" >/dev/null 2>&1; rc=$?
if [ "$rc" = 20 ] && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"checkout"}' ]; then
  ok "a commit that is not in the public repo is refused, nothing moved"
else bad "missing commit: exit $rc, result $(res)"; fi

fresh; PNPM_FAIL_AT=1 prepare; rc=$?
if [ "$rc" = 21 ] && head_is "$A" && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"deps","restored":true}' ]; then
  ok "packages failing after the move: the checkout is back on its branch"
else bad "pnpm failure: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi

# stopped midway (TERM while the packages install): the checkout still goes back, and the result says it stopped
fresh; PNPM_TERM_AT=1 prepare; rc=$?
if [ "$rc" != 0 ] && head_is "$A" && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"stopped","restored":true}' ]; then
  ok "stopped by a signal after the move: the checkout is back and the result says stopped"
else bad "TERM midway: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi

fresh; prepare; : > "$STUBLOG"; INSTALL_RC=9 swap; rc=$?
if [ "$rc" = 21 ] && head_is "$A" && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"app_check","restored":true}' ] \
  && grep -q "^open $DEST/Talos.app$" "$STUBLOG" && grep -q "^pnpm install --frozen-lockfile (call 1, in ${A:0:7})" "$STUBLOG"; then
  ok "install.sh refusing the release (exit 9): the checkout goes back (packages again), and the kept Talos is opened"
else bad "install exit 9: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi

fresh; swap; rc=$?
if [ "$rc" = 21 ] && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"checkout","restored":true}' ] && ! grep -q '^install' "$STUBLOG"; then
  ok "a swap on a checkout that is not the prepared commit swaps nothing"
else bad "unprepared swap: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi

fresh; prepare; echo stray > "$T/co/late.txt"; : > "$STUBLOG"; swap; rc=$?
if [ "$rc" = 21 ] && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"checkout","restored":true}' ] && ! grep -q '^install' "$STUBLOG"; then
  ok "a file appearing between prepare and swap stops the swap, and the checkout goes back"
else bad "dirty at swap: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi

# --restore: after a prepare the sessions were no longer quiet, or a run was killed outright and wrote nothing
fresh; prepare; bash "$APPLY" --restore --checkout "$T/co" --to main --result "$T/r.json" >/dev/null 2>&1; rc=$?
if [ "$rc" = 0 ] && on_main && head_is "$A" && [ "$(cat "$T/r.json")" = '{"v":1,"ok":true,"step":"restore"}' ]; then ok "--restore puts a moved checkout back on its branch"; else bad "--restore: exit $rc"; fi

# The checkout is the agent's to write to, so git runs on it as the updater's own tool: no program named in .git/config
# (core.fsmonitor) and no hook (.git/hooks, core.hooksPath) runs, and no GIT_* variable from the caller steers it.
echo "updater trust: hardened git, and a checkout that carries commits of its own"
MARKS="$T/marks"
arm() {  # arm hooks|config|hookspath: a fresh clone whose own hooks (and config) would leave a file in $MARKS if git ever ran them
  rm -rf "$MARKS" "$T/hp"; mkdir -p "$MARKS" "$T/hp"
  printf '#!/bin/sh\ntouch "%s/fsmonitor"\nprintf "x\\000"\n' "$MARKS" > "$T/fsm.sh"; chmod +x "$T/fsm.sh"
  [ "${1:-}" = config ] && git -C "$T/co" config core.fsmonitor "$T/fsm.sh"
  local dir="$T/co/.git/hooks"
  [ "${1:-}" = hookspath ] && { git -C "$T/co" config core.hooksPath "$T/hp"; dir="$T/hp"; }
  for h in post-checkout post-merge post-commit post-rewrite reference-transaction; do
    printf '#!/bin/sh\ntouch "%s/%s"\nexit 0\n' "$MARKS" "$h" > "$dir/$h"; chmod +x "$dir/$h"
  done
}
marks() { ls "$MARKS" 2>/dev/null | tr '\n' ' '; }
fresh; arm hooks; prepare; rc1=$?; head_is "$B" || rc1=99
INSTALL_RC=9 swap; rc2=$?
prepare >/dev/null; bash "$APPLY" --restore --checkout "$T/co" --to main --commit "$B" --result "$T/r.json" >/dev/null 2>&1; rc3=$?
if [ "$rc1" = 0 ] && [ "$rc2" = 21 ] && [ "$rc3" = 0 ] && on_main && head_is "$A" && [ -z "$(marks)" ]; then
  ok "prepare, a failed swap and restore never run the checkout's hooks (.git/hooks)"
else bad "armed hooks: prepare $rc1, swap $rc2, restore $rc3, marks: $(marks)"; fi
# a config that names a program (core.fsmonitor, core.hooksPath) is refused outright, and nothing it names runs
for where in config hookspath; do
  fresh; arm "$where"; prepare; rc=$?
  if [ "$rc" = 20 ] && head_is "$A" && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"checkout-config"}' ] && [ -z "$(marks)" ] && ! grep -q '^pnpm' "$STUBLOG"; then
    ok "a checkout whose config names a monitor or a hooks folder ($where) is refused (checkout-config), nothing run"
  else bad "armed config ($where): exit $rc, result $(res), marks: $(marks)"; fi
done
# the clean check is the hardened one too: a swap of a prepared checkout whose config names a monitor
fresh; prepare; arm hooks; : > "$STUBLOG"; swap; rc=$?
if [ "$rc" = 0 ] && [ -z "$(marks)" ]; then ok "swap's clean check runs no fsmonitor, and its checkout back runs no hook"; else bad "armed swap: exit $rc, marks: $(marks)"; fi
# GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_* / GIT_EXEC_PATH from the caller point somewhere else: they are ignored
mkdir -p "$T/decoy/empty-bin"; git init -q -b main "$T/decoy"; printf '#!/bin/sh\ntouch "%s/exec-path"\nexit 1\n' "$MARKS" > "$T/decoy/empty-bin/git-status"; chmod +x "$T/decoy/empty-bin/git-status"
fresh; mkdir -p "$MARKS"
GIT_DIR="$T/decoy/.git" GIT_WORK_TREE="$T/decoy" GIT_EXEC_PATH="$T/decoy/empty-bin" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.bare GIT_CONFIG_VALUE_0=true prepare; rc=$?
if [ "$rc" = 0 ] && head_is "$B" && [ ! -e "$MARKS/exec-path" ]; then ok "GIT_DIR, GIT_WORK_TREE, GIT_EXEC_PATH and GIT_CONFIG_* in the caller's environment are ignored"; else bad "GIT_* in the environment: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res)"; fi

# local commits: the checkout is not moved, and is never later moved back to and installed
fresh; echo mine > "$T/co/mine.txt"; git -C "$T/co" add mine.txt; git -C "$T/co" commit -qm mine; L="$(git -C "$T/co" rev-parse HEAD)"
prepare; rc=$?
if [ "$rc" = 20 ] && head_is "$L" && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"local-commits"}' ] && ! grep -q '^install\|^pnpm' "$STUBLOG"; then
  ok "prepare: a checkout with a commit of its own (HEAD not in the release's history) is refused, nothing moved"
else bad "local commit: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi
fresh; git -C "$T/co" checkout -q --detach; echo mine > "$T/co/mine.txt"; git -C "$T/co" add mine.txt; git -C "$T/co" commit -qm mine
prepare; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"local-commits"}' ] && ok "prepare: the same on a detached HEAD" || bad "detached local commit: exit $rc, result $(res)"
# a checkout already on the release's commit is fine (HEAD equals the commit)
fresh; git -C "$T/co" checkout -q --detach "$B"; prepare; rc=$?
[ "$rc" = 0 ] && head_is "$B" && ok "prepare: a checkout already on the release's commit is not refused" || bad "HEAD equal to the release: exit $rc, result $(res)"
# restore to a commit that is not in the release's history is refused when the release's commit is given
fresh; git -C "$T/co" checkout -q -b side; echo mine > "$T/co/mine.txt"; git -C "$T/co" add mine.txt; git -C "$T/co" commit -qm mine; L="$(git -C "$T/co" rev-parse HEAD)"
git -C "$T/co" checkout -q --detach "$B"
bash "$APPLY" --restore --checkout "$T/co" --to "$L" --commit "$B" --result "$T/r.json" >/dev/null 2>&1; rc=$?
if [ "$rc" = 20 ] && head_is "$B" && [ "$(cat "$T/r.json")" = '{"v":1,"ok":false,"step":"restore","why":"local-commits"}' ] && ! grep -q '^pnpm' "$STUBLOG"; then
  ok "--restore --to a commit of the checkout's own is refused when --commit is given: nothing moved, nothing installed"
else bad "restore to local commit: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(cat "$T/r.json" 2>/dev/null)"; fi
bash "$APPLY" --restore --checkout "$T/co" --to side --commit "$B" --result "$T/r.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 20 ] && head_is "$B" && ok "--restore --to a branch that holds one is refused the same way" || bad "restore to side branch: exit $rc"
bash "$APPLY" --restore --checkout "$T/co" --to main --commit "$B" --result "$T/r.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && on_main && head_is "$A" && ok "--restore --to an ancestor of the release's commit still works" || bad "restore to ancestor: exit $rc"
# the swap's own way back (to REF) is held to the same rule: a REF that moved onto a commit of its own is not checked out or installed
fresh; git -C "$T/co" checkout -q -b side; echo mine > "$T/co/mine.txt"; git -C "$T/co" add mine.txt; git -C "$T/co" commit -qm mine; L="$(git -C "$T/co" rev-parse HEAD)"; git -C "$T/co" checkout -q main
prepare; git -C "$T/co" branch -f main "$L"; : > "$STUBLOG"; INSTALL_RC=9 swap; rc=$?
if [ "$rc" = 21 ] && ! head_is "$L" && ! grep -q "^pnpm install.*in ${L:0:7}" "$STUBLOG"; then
  ok "a swap's way back never checks out (or installs) a REF that is not in the release's history"
else bad "swap back to a moved ref: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi

# ---- the checkout's own files steer git too: config keys, control files, a .git that is not a folder ----
cfgwhy='{"v":1,"ok":false,"step":"prepare","why":"checkout-config"}'
refused() {  # refused <what>: prepare was refused as checkout-config, nothing moved or installed
  local rc=$?
  if [ "$rc" = 20 ] && head_is "$A" && [ "$(res)" = "$cfgwhy" ] && ! grep -q '^pnpm\|^install' "$STUBLOG"; then ok "$1: refused (checkout-config), nothing moved"
  else bad "$1: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res)"; fi
}
fresh; mv "$T/co/.git" "$T/gd"; echo "gitdir: $T/gd" > "$T/co/.git"; prepare; refused "a .git that is a gitdir file"
fresh; mv "$T/co/.git" "$T/gd"; ln -s "$T/gd" "$T/co/.git"; prepare; refused "a .git that is a symlink"
for key in core.sshCommand core.pager filter.x.smudge include.path core.attributesFile alias.status uploadpack.packObjectsHook diff.external; do
  fresh; git -C "$T/co" config "$key" "$T/no-such-include"; prepare; refused "config key $key"
done
fresh; git -C "$T/co" config core.hooksPath .githooks; prepare; rc=$?
[ "$rc" = 0 ] && head_is "$B" && ok "core.hooksPath=.githooks (what the checkout's own install-hooks.sh sets) is not refused" || bad "githooks: exit $rc, result $(res)"
fresh; git -C "$T/co" config user.name someone; git -C "$T/co" config branch.main.rebase false; prepare; rc=$?
[ "$rc" = 0 ] && head_is "$B" && ok "the keys a clone and a developer have (branch.*, user.name) are not refused" || bad "plain keys: exit $rc, result $(res)"
for what in info/attributes info/grafts shallow objects/info/alternates config.worktree; do
  fresh; mkdir -p "$(dirname "$T/co/.git/$what")"; : > "$T/co/.git/$what"; prepare; refused "control file .git/$what"
done
fresh; git -C "$T/co" replace --force "$A" "$B" 2>/dev/null; prepare; refused "a refs/replace entry"
fresh; printf '%s refs/replace/%s\n' "$B" "$A" >> "$T/co/.git/packed-refs"; prepare; refused "a packed refs/replace entry"
# ancestry forged by a graft or a replace: a local commit made to look like an ancestor of the release
forge() {  # forge graft|replace: L (a local commit on A) becomes B's parent in the checkout's own view
  git -C "$T/co" checkout -q -b side; echo mine > "$T/co/mine.txt"; git -C "$T/co" add mine.txt; git -C "$T/co" commit -qm mine; L="$(git -C "$T/co" rev-parse HEAD)"
  git -C "$T/co" checkout -q main; git -C "$T/co" update-ref refs/heads/main "$L"; git -C "$T/co" checkout -q main
  if [ "$1" = graft ]; then echo "$B $L" > "$T/co/.git/info/grafts"; else git -C "$T/co" replace --graft "$B" "$L" 2>/dev/null; fi
}
for how in graft replace; do
  fresh; forge "$how"; prepare; rc=$?
  if [ "$rc" = 20 ] && head_is "$L" && ! grep -q '^pnpm\|^install' "$STUBLOG"; then ok "prepare: a local commit made to look like an ancestor by a $how is refused, nothing moved"
  else bad "forged ancestry ($how): exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res)"; fi
  fresh; forge "$how"; git -C "$T/co" checkout -q --detach "$B" 2>/dev/null
  bash "$APPLY" --restore --checkout "$T/co" --to "$L" --commit "$B" --result "$T/r.json" >/dev/null 2>&1; rc=$?
  [ "$rc" = 20 ] && ! head_is "$L" && ok "restore --to: a forged ancestry ($how) is refused" || bad "restore with a forged ancestry ($how): exit $rc, head $(git -C "$T/co" rev-parse --short HEAD)"
  fresh; prepare >/dev/null; : > "$STUBLOG"; forge "$how" 2>/dev/null; git -C "$T/co" checkout -q --detach "$B" 2>/dev/null; INSTALL_RC=9 swap; rc=$?
  if [ "$rc" = 21 ] && ! head_is "$L" && ! grep -q "^pnpm install.*in ${L:0:7}" "$STUBLOG"; then ok "swap's way back (move_back): a forged ancestry ($how) is not checked out or installed"
  else bad "move_back with a forged ancestry ($how): exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi
done
# a .git with a commondir (or a gitdir) file makes git read config, refs, grafts, shallow and alternates from ANOTHER folder
fresh; echo x > "$T/co/.git/commondir"; prepare; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = "$cfgwhy" ] && ok "a .git/commondir file: refused (checkout-config)" || bad "commondir file: exit $rc, result $(res)"
fresh; echo x > "$T/co/.git/gitdir"; prepare; refused "a .git/gitdir file"
common_forge() {  # the checkout's .git keeps HEAD and the index; everything else, with a graft making L look like B's parent, is in another folder
  git -C "$T/co" checkout -q -b side; echo mine > "$T/co/mine.txt"; git -C "$T/co" add mine.txt; git -C "$T/co" commit -qm mine; L="$(git -C "$T/co" rev-parse HEAD)"
  git -C "$T/co" checkout -q --detach "$B"
  cp -R "$T/co/.git" "$T/common"; echo "$B $L" > "$T/common/info/grafts"
  find "$T/co/.git" -mindepth 1 -maxdepth 1 ! -name HEAD ! -name index -exec rm -rf {} +
  echo "$T/common" > "$T/co/.git/commondir"
}
fresh; rm -rf "$T/common"; common_forge
bash "$APPLY" --restore --checkout "$T/co" --to "$L" --commit "$B" --result "$T/r.json" >/dev/null 2>&1; rc=$?
if [ "$rc" = 20 ] && [ "$(cat "$T/r.json")" = '{"v":1,"ok":false,"step":"restore","why":"checkout-config"}' ] && [ "$(cat "$T/co/.git/HEAD")" = "$B" ]; then ok "restore: a .git whose commondir holds a forged graft is refused, nothing moved"
else bad "commondir graft (restore): exit $rc, result $(cat "$T/r.json" 2>/dev/null), HEAD $(cat "$T/co/.git/HEAD" 2>/dev/null)"; fi
fresh; rm -rf "$T/common"; common_forge; REL="$B" prepare; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = "$cfgwhy" ] && ok "prepare: the same checkout is refused (checkout-config)" || bad "commondir graft (prepare): exit $rc, result $(res)"
# --preflight: only the plain-clone check and the strong clean check; moves nothing, fetches nothing
pre() { bash "$APPLY" --preflight --checkout "$T/co" --result "$T/result.json" "$@" >"$T/out.log" 2>&1; }
pre_refused() {  # pre_refused <what> <why>
  local rc=$?
  if [ "$rc" = 20 ] && head_is "$A" && on_main && [ "$(res)" = "{\"v\":1,\"ok\":false,\"step\":\"preflight\",\"why\":\"$2\"}" ] && [ ! -s "$STUBLOG" ]; then ok "preflight: $1 is refused ($2), nothing moved"
  else bad "preflight $1: exit $rc, result $(res), head $(git -C "$T/co" rev-parse --short HEAD)"; fi
}
fresh; pre; rc=$?
if [ "$rc" = 0 ] && [ "$(res)" = '{"v":1,"ok":true,"step":"preflight"}' ] && head_is "$A" && on_main && [ ! -s "$STUBLOG" ]; then ok "preflight: a fresh clone is ok, nothing moved, nothing installed"
else bad "preflight on a fresh clone: exit $rc, result $(res)"; fi
fresh; mkdir -p "$T/co/apps/bridge/node_modules/x"; : > "$T/co/apps/bridge/node_modules/x/f"; pre; rc=$?
[ "$rc" = 0 ] && ok "preflight: an ignored node_modules is not a change" || bad "preflight node_modules: exit $rc, result $(res)"
fresh; git -C "$T/co" config core.sshCommand /tmp/x; pre; pre_refused "a config key (core.sshCommand)" checkout-config
fresh; : > "$T/co/.git/info/grafts"; pre; pre_refused "a control file (info/grafts)" checkout-config
fresh; echo x > "$T/co/.git/commondir"; pre; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"preflight","why":"checkout-config"}' ] && ok "preflight: a commondir file is refused" || bad "preflight commondir file: exit $rc, result $(res)"
fresh; rm -rf "$T/common"; common_forge; pre; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"preflight","why":"checkout-config"}' ] && ok "preflight: a commondir holding a forged graft is refused" || bad "preflight commondir graft: exit $rc, result $(res)"
fresh; git -C "$T/co" update-index --assume-unchanged apps/desktop/scripts/install.sh; echo edited >> "$T/co/apps/desktop/scripts/install.sh"; pre; pre_refused "an assume-unchanged edit" dirty
fresh; echo stray > "$T/co/untracked.txt"; pre; pre_refused "an untracked file" dirty
bash "$APPLY" --preflight --checkout "$T/co" >/dev/null 2>&1; rc=$?
[ "$rc" = 64 ] && ok "preflight without --result: exit 64" || bad "preflight without --result: exit $rc"
# a submodule's own config and attributes steer the status that recurses into it: status ignores submodules
fresh; rm -rf "$T/sub" "$T/subfilter.sh"; mkdir -p "$MARKS"
git init -q -b main "$T/sub"; echo s > "$T/sub/s"; git -C "$T/sub" add s; git -C "$T/sub" commit -qm s
printf '#!/bin/sh\ntouch "%s/submodule-filter"\ncat\n' "$MARKS" > "$T/subfilter.sh"; chmod +x "$T/subfilter.sh"
git -C "$T/co" -c protocol.file.allow=always submodule add -q "$T/sub" sm >/dev/null 2>&1; git -C "$T/co" commit -qm "add sm"
git -C "$T/co" config --remove-section submodule.sm 2>/dev/null
SMG="$(git -C "$T/co" rev-parse --git-path modules/sm)"; case "$SMG" in /*) ;; *) SMG="$T/co/$SMG" ;; esac
printf '[filter "x"]\n\tclean = %s\n' "$T/subfilter.sh" >> "$SMG/config"; mkdir -p "$SMG/info"; echo '* filter=x' > "$SMG/info/attributes"
touch -d "+10 seconds" "$T/co/sm/s"; rm -f "$MARKS/submodule-filter"
pre; rc=$?
if [ "$rc" = 0 ] && [ ! -e "$MARKS/submodule-filter" ]; then ok "preflight: a submodule's filter and attributes never run (status ignores submodules)"
else bad "submodule filter: exit $rc, result $(res), marks: $(ls "$MARKS" | tr '\n' ' ')"; fi
# the clean check sees what plain status hides: ignored files, assume-unchanged and skip-worktree
fresh; mkdir -p "$T/co/apps/bridge/node_modules/x"; echo y > "$T/co/node_modules.txt"; : > "$T/co/apps/bridge/node_modules/x/f"; rm "$T/co/node_modules.txt"; prepare; rc=$?
[ "$rc" = 0 ] && head_is "$B" && ok "an ignored node_modules (what the install makes) is not a change" || bad "node_modules: exit $rc, result $(res)"
fresh; echo 'evil.sh' >> "$T/co/.git/info/exclude"; echo x > "$T/co/evil.sh"; prepare; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"dirty"}' ] && ok "a file hidden by .git/info/exclude is seen by the clean check" || bad "hidden by exclude: exit $rc, result $(res)"
for flag in assume-unchanged skip-worktree; do
  fresh; git -C "$T/co" update-index --"$flag" apps/desktop/scripts/install.sh; echo edited >> "$T/co/apps/desktop/scripts/install.sh"; prepare; rc=$?
  [ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"dirty"}' ] && ok "an edit hidden by $flag is refused" || bad "$flag: exit $rc, result $(res)"
done
# a release OLDER than the checkout is not a local commit: its own word
fresh; git -C "$T/co" checkout -q --detach "$B"; REL="$A" prepare; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"older-release"}' ] && head_is "$B" && ok "prepare: a release older than HEAD is refused as older-release" || bad "older release: exit $rc, result $(res)"
fresh; echo mine > "$T/co/mine.txt"; git -C "$T/co" add mine.txt; git -C "$T/co" commit -qm mine; prepare; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare","why":"local-commits"}' ] && ok "a commit of its own is still local-commits" || bad "local-commits word: exit $rc, result $(res)"
# the release's commit is fetched from the explicit URL the app gives, never from the checkout's own remote
newc() {  # a release commit that is in the public repo but not in the checkout (made after the clone)
  echo "extra $RANDOM" > "$SRC/extra.txt"; git -C "$SRC" add extra.txt; git -C "$SRC" commit -qm C; C="$(git -C "$SRC" rev-parse HEAD)"; git -C "$SRC" push -q -f "$ORIGIN" "$C:refs/heads/rel"
}
fresh; newc; git -C "$T/co" remote set-url origin /nonexistent/never
REL="$C" prepare --repo-url "$ORIGIN"; rc=$?
[ "$rc" = 0 ] && head_is "$C" && ok "a commit not in the checkout is fetched from --repo-url, not from the checkout's own remote" || bad "explicit fetch: exit $rc, result $(res), out: $(tail -2 "$T/out.log")"
fresh; newc; REL="$C" prepare; rc=$?
[ "$rc" = 20 ] && head_is "$A" && ok "with no --repo-url a missing commit is refused (the checkout's remote is not used)" || bad "no url: exit $rc, result $(res)"

echo "the health gate (--swap --health-file)"
export HEALTH_OUT="$T/healthy-9.9.9.json"
hswap() { swap --health-file "$HEALTH_OUT" --health-wait 3; }
mkdir -p "$DEST/.Talos.app.previous"
fresh; prepare; echo stale > "$HEALTH_OUT"; : > "$STUBLOG"; HEALTH_AFTER=1 hswap; rc=$?
if [ "$rc" = 0 ] && head_is "$B" && [ "$(res)" = '{"v":1,"ok":true,"step":"swap"}' ] && ! grep -q -- '--rollback' "$STUBLOG"; then
  ok "the new app reports healthy in time: ok, nothing rolled back"
else bad "healthy: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi
fresh; prepare; echo stale > "$HEALTH_OUT"; : > "$STUBLOG"; hswap; rc=$?
if [ "$rc" = 22 ] && head_is "$A" && on_main && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"unhealthy","restored":true}' ] \
  && grep -q "^install B --rollback --dest $DEST --no-open$" "$STUBLOG" && grep -q "^open $DEST/Talos.app$" "$STUBLOG" && [ ! -e "$HEALTH_OUT" ]; then
  ok "no report from the new app (a stale one from before is removed first): the previous app back, the checkout back, reopened"
else bad "never healthy: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi
fresh; prepare; : > "$STUBLOG"; ROLLBACK_RC=3 hswap; rc=$?
if [ "$rc" = 22 ] && head_is "$B" && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"rollback_failed","restored":false}' ] \
  && [ -d "$DEST/.Talos.app.previous" ] && grep -q "^open $DEST/Talos.app$" "$STUBLOG"; then
  ok "a rollback that fails: said as rollback_failed, the kept copy left in place, the checkout stays with the installed app"
else bad "rollback failed: exit $rc, head $(git -C "$T/co" rev-parse --short HEAD), result $(res), log: $(cat "$STUBLOG")"; fi

# stopped (TERM) after the new app wrote its report: never rolled back
fresh; prepare; : > "$STUBLOG"
HEALTH_AFTER=1 bash "$APPLY" --swap --checkout "$T/co" --commit "$B" --to main --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" \
  --result "$T/result.json" --health-file "$HEALTH_OUT" --health-wait 20 >"$T/out.log" 2>&1 &
SW=$!
for _ in $(seq 1 60); do [ -s "$HEALTH_OUT" ] && break; sleep 0.2; done
kill -TERM "$SW" 2>/dev/null; wait "$SW"; rc=$?
if [ "$(res)" = '{"v":1,"ok":true,"step":"swap"}' ] && ! grep -q -- '--rollback' "$STUBLOG" && head_is "$B"; then
  ok "stopped after the report was written: kept, never rolled back"
else bad "TERM after the report: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi

bash "$APPLY" --swap --checkout "$T/co" --commit "$B" --result "$T/r.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 64 ] && ok "--swap without --to/--zip/--sha256/--team/--dest: exit 64" || bad "missing arguments: exit $rc"

# ---- the archive checkout: a sha256-pinned source tarball instead of git ----
# Real tarballs made here with tar (and python3's tarfile for the ones tar will not make: a link to /etc, a device, a .. member). The
# checkout is a plain folder (no .git); git on the PATH is a stub that leaves a mark, so a git call anywhere on these paths shows.
echo "the archive checkout (no git, only a pinned tarball)"
NOSTUB_PATH="${PATH#"$STUB:"}"
# The archive modes run under `bash -p` and drop the whole environment, so the stubs can not read their settings (STUBLOG, INSTALL_RC, ...)
# from it: wenv writes the ones that are set into $STUBENV before each run, and every stub sources that file.
STUBENV="$T/stub.env"; : > "$STUBENV"
STUBVARS="STUBLOG MVCOUNT HASHLOG HASHCOUNT GITLOG HEALTH_OUT PNPM_TERM_AT PNPM_FAIL_AT PNPM_MAKE_LINK MV_FAIL_AT MV_NEST_AT SWAP_AFTER_HASH BUN_RC ROLLBACK_RC INSTALL_RC INSTALL_SLEEP HEALTH_AFTER ENV_DUMP FN_DUMP"
wenv() { local n; : > "$STUBENV"; for n in $STUBVARS; do [ -z "${!n+x}" ] || printf 'export %s=%q\n' "$n" "${!n}" >> "$STUBENV"; done; }
abash() { wenv; bash -p "$@"; }
addenv() { local f="$1"; { head -n 1 "$f"; printf '. "%s"\n' "$STUBENV"; tail -n +2 "$f"; } > "$f.new" && mv "$f.new" "$f" && chmod +x "$f"; }
STUBA="$T/stubA"; mkdir -p "$STUBA"; cp "$STUB/osascript" "$STUB/open" "$STUBA/"
GITLOG="$T/git-calls.log"; : > "$GITLOG"; export GITLOG
printf '#!/bin/bash\necho "git $*" >> "$GITLOG"\nexit 1\n' > "$STUBA/git"
# pnpm: logs every call (arguments, its number, the folder it ran in, and whether the hooks were off), never runs git; PNPM_FAIL_AT
# fails that call (1 = the install, 2 = the rebuild); PNPM_TERM_AT sends TERM to the apply script
cat > "$STUBA/pnpm" <<'S'
#!/bin/bash
n=$(( $(grep -c '^pnpm ' "$STUBLOG" 2>/dev/null || true) + 1 ))
echo "pnpm $* (call $n, in $(basename "$PWD"), hooks=${TALOS_NO_HOOKS:-})" >> "$STUBLOG"
[ -n "${ENV_DUMP:-}" ] && env > "$ENV_DUMP"
[ -n "${FN_DUMP:-}" ] && { declare -F; type tar; echo "SHELLOPTS=$SHELLOPTS"; } > "$FN_DUMP"
[ "${PNPM_TERM_AT:-}" = "$n" ] && kill -TERM "$(ps -o ppid= -p "$PPID" | tr -d ' ')"
[ "${PNPM_FAIL_AT:-}" = "$n" ] && exit 1
[ -n "${PNPM_MAKE_LINK:-}" ] && [ "$n" = 1 ] && mkdir -p node_modules && ln -s "it's a target" node_modules/l
exit 0
S
# mv: fails its MV_FAIL_AT-th call (counted in $MVCOUNT), else the real one
printf '#!/bin/bash\nn=$(cat "$MVCOUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$MVCOUNT"\n[ "$n" = "${MV_FAIL_AT:-0}" ] && exit 1\n[ "$n" = "${MV_NEST_AT:-0}" ] && mkdir -p "${@: -1}"\nexec /bin/mv "$@"\n' > "$STUBA/mv"
# shasum: the real one (the script prefers it to sha256sum); for the private copy of the tarball (a file in a .apply-tar.* folder) it logs the
# folder's mode and, after the first hash of it, puts $SWAP_AFTER_HASH in its place (the copy swapped after it was checked)
cat > "$STUBA/shasum" <<'S'
#!/bin/bash
/usr/bin/shasum "$@"
rc=$?
for last; do :; done
case "$last" in
  */.apply-tar.*/*)
    d="$(dirname "$last")"; echo "$(stat -c %a "$d" 2>/dev/null || stat -f %Lp "$d") $(dirname "$d")" >> "$HASHLOG"
    n=$(cat "$HASHCOUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$HASHCOUNT"
    [ "$n" = 1 ] && [ -n "${SWAP_AFTER_HASH:-}" ] && cp "$SWAP_AFTER_HASH" "$last" ;;
esac
exit $rc
S
chmod +x "$STUBA"/*; for f in "$STUBA"/*; do addenv "$f"; done
export MVCOUNT="$T/mv-count" HASHLOG="$T/hash.log" HASHCOUNT="$T/hash-count"
STUBB="$T/stubB"; mkdir -p "$STUBB"; cp "$STUBA/osascript" "$STUBA/open" "$STUBA/git" "$STUBB/"
printf '#!/bin/bash\necho "bun $* (hooks=${TALOS_NO_HOOKS:-}, in $(basename "$PWD"))" >> "$STUBLOG"\nexit ${BUN_RC:-0}\n' > "$STUBB/bun"; chmod +x "$STUBB"/*; addenv "$STUBB/bun"
STUBG="$T/stubG"; mkdir -p "$STUBG"; cp "$STUBA/git" "$STUBG/"
APATH="$STUBA:$PATH"; BPATH="$STUBB:/usr/bin:/bin"
# The archive modes take every tool from the one SAFE_PATH line of the script (never from the caller's PATH, and no override exists in
# the installed script). THIS TEST runs copies of the script in its temp dir whose SAFE_PATH line is rewritten to the stub folders, and
# checks that the rewrite really happened. The copies exist only here; the app runs the real file.
patched_copy() { tool_dirs_copy "$@"; }
patched_copy apply-a "$(nospace "$STUBA") /usr/bin /bin /usr/sbin /sbin"; patched_copy apply-b "$(nospace "$STUBB") /usr/bin /bin"; patched_copy apply-g "$(nospace "$STUBG") /usr/bin /bin /usr/sbin /sbin"
patched_copy apply-esc 'a&b|c\d'; grep -F -q -x 'TOOL_DIRS="a&b|c\d"' "$T/apply-esc.sh" && ok "the test's TOOL_DIRS rewrite escapes & | and a backslash in the new value" || bad "SAFE_PATH rewrite did not escape & | \\"
APPLY_A="$T/apply-a.sh"; APPLY_B="$T/apply-b.sh"; APPLY_G="$T/apply-g.sh"
sha256f() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# the good release tarball, made as release-app.sh makes it (a top folder, gzip -n -9); the repo has no links, so neither has this
AS="$T/asrc"; rm -rf "$AS"; mkdir -p "$AS/talos-9.9.9/apps/desktop/scripts" "$AS/talos-9.9.9/apps/bridge"
echo '{}' > "$AS/talos-9.9.9/package.json"; echo lock > "$AS/talos-9.9.9/pnpm-lock.yaml"; echo hi > "$AS/talos-9.9.9/README.md"
# its install.sh: logs (as "install T"), --rollback exits ROLLBACK_RC, an install exits INSTALL_RC (after INSTALL_SLEEP); a good one
# writes the health report after HEALTH_AFTER seconds when that is set
printf '#!/bin/bash\necho "install T $*" >> "$STUBLOG"\n[ -n "${FN_DUMP:-}" ] && { declare -F; type tar; echo "SHELLOPTS=$SHELLOPTS"; } > "$FN_DUMP.install"\n[ "$1" = --rollback ] && exit ${ROLLBACK_RC:-0}\nrc=${INSTALL_RC:-0}\nsleep "${INSTALL_SLEEP:-0}"\nif [ "$rc" = 0 ] && [ -n "${HEALTH_AFTER:-}" ]; then ( sleep "$HEALTH_AFTER"; echo "{\\"v\\":1}" > "$HEALTH_OUT" ) & fi\nexit $rc\n' > "$AS/talos-9.9.9/apps/desktop/scripts/install.sh"
chmod +x "$AS/talos-9.9.9/apps/desktop/scripts/install.sh"; addenv "$AS/talos-9.9.9/apps/desktop/scripts/install.sh"
GOOD="$T/good.tgz"; ( cd "$AS" && tar -cf - talos-9.9.9 | gzip -n -9 > "$GOOD" ); GOODSHA="$(sha256f "$GOOD")"

ACO="$T/aco"; TREE=""
afresh() { rm -rf "$ACO" "$ACO.next" "$ACO.previous" "$ACO".failed.* "$ACO".discard.* "$T/result.json" "$T/victim" "$MVCOUNT" "$HASHLOG" "$HASHCOUNT" "$T"/.apply-tar.*; : > "$STUBLOG"; mkdir -p "$ACO"; echo old > "$ACO/OLD"; TREE=""; }
aprep() {  # aprep <tarball> <sha256> [more arguments]; sets TREE from the result. APREP_SCRIPT, APREP_NOPNPM, APREP_BUN pick the variant
  local rc script="${APREP_SCRIPT:-$APPLY_A}" a=(--pnpm "$STUBA/pnpm")
  [ -z "${APREP_NOPNPM:-}" ] || a=()
  [ -z "${APREP_BUN:-}" ] || a=(${a[@]+"${a[@]}"} --bun "$STUBB/bun")
  abash "$script" --prepare-archive --checkout "$ACO" --tarball "$1" --sha256 "$2" --commit "$B" --tag "${ATAG:-mac-v9.9.9}" \
    --version 9.9.9 --result "$T/result.json" ${a[@]+"${a[@]}"} "${@:3}" >"$T/out.log" 2>&1
  rc=$?
  TREE="$(sed -n 's/.*"tree_sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$T/result.json" 2>/dev/null)"
  return $rc
}
# the swap's own arguments: the commit, the version and the tree digest prepare printed (later arguments win)
aswap() {
  abash "$APPLY_A" --swap --archive --checkout "$ACO" --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" \
    --result "$T/result.json" --commit "$B" --version 9.9.9 --tree-sha256 "$TREE" "$@" >"$T/out.log" 2>&1
}
arestore() { abash "$APPLY_A" --restore --archive --checkout "$ACO" --result "$T/result.json" "$@" >"$T/out.log" 2>&1; }
old_intact() { [ "$(cat "$ACO/OLD" 2>/dev/null)" = old ] && [ ! -e "$ACO.next" ] && [ ! -e "$ACO.previous" ]; }
nogit() { [ ! -s "$GITLOG" ]; }
nosnap() { [ -z "$(ls -d "$T"/.apply-tar.* 2>/dev/null)" ]; }
OKPREP='"ok":true,"step":"prepare-archive"'
STAMP="{\"v\":1,\"tag\":\"mac-v9.9.9\",\"version\":\"9.9.9\",\"gitSha\":\"$B\"}"
PSAFE="--config.ignore-pnpmfile=true --config.manage-package-manager-versions=false --config.userconfig=/dev/null --config.globalconfig=/dev/null"

# prepare-archive: ok
afresh; aprep "$GOOD" "$GOODSHA"; rc=$?
want_log="pnpm install --frozen-lockfile --ignore-scripts $PSAFE (call 1, in aco.next, hooks=1)
pnpm -r rebuild $PSAFE better-sqlite3 esbuild (call 2, in aco.next, hooks=1)"
if [ "$rc" = 0 ] && [ "$(res)" = "{\"v\":1,$OKPREP,\"tree_sha256\":\"$TREE\"}" ] && [ ${#TREE} = 64 ] && [ "$(cat "$ACO.next/.talos-source.json")" = "$STAMP" ] \
  && [ "$(mode_of "$ACO.next/.talos-source.json")" = 644 ] && [ "$(mode_of "$ACO.next")" = 755 ] \
  && [ -f "$ACO.next/README.md" ] && [ ! -e "$ACO.next/talos-9.9.9" ] \
  && [ "$(cat "$ACO/OLD")" = old ] && [ "$(ls -A "$ACO")" = OLD ] && [ "$(cat "$STUBLOG")" = "$want_log" ] && nogit && nosnap \
  && [ -z "$(find "$ACO.next" ! -type l \( -perm -020 -o -perm -002 \) -print)" ]; then
  ok "prepare-archive: unpacked without its top folder into DIR.next (0755), stamped (0644), packages installed locked down (no pnpmfile, no other pnpm), the tree digest in the result, DIR untouched, no git"
else bad "prepare-archive: exit $rc, result $(res), stamp $(cat "$ACO.next/.talos-source.json" 2>/dev/null), top $(mode_of "$ACO.next"), log: $(cat "$STUBLOG"), git: $(cat "$GITLOG")"; fi
# the private copy of the tarball: a 0700 folder beside the checkout, the hash taken from it, and gone afterwards
if [ -s "$HASHLOG" ] && [ "$(sort -u "$HASHLOG")" = "700 $T" ]; then ok "prepare-archive: the tarball is hashed from a private 0700 copy in a folder beside the checkout, removed afterwards"
else bad "private copy: hash log: $(cat "$HASHLOG" 2>/dev/null)"; fi
# the copy swapped after it was hashed is not unpacked: it is hashed again before the unpacking
if command -v python3 >/dev/null 2>&1; then
  python3 -I - "$T/evil.tgz" <<'PY'
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as tf:
    t = tarfile.TarInfo('talos-9.9.9/'); t.type = tarfile.DIRTYPE; tf.addfile(t)
    t = tarfile.TarInfo('talos-9.9.9/EVIL'); t.size = 1; tf.addfile(t, io.BytesIO(b'x'))
PY
  afresh; SWAP_AFTER_HASH="$T/evil.tgz" aprep "$GOOD" "$GOODSHA"; rc=$?
  [ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"sha256"}' ] && old_intact && nosnap && [ ! -s "$STUBLOG" ] \
    && ok "prepare-archive: a copy swapped after it was hashed is refused (sha256), nothing unpacked" || bad "swapped copy: exit $rc, result $(res), ls: $(ls -A "$T" | grep -i 'aco\|apply' | tr '\n' ' ')"
fi
# the pnpm allowlist is the root package.json's own (pnpm.onlyBuiltDependencies)
ROOTPKG="$HERE/../../package.json"
if [ -f "$ROOTPKG" ]; then
  have="$(awk '/onlyBuiltDependencies/{f=1;next} f&&/\]/{exit} f{gsub(/[ ",]/,""); if ($0 != "") printf "%s ", $0}' "$ROOTPKG" | sed 's/ $//')"
  mine="$(sed -n 's/^ARCHIVE_BUILD_ALLOW="\(.*\)"$/\1/p' "$APPLY_REAL")"
  [ -n "$have" ] && [ "$have" = "$mine" ] && ok "the archive install's script allowlist ($mine) is package.json's pnpm.onlyBuiltDependencies" || bad "allowlist: script '$mine', package.json '$have'"
fi
# a stale DIR.next is replaced
afresh; mkdir -p "$ACO.next"; echo stale > "$ACO.next/STALE"; aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 0 ] && [ ! -e "$ACO.next/STALE" ] && [ -f "$ACO.next/README.md" ] && ok "prepare-archive: a stale DIR.next is removed first" || bad "stale DIR.next: exit $rc, result $(res)"
# DIR.next a symlink: refused, never followed
afresh; mkdir -p "$T/victim"; echo keep > "$T/victim/KEEP"; ln -s "$T/victim" "$ACO.next"; aprep "$GOOD" "$GOODSHA"; rc=$?
if [ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"checkout"}' ] && [ -L "$ACO.next" ] && [ "$(cat "$T/victim/KEEP")" = keep ] && [ -z "$(ls "$T/victim" | grep -v KEEP)" ]; then
  ok "prepare-archive: a DIR.next that is a symlink is refused, and what it points at is untouched"
else bad "symlink DIR.next: exit $rc, result $(res)"; fi
rm -f "$ACO.next"
# wrong sha256, and a tarball that is not there: each its own word
afresh; aprep "$GOOD" "$PIN"; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"sha256"}' ] && old_intact && [ ! -s "$STUBLOG" ] && nogit && nosnap \
  && ok "prepare-archive: a tarball that is not the pinned sha256 is refused (sha256), nothing unpacked, no install" || bad "wrong sha: exit $rc, result $(res)"
afresh; aprep "$T/not-there.tgz" "$PIN"; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"tarball"}' ] && old_intact && nosnap \
  && ok "prepare-archive: a tarball that is missing or unreadable is refused as tarball, not sha256" || bad "missing tarball: exit $rc, result $(res)"
# unsafe archives are refused from their listing, before anything is unpacked. The repo has no links, so EVERY link is refused.
cat > "$T/mkbad.py" <<'PY'
import io, sys, tarfile
kind, out = sys.argv[1], sys.argv[2]
TOP = 'talos-9.9.9'
def d(name):
    t = tarfile.TarInfo(name); t.type = tarfile.DIRTYPE; t.mode = 0o755; return t
def f(name, data=b'x'):
    t = tarfile.TarInfo(name); t.size = len(data); t.mode = 0o644; return (t, io.BytesIO(data))
def n(name, typ, link='', major=0, minor=0):
    t = tarfile.TarInfo(name); t.type = typ; t.linkname = link; t.devmajor = major; t.devminor = minor; t.mode = 0o777; return t
S, H = tarfile.SYMTYPE, tarfile.LNKTYPE
m = [d(TOP + '/'), f(TOP + '/package.json', b'{}')]
extra = {
  'dotdot': [f(TOP + '/../../escape-marker')],
  'dotdot-mid': [f(TOP + '/a/../../b')],
  'dot-component': [f(TOP + '/./a')],
  'newline-name': [f(TOP + '/a'+chr(10)+'b')],
  'absolute': [f('/tmp/talos-abs-marker')],
  'outside-top': [f('other/file')],
  'two-tops': [f('talos-9.8.8/file')],
  'top-level-file': [f('stray')],
  'symlink-plain': [n(TOP + '/l', S, 'package.json')],
  'symlink-absolute': [n(TOP + '/l', S, '/etc/passwd')],
  'symlink-up': [n(TOP + '/l', S, '../escape')],
  'symlink-deep': [n(TOP + '/a/b/l', S, '../../../escape')],
  'hardlink-plain': [n(TOP + '/h', H, TOP + '/package.json')],
  'hardlink-absolute': [n(TOP + '/h', H, '/etc/passwd')],
  'hardlink-outside': [n(TOP + '/h', H, 'other/file')],
  'hardlink-up': [n(TOP + '/h', H, TOP + '/../x')],
  'through-link': [n(TOP + '/d', S, 'sub'), f(TOP + '/d/evil')],
  'chain': [d(TOP + '/s/'), n(TOP + '/s/b', S, '..'), n(TOP + '/a', S, 's/b/..'), f(TOP + '/a/evil')],
  'dot-through-link': [n(TOP + '/d', S, '/tmp'), f(TOP + '/./d/evil')],
  'case-variant': [n(TOP + '/d', S, '/tmp'), f(TOP + '/D/evil')],
  'device': [n(TOP + '/dev', tarfile.CHRTYPE, '', 1, 3)],
  'fifo': [n(TOP + '/pipe', tarfile.FIFOTYPE)],
}[kind]
with tarfile.open(out, 'w:gz') as tf:
    for x in m + extra:
        tf.addfile(*x) if isinstance(x, tuple) else tf.addfile(x)
PY
if command -v python3 >/dev/null 2>&1; then
  for kind in dotdot dotdot-mid dot-component newline-name absolute outside-top two-tops top-level-file symlink-plain symlink-absolute symlink-up symlink-deep hardlink-plain hardlink-absolute hardlink-outside hardlink-up through-link chain dot-through-link case-variant device fifo; do
    afresh; python3 -I "$T/mkbad.py" "$kind" "$T/bad-$kind.tgz"; aprep "$T/bad-$kind.tgz" "$(sha256f "$T/bad-$kind.tgz")"; rc=$?
    if [ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"archive"}' ] && old_intact && [ ! -s "$STUBLOG" ] && nosnap \
      && [ ! -e "$T/escape-marker" ] && [ ! -e "$(dirname "$T")/escape-marker" ] && nogit; then ok "prepare-archive: an archive with $kind is refused (archive) before anything is unpacked"
    else bad "archive with $kind: exit $rc, result $(res), out: $(tail -2 "$T/out.log")"; fi
  done
else echo "  skip the unsafe-archive cases (no python3)"; fi
afresh; echo junk | gzip > "$T/junk.tgz"; aprep "$T/junk.tgz" "$(sha256f "$T/junk.tgz")"; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"archive"}' ] && old_intact && ok "prepare-archive: a file that is not a gzip tar is refused (archive)" || bad "junk: exit $rc, result $(res)"
# caps: the unpacked size and the number of entries (the test lowers them; the script only lets them be lowered)
afresh; TALOS_APPLY_MAX_BYTES=2000 aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"archive"}' ] && old_intact && [ ! -s "$STUBLOG" ] && nosnap && ok "prepare-archive: an archive that unpacks past the size cap is refused (archive)" || bad "size cap: exit $rc, result $(res)"
afresh; TALOS_APPLY_MAX_ENTRIES=3 aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"archive"}' ] && old_intact && [ ! -s "$STUBLOG" ] && ok "prepare-archive: an archive with more entries than the cap is refused (archive)" || bad "entry cap: exit $rc, result $(res)"
afresh; TALOS_APPLY_MAX_BYTES=99999999999 TALOS_APPLY_MAX_ENTRIES=99999999999 aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 0 ] && ok "prepare-archive: the caps can be lowered, not raised (a bigger value is ignored)" || bad "raised caps: exit $rc, result $(res)"
# the packages: a failing install, or a failing rebuild, removes DIR.next
for at in 1 2; do
  afresh; PNPM_FAIL_AT=$at aprep "$GOOD" "$GOODSHA"; rc=$?
  [ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"deps"}' ] && old_intact && nogit && nosnap \
    && ok "prepare-archive: pnpm call $at failing refuses (deps), DIR.next is removed, DIR untouched" || bad "pnpm fail $at: exit $rc, result $(res), ls: $(ls "$T")"
done
afresh; BUN_RC=1 APREP_SCRIPT="$APPLY_B" APREP_NOPNPM=1 APREP_BUN=1 aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"deps"}' ] && old_intact && ok "prepare-archive: a failing bun install refuses the same way" || bad "bun fail: exit $rc, result $(res)"
afresh; APREP_SCRIPT="$APPLY_B" APREP_NOPNPM=1 APREP_BUN=1 aprep "$GOOD" "$GOODSHA"; rc=$?
if [ "$rc" = 0 ] && [ -n "$TREE" ] && [ "$(cat "$STUBLOG")" = "bun install --frozen-lockfile --ignore-scripts (hooks=1, in aco.next)" ] && nogit; then
  ok "prepare-archive with no pnpm: bun install --frozen-lockfile --ignore-scripts (no script of any package runs), in DIR.next"
else bad "bun prepare: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi
afresh; PNPM_TERM_AT=1 aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 21 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"stopped"}' ] && old_intact && nosnap && ok "prepare-archive stopped by a signal: DIR.next and the private copy removed, DIR untouched" || bad "TERM: exit $rc, result $(res), ls: $(ls -A "$T" | tr '\n' ' ')"

# the REAL pnpm on a small workspace: only the allowlisted package's install script runs (not the root's prepare or postinstall, not a
# member's postinstall, not another dependency's), a .pnpmfile.cjs never loads, and a packageManager pin does not fetch another pnpm
if PATH="$NOSTUB_PATH" command -v pnpm >/dev/null 2>&1; then
  MW="$T/mw"; MK="$T/mw-marks"; rm -rf "$MW" "$MK"; mkdir -p "$MK" "$MW/talos-9.9.9/pkg" "$MW/talos-9.9.9/vendor/esbuild" "$MW/talos-9.9.9/vendor/other"
  W="$MW/talos-9.9.9"
  for dep in esbuild other; do printf '{"name":"%s","version":"1.0.0","scripts":{"postinstall":"touch \047%s/%s\047"}}\n' "$dep" "$MK" "$dep" > "$W/vendor/$dep/package.json"; done
  printf '{"name":"root","version":"1.0.0","private":true,"scripts":{"prepare":"touch \047%s/root-prepare\047","postinstall":"touch \047%s/root-postinstall\047"},"pnpm":{"onlyBuiltDependencies":["esbuild"]}}\n' "$MK" "$MK" > "$W/package.json"
  printf 'packages:\n  - pkg\n' > "$W/pnpm-workspace.yaml"
  printf '{"name":"pkg","version":"1.0.0","scripts":{"postinstall":"touch \047%s/member-postinstall\047"},"dependencies":{"esbuild":"file:../vendor/esbuild","other":"file:../vendor/other"}}\n' "$MK" > "$W/pkg/package.json"
  ( cd "$W" && PATH="$NOSTUB_PATH" pnpm install --ignore-scripts >/dev/null 2>&1 ); rm -rf "$W/node_modules" "$W/pkg/node_modules"; rm -f "$MK"/*
  sed -i.bak 's/"private":true,/"private":true,"packageManager":"pnpm@9.15.0",/' "$W/package.json"; rm -f "$W/package.json.bak"
  printf "require('fs').writeFileSync('%s/pnpmfile','x'); module.exports = {}\n" "$MK" > "$W/.pnpmfile.cjs"
  ( cd "$MW" && tar -cf - talos-9.9.9 | gzip -n -9 > "$T/mw.tgz" )
  mkdir -p "$HOME"; printf 'store-dir=%s/evil-store\n' "$T" > "$HOME/.npmrc"; rm -rf "$T/evil-store" "$T/evil-store2"
  mkdir -p "$HOME/.config/pnpm"; printf 'store-dir=%s/evil-store2\n' "$T" > "$HOME/.config/pnpm/rc"
  afresh; APREP_SCRIPT="$APPLY_G" aprep "$T/mw.tgz" "$(sha256f "$T/mw.tgz")" --pnpm "$(PATH="$NOSTUB_PATH" command -v pnpm)"; rc=$?
  if [ "$rc" = 0 ] && [ ! -e "$T/evil-store" ] && [ ! -d "$T/evil-store" ]; then ok "real pnpm: a store-dir set in the agent-writable ~/.npmrc is not honoured (--config.userconfig=/dev/null)"; else bad "user npmrc honoured: exit $rc, store dir made: $([ -e "$T/evil-store" ] && echo yes || echo no)"; fi
  if [ ! -e "$T/evil-store2" ]; then ok "real pnpm: a store-dir set in pnpm's own rc (~/.config/pnpm/rc) is not honoured (XDG_CONFIG_HOME is an empty private folder; pnpm checks it first on every platform)"; else bad "pnpm global rc honoured: store dir made"; fi
  rm -f "$HOME/.npmrc"; rm -rf "$HOME/.config/pnpm"
  if [ "$rc" = 0 ] && [ "$(ls "$MK")" = esbuild ] && nogit; then
    ok "real pnpm: only the allowlisted package's install script ran (not root prepare/postinstall, a member's, another dependency's, or a .pnpmfile.cjs), and the packageManager pin fetched nothing"
  else bad "real pnpm: exit $rc, result $(res), markers: $(ls "$MK" | tr '\n' ' '), out: $(tail -5 "$T/out.log")"; fi
else echo "  skip the real-pnpm workspace case (no pnpm)"; fi

# The archive modes use the system tools only: a planted sha256sum / shasum / tar first in the CALLER's PATH is not used. These run the REAL script.
FAKE="$T/fakebin"; rm -rf "$FAKE"; mkdir -p "$FAKE"; FAKEMARK="$T/fake-ran"; rm -f "$FAKEMARK"
for tool in sha256sum shasum; do printf '#!/bin/bash\ntouch "%s"\nfor last; do :; done\necho "%s  $last"\n' "$FAKEMARK" "$PIN" > "$FAKE/$tool"; done
printf '#!/bin/bash\ntouch "%s"\nexit 1\n' "$FAKEMARK" > "$FAKE/tar"; chmod +x "$FAKE"/*
afresh; PATH="$FAKE:$PATH" abash "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$PIN" --commit "$B" --tag mac-v9.9.9 \
  --version 9.9.9 --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"sha256"}' ] && [ ! -e "$FAKEMARK" ] && old_intact \
  && ok "prepare-archive: a fake sha256sum/shasum first in the caller's PATH (printing the expected hash) is not used: the wrong tarball is refused (sha256)" || bad "fake sha256sum: exit $rc, result $(res), fake used: $([ -e "$FAKEMARK" ] && echo yes || echo no)"
afresh; rm -f "$FAKEMARK"; PATH="$FAKE:$PATH" abash "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 \
  --version 9.9.9 --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1; rc=$?
[ "$rc" = 0 ] && [ ! -e "$FAKEMARK" ] && [ -f "$ACO.next/README.md" ] && ok "prepare-archive: with the real hash, the real tar unpacks it and no planted sha256sum/shasum/tar ever runs" || bad "fake tools on PATH: exit $rc, result $(res), fake used: $([ -e "$FAKEMARK" ] && echo yes || echo no)"
# --pnpm / --bun: absolute, an executable regular file; with neither, deps (never the PATH)
for bad_pnpm in "relative/pnpm" "pnpm" "$T/not-there" "$T"; do
  afresh; abash "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" --pnpm "$bad_pnpm" >/dev/null 2>&1; rc=$?
  [ "$rc" = 64 ] && old_intact && ok "prepare-archive --pnpm $bad_pnpm: exit 64" || bad "--pnpm $bad_pnpm: exit $rc"
done
echo '#!/bin/sh' > "$T/plain-file"; chmod 644 "$T/plain-file"
afresh; abash "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" --pnpm "$T/plain-file" >/dev/null 2>&1; rc=$?
[ "$rc" = 64 ] && ok "prepare-archive --pnpm at a file that is not executable: exit 64" || bad "--pnpm not executable: exit $rc"
afresh; abash "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" --bun "rel/bun" >/dev/null 2>&1; rc=$?
[ "$rc" = 64 ] && ok "prepare-archive --bun relative: exit 64" || bad "--bun relative: exit $rc"
afresh; PATH="$STUBA:$PATH" abash "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" >"$T/out.log" 2>&1; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"deps"}' ] && old_intact && [ ! -s "$STUBLOG" ] \
  && ok "prepare-archive with neither --pnpm nor --bun: deps (a pnpm on the caller's PATH is not used)" || bad "neither: exit $rc, result $(res), log: $(cat "$STUBLOG")"
# a bare interpreter or tool name in the script's code would be found through the caller's PATH: quoted text, comments, --options,
# absolute paths and $(tool x) are dropped first, then any word bash/sh/zsh/env/node/bun/pnpm/git left is reported. Allowed, and only
# these exact forms: the git modes' documented PATH git default and pnpm/bun deps fallback (docs/FOLLOWUPS.md: git modes and PATH).
bare_interp() {
  grep -n '' "$1" | grep -vE '^[0-9]+:[[:space:]]*#' \
    | grep -vF -e 'TALOS_NO_HOOKS=1 bun install --frozen-lockfile --ignore-scripts </dev/null' -e 'else pnpm install --frozen-lockfile </dev/null; fi )' \
    | sed -E -e "s/\"[^\"]*\"//g" -e "s/'[^']*'//g" \
        -e 's#(^|[^[:alnum:]_.$-])/[^[:space:];)|&`]+#\1#g' \
        -e 's/--[[:alnum:]-]+//g' \
        -e 's/\$\(tool [[:alnum:]_-]+\)//g' \
        -e 's/(\]|=) (bun|pnpm) \]/]/g' \
        -e 's/[[:space:]]#.*$//' -e 's/ GIT_BIN=git$//' \
    | grep -wE 'bash|sh|zsh|env|node|bun|pnpm|git'
}
# the check itself catches what it should: each planted form below must be reported
BAD_INTERP="$T/bad-interp.sh"; cp "$APPLY_REAL" "$BAD_INTERP"
printf '%s\n' 'x || bash a' 'if y; then sh b; fi' 'exec zsh c' 'v=`git status`' 'env FOO=1 node d' 'true;bash e' '( bun f )' 'command pnpm g' 'for i in 1; do git h; done' >> "$BAD_INTERP"
n_bad="$(bare_interp "$BAD_INTERP" | wc -l | tr -d ' ')"
[ "$n_bad" = 9 ] && ok "the bare-interpreter check reports each of 9 planted forms (||, then, exec, backticks, env, ;, (, command, do)" \
  || bad "bare-interpreter check found $n_bad of 9 planted forms: $(bare_interp "$BAD_INTERP" | cut -c1-60 | tr '\n' '|')"
# the script itself: ONE TOOL_DIRS line (the fixed system folders), tool() reading nothing from the environment, no other PATH setting or override
n_tool="$(grep -c '^TOOL_DIRS=' "$APPLY_REAL")"
if [ "$n_tool" = 1 ] && grep -q -x 'TOOL_DIRS="/usr/bin /bin /usr/sbin /sbin"' "$APPLY_REAL" \
  && [ -z "$(grep -n 'TALOS_APPLY_TOOL_DIR\|TALOS_APPLY_[A-Z_]*PATH\|TEST_PATH\|APPLY_TEST\|SAFE_PATH' "$APPLY_REAL")" ] \
  && [ "$(grep -c '^tool() {' "$APPLY_REAL")" = 1 ] && grep '^tool() {' "$APPLY_REAL" | grep -q 'for d in \$TOOL_DIRS; do' && ! grep '^tool() {' "$APPLY_REAL" | grep -q '\${TALOS\|\$PATH' \
  && [ -z "$(bare_interp "$APPLY_REAL")" ] \
  && [ "$(grep -c '^ *export PATH=' "$APPLY_REAL")" = 0 ] \
  && [ -z "$(grep -n 'PATH=' "$APPLY_REAL" | grep -v '^[0-9]*: *#' | grep -v 'TOOL_PATH="\${TOOL_DIRS// /:}"$' | grep -v 'clean=(PATH="\$TOOL_PATH"' | grep -v 'PATH="\$TOOL_PATH:')" ]; then
  ok "the script has exactly one TOOL_DIRS= line (the fixed system folders), a tool() that reads nothing from the environment, no bare interpreter or tool name, and no other PATH setting or override"
else bad "TOOL_DIRS lines: $n_tool; bare interpreters: $(bare_interp "$APPLY_REAL" | cut -c1-80 | tr '\n' '|'); other PATH= lines: $(grep -n 'PATH=' "$APPLY_REAL" | grep -v '^[0-9]*: *#' | cut -c1-100 | tr '\n' '|')"; fi
# bash -p is required: without it the caller's exported functions and BASH_ENV would run first
for mode_args in "--prepare-archive --tarball $GOOD --sha256 $GOODSHA --commit $B --tag mac-v9.9.9 --version 9.9.9" "--restore --archive"; do
  afresh; bash "$APPLY_REAL" $mode_args --checkout "$ACO" --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1; rc=$?
  [ "$rc" = 64 ] && [ ! -e "$T/result.json" ] && old_intact && ok "an archive mode run without bash -p ($(echo "$mode_args" | cut -d' ' -f1-2)): exit 64, nothing done" || bad "no -p ($mode_args): exit $rc, result $(res)"
done
# ... and under bash -p an exported function, BASH_ENV, SHELLOPTS+PS4 and TAR_OPTIONS from the caller's environment change nothing
cat > "$T/benv.sh" <<BENV
touch "$T/benv-mark"
shasum() { echo "$PIN  \$2"; }
sha256sum() { echo "$PIN  \$2"; }
BENV
env_attack() {  # env_attack <sha256 to give>
  wenv
  (
    shasum() { echo "$PIN  ${@: -1}"; touch "$T/func-mark"; }; sha256sum() { echo "$PIN  ${@: -1}"; touch "$T/func-mark"; }; tar() { touch "$T/func-mark"; return 1; }
    export -f shasum sha256sum tar
    env BASH_ENV="$T/benv.sh" ENV="$T/benv.sh" SHELLOPTS=xtrace PS4="\$(touch $T/ps4-mark)" TAR_OPTIONS="--to-command=touch $T/tar-mark" \
      bash -p "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$1" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1
  )
}
marks() { ls "$T"/func-mark "$T"/benv-mark "$T"/ps4-mark "$T"/tar-mark 2>/dev/null | tr '\n' ' '; }
rm -f "$T"/func-mark "$T"/benv-mark "$T"/ps4-mark "$T"/tar-mark
afresh; env_attack "$PIN"; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"sha256"}' ] && [ -z "$(marks)" ] && old_intact \
  && ok "bash -p: an exported sha256sum/shasum/tar function, BASH_ENV, SHELLOPTS+PS4 and TAR_OPTIONS do nothing: the wrong tarball is refused (sha256), no marker" || bad "env attack, wrong tarball: exit $rc, result $(res), marks: $(marks)"
afresh; env_attack "$GOODSHA"; rc=$?
[ "$rc" = 0 ] && [ -z "$(marks)" ] && [ -f "$ACO.next/README.md" ] && ok "bash -p with the same environment: the good tarball still prepares, no marker" || bad "env attack, good tarball: exit $rc, result $(res), marks: $(marks)"
# the environment the tools run with: only the allowlist (and PATH, LC_ALL, LANG the script sets)
afresh; rm -f "$T/envdump"; ENV_DUMP="$T/envdump"; wenv
env BASH_ENV=/nonexistent ENV=/nonexistent PS4=x CDPATH=/tmp GLOBIGNORE='*' NODE_OPTIONS=--inspect npm_config_foo=1 PERL5OPT=-x PERL5LIB=/x PERLLIB=/x TAR_OPTIONS=--x GZIP=-1 \
  TMPDIR=/nowhere FOO_OTHER=1 TALOS_JS_RUNTIME=pnpm HTTPS_PROXY=http://proxy.invalid:1 \
  bash -p "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1; rc=$?
unset ENV_DUMP
leaked="$(grep -E '^(BASH_ENV|ENV|PS4|CDPATH|GLOBIGNORE|NODE_OPTIONS|npm_config_[A-Za-z_]*|PERL5OPT|PERL5LIB|PERLLIB|TAR_OPTIONS|GZIP|TMPDIR|FOO_OTHER|IFS|SHELLOPTS|BASHOPTS)=' "$T/envdump" 2>/dev/null | tr '\n' ' ')"
if [ "$rc" = 0 ] && [ -s "$T/envdump" ] && [ -z "$leaked" ] && grep -q '^HOME=' "$T/envdump" && grep -q '^LC_ALL=C$' "$T/envdump" && grep -q '^LANG=C$' "$T/envdump" \
  && grep -q '^TALOS_JS_RUNTIME=pnpm$' "$T/envdump" && grep -q '^HTTPS_PROXY=' "$T/envdump" && grep -q '^PATH=/usr/bin:/bin:/usr/sbin:/sbin:' "$T/envdump"; then
  ok "prepare-archive: the tools run with HOME, the runtime and proxy settings, LC_ALL=C, LANG=C and the system PATH only (no TAR_OPTIONS, NODE_OPTIONS, npm_config_*, PERL*, BASH_ENV, PS4, TMPDIR, ...)"
else bad "environment: exit $rc, leaked: $leaked; $(grep -E '^(HOME|LC_ALL|LANG|PATH)=' "$T/envdump" 2>/dev/null | tr '\n' ' ')"; fi
# every child of the archive path starts with a clean environment: an exported function (even `[`) or SHELLOPTS in the caller's environment reaches
# neither pnpm (here a bash script) nor the new tree's install.sh (the swap runs it with bash)
hostile() { env 'BASH_FUNC_[%%=() { return 0; }' 'BASH_FUNC_tar%%=() { echo hijacked >&2; }' SHELLOPTS=xtrace "$@"; }
fn_clean() { [ -s "$1" ] && ! grep -q 'declare -f' "$1" && grep -q '^tar is /' "$1" && ! grep -q 'xtrace' "$1" && grep -q '^SHELLOPTS=' "$1"; }
afresh; rm -f "$T/fndump" "$T/fndump.install"; FN_DUMP="$T/fndump"; wenv
hostile bash -p "$APPLY_REAL" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 \
  --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1; rc1=$?
TREE="$(sed -n 's/.*"tree_sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$T/result.json" 2>/dev/null)"
hostile bash -p "$APPLY_REAL" --swap --archive --checkout "$ACO" --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" --result "$T/result.json" \
  --commit "$B" --version 9.9.9 --tree-sha256 "$TREE" >>"$T/out.log" 2>&1; rc2=$?
unset FN_DUMP
if [ "$rc1" = 0 ] && [ "$rc2" = 0 ] && fn_clean "$T/fndump" && fn_clean "$T/fndump.install"; then
  ok "no exported function (BASH_FUNC_[%%, BASH_FUNC_tar%%) and no SHELLOPTS from the caller reach the packages tool or the new tree's install.sh: both start with a clean environment"
else bad "children's environment: prepare $rc1, swap $rc2; pnpm side: $(tr '\n' '|' < "$T/fndump" 2>/dev/null | cut -c1-160); install side: $(tr '\n' '|' < "$T/fndump.install" 2>/dev/null | cut -c1-160)"; fi
# --env-cleaned is not trusted: a caller who passes it first (to skip the clean re-run) is refused when the environment holds anything outside the kept list
afresh; rm -f "$T/result.json"
env 'BASH_FUNC_[%%=() { return 0; }' TAR_OPTIONS=--x NODE_OPTIONS=--inspect PATH=/usr/bin:/bin:/usr/sbin:/sbin SHELLOPTS=xtrace \
  bash -p "$APPLY_REAL" --env-cleaned --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 \
  --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1; rc=$?
[ "$rc" = 64 ] && [ ! -e "$T/result.json" ] && old_intact && ok "--env-cleaned passed by the caller with BASH_FUNC_[%%, TAR_OPTIONS, NODE_OPTIONS in the environment: exit 64, nothing done" || bad "--env-cleaned with a hostile environment: exit $rc, result $(res)"
afresh; rm -f "$T/result.json"
env -i HOME="$HOME" PATH="$PATH" LC_ALL=C LANG=C bash -p "$APPLY_REAL" --env-cleaned --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" --tag mac-v9.9.9 \
  --version 9.9.9 --result "$T/result.json" --pnpm "$STUBA/pnpm" >"$T/out.log" 2>&1; rc=$?
[ "$rc" = 64 ] && [ ! -e "$T/result.json" ] && old_intact && ok "--env-cleaned passed by the caller with a PATH that is not the system folders: exit 64, nothing done" || bad "--env-cleaned with another PATH: exit $rc, result $(res)"
afresh; env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C LANG=C bash -p "$APPLY_REAL" --env-cleaned --prepare-archive --checkout "$ACO" --tarball "$GOOD" --sha256 "$GOODSHA" --commit "$B" \
  --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" >"$T/out.log" 2>&1; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"prepare-archive","why":"deps"}' ] && ok "--env-cleaned with exactly the kept environment is accepted (it is what the clean re-run itself passes)" || bad "--env-cleaned with a clean environment: exit $rc, result $(res)"
# arguments
afresh; abash "$APPLY_A" --prepare-archive --checkout "$ACO" --tarball "$GOOD" --commit "$B" --tag mac-v9.9.9 --version 9.9.9 --result "$T/result.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 64 ] && ok "prepare-archive without --sha256: exit 64" || bad "no sha: exit $rc"
afresh; ATAG=mac-v9.9.8 aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 64 ] && old_intact && ok "prepare-archive with a --tag that is not the --version: exit 64 (the bridge would not read that stamp)" || bad "tag mismatch: exit $rc"
afresh; abash "$APPLY_A" --prepare --archive --checkout "$ACO" --commit "$B" --result "$T/result.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 64 ] && ok "--archive with --prepare: exit 64" || bad "--prepare --archive: exit $rc"

# swap --archive
afresh; aprep "$GOOD" "$GOODSHA"; mkdir -p "$ACO.previous"; echo older > "$ACO.previous/OLDER"; : > "$STUBLOG"; aswap; rc=$?
if [ "$rc" = 0 ] && [ "$(res)" = '{"v":1,"ok":true,"step":"swap"}' ] && [ -f "$ACO/README.md" ] && [ -f "$ACO/.talos-source.json" ] && [ ! -e "$ACO.next" ] \
  && [ "$(cat "$ACO.previous/OLD")" = old ] && [ ! -e "$ACO.previous/OLDER" ] \
  && [ "$(cat "$STUBLOG")" = "install T --from-release $ZIP --sha256 $PIN --team ABCDE12345 --dest $DEST --no-relay-wait" ] && nogit; then
  ok "swap --archive: DIR.next is DIR, the old DIR is DIR.previous (an older one deleted), the NEW tree's install.sh runs, no git (no preflight)"
else bad "archive swap: exit $rc, result $(res), ls: $(ls "$T" | grep aco | tr '\n' ' '), log: $(cat "$STUBLOG"), out: $(tail -2 "$T/out.log")"; fi
# --commit, --version and --tree-sha256 are required
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"
for drop in commit version tree-sha256; do
  rest=()
  for x in commit version tree-sha256; do [ "$x" = "$drop" ] || case "$x" in commit) rest+=(--commit "$B") ;; version) rest+=(--version 9.9.9) ;; tree-sha256) rest+=(--tree-sha256 "$TREE") ;; esac; done
  abash "$APPLY_A" --swap --archive --checkout "$ACO" --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" --result "$T/result.json" "${rest[@]}" >/dev/null 2>&1; rc=$?
  [ "$rc" = 64 ] && [ -d "$ACO.next" ] && [ ! -s "$STUBLOG" ] && ok "swap --archive without --$drop: exit 64, nothing moved" || bad "swap without $drop: exit $rc"
done
# refused with nothing moved: no DIR.next, no stamp, a wrong stamp, a link in the way
swap_refused() {  # swap_refused <what> [why]
  local rc=$? why="${2:-checkout}"
  if [ "$rc" = 20 ] && [ "$(res)" = "{\"v\":1,\"ok\":false,\"step\":\"swap\",\"why\":\"$why\"}" ] && [ "$(cat "$ACO/OLD" 2>/dev/null)" = old ] && { [ ! -e "$ACO.previous" ] || [ -L "$ACO.previous" ]; } && [ ! -s "$STUBLOG" ] && nogit; then ok "swap --archive: $1 is refused ($why), nothing moved"
  else bad "swap --archive, $1: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi
}
afresh; aswap --tree-sha256 "$(printf 'd%.0s' $(seq 64))"; swap_refused "no DIR.next"
afresh; mkdir -p "$ACO.next"; aswap --tree-sha256 "$(printf 'd%.0s' $(seq 64))"; swap_refused "a DIR.next with no stamp"
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; aswap --version 9.9.8; swap_refused "a stamp that is not the --version"
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; aswap --commit "$A"; swap_refused "a stamp that is not the --commit"
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; echo '{"v":1}' > "$ACO.next/.talos-source.json"; aswap; swap_refused "a stamp the bridge would not read"
# the stamp is the script's own file, so a well-formed one proves nothing: the tree must be the one prepare digested
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; echo 'echo evil' >> "$ACO.next/apps/desktop/scripts/install.sh"; aswap; swap_refused "a DIR.next whose install.sh was changed after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; echo x > "$ACO.next/added.txt"; aswap; swap_refused "a DIR.next with a file added after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; rm "$ACO.next/README.md"; aswap; swap_refused "a DIR.next with a file removed after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; chmod 777 "$ACO.next/README.md"; aswap; swap_refused "a DIR.next with a file's mode changed after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; mkdir "$ACO.next/node_modules"; echo y > "$ACO.next/node_modules/x"; aswap; swap_refused "a file added under node_modules after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; mkdir -p "$ACO.next/apps/desktop/scripts/node_modules/pkg"; echo 'evil()' > "$ACO.next/apps/desktop/scripts/node_modules/pkg/index.js"; aswap; swap_refused "a file planted under a nested node_modules after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; ln -s /etc/passwd "$ACO.next/bunfig.toml"; aswap; swap_refused "a symlink planted in DIR.next after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; ln -s "$T/victim" "$ACO.next/node_modules"; aswap; swap_refused "a symlink named node_modules planted after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; mkfifo "$ACO.next/pipe"; aswap; swap_refused "a fifo planted in DIR.next after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; ln -s README.md "$ACO.next/README.link"; aswap; swap_refused "a symlink to a file inside, planted after prepare" archive
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; touch "$ACO.next/$(printf 'a
b')"; aswap; swap_refused "a file whose name has a line break, planted after prepare" archive
# a link planted in DIR.next is not followed while the tree is read
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; mkdir -p "$T/victim"; echo v > "$T/victim/V"; ln -s "$T/victim" "$ACO.next/vic"; aswap; swap_refused "a link to a folder (never walked into)" archive
# a symlink whose TARGET has a line break (macOS prints a target raw) can not forge digest lines
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; ln -s "$(printf 'x
f ./README.md 0')" "$ACO.next/nl-link"; aswap; swap_refused "a symlink with a line break in its target, planted after prepare" archive
# the digest does not depend on the environment's quoting: prepared under QUOTING_STYLE=literal, swapped without it
afresh; PNPM_MAKE_LINK=1 QUOTING_STYLE=literal aprep "$GOOD" "$GOODSHA"; rc1=$?; : > "$STUBLOG"; QUOTING_STYLE=shell-escape-always aswap; rc2=$?
[ "$rc1" = 0 ] && [ "$rc2" = 0 ] && ok "tree digest: the same under another QUOTING_STYLE (a tree with a link in node_modules still swaps in)" || bad "QUOTING_STYLE: prepare $rc1, swap $rc2, result $(res)"
# leftover private folders of a prepare that was killed are removed (real folders only, never through a link)
afresh; mkdir -p "$T/.apply-tar.stale" "$T/victim"; echo x > "$T/.apply-tar.stale/t.tgz"; echo keep > "$T/victim/KEEP"; ln -s "$T/victim" "$T/.apply-tar.link"
aprep "$GOOD" "$GOODSHA"; rc=$?
[ "$rc" = 0 ] && [ ! -e "$T/.apply-tar.stale" ] && [ -L "$T/.apply-tar.link" ] && [ "$(cat "$T/victim/KEEP")" = keep ] && ok "prepare-archive: a leftover .apply-tar.* folder is removed first, a link of that name is left alone" || bad "stale private folder: exit $rc, ls: $(ls -A "$T" | grep apply | tr '
' ' ')"
rm -f "$T/.apply-tar.link"
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; ln -s "$T/victim" "$ACO.previous"; mkdir -p "$T/victim"; aswap; swap_refused "a DIR.previous that is a symlink"
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; rm -rf "$ACO"; mkdir -p "$T/victim"; echo old > "$T/victim/OLD"; ln -s "$T/victim" "$ACO"; aswap; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"checkout"}' ] && [ -L "$ACO" ] && [ -d "$ACO.next" ] && [ ! -s "$STUBLOG" ] && ok "swap --archive: a DIR that is a symlink is refused, nothing moved" || bad "symlink DIR: exit $rc, result $(res)"
rm -f "$ACO"
# install.sh refusing the release: the old DIR comes back, the failed tree is gone, the kept Talos is opened
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; INSTALL_RC=9 aswap; rc=$?
if [ "$rc" = 21 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"app_check","restored":true}' ] && old_intact \
  && [ -z "$(ls -d "$ACO".* 2>/dev/null)" ] && grep -q "^open $DEST/Talos.app$" "$STUBLOG" && nogit; then
  ok "swap --archive, install.sh exit 9: DIR is the old one again (the new tree removed), and the kept Talos is opened"
else bad "archive install fail: exit $rc, result $(res), ls: $(ls -d "$ACO"* | tr '\n' ' '), log: $(cat "$STUBLOG")"; fi
# a rename that fails: undone by stage (the second: DIR is already DIR.previous; the first: nothing moved yet)
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; rm -f "$MVCOUNT"; MV_FAIL_AT=2 aswap; rc=$?
[ "$rc" = 21 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"checkout","restored":true}' ] && [ "$(cat "$ACO/OLD")" = old ] && [ ! -e "$ACO.previous" ] && [ -d "$ACO.next" ] && [ ! -s "$STUBLOG" ] \
  && ok "swap --archive: the second rename failing (DIR is already DIR.previous) puts DIR.previous back, install.sh never runs" || bad "half-done swap: exit $rc, result $(res), ls: $(ls -d "$ACO"* | tr '\n' ' ')"
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; rm -f "$MVCOUNT"; MV_FAIL_AT=1 aswap; rc=$?
[ "$rc" = 21 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"checkout","restored":true}' ] && [ "$(cat "$ACO/OLD")" = old ] && [ ! -e "$ACO.previous" ] && [ -d "$ACO.next" ] && [ ! -s "$STUBLOG" ] \
  && ok "swap --archive: the first rename failing leaves DIR where it was" || bad "first rename failing: exit $rc, result $(res), ls: $(ls -d "$ACO"* | tr '\n' ' ')"
# a put-back rename that lands INSIDE a recreated DIR is not success: restored false
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; rm -f "$MVCOUNT"; MV_FAIL_AT=2 MV_NEST_AT=3 aswap; rc=$?
[ "$rc" = 21 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"checkout","restored":false}' ] && ok "swap --archive: DIR.previous nested inside a recreated DIR by the put-back is restored:false, not success" || bad "nested put-back: exit $rc, result $(res), ls: $(ls -R "$ACO" | head -5 | tr '
' ' ')"
# the health gate, shared with the git swap
export HEALTH_OUT="$T/healthy-9.9.9.json"
ahswap() { aswap --health-file "$HEALTH_OUT" --health-wait 3 "$@"; }
afresh; aprep "$GOOD" "$GOODSHA"; echo stale > "$HEALTH_OUT"; : > "$STUBLOG"; HEALTH_AFTER=1 ahswap; rc=$?
[ "$rc" = 0 ] && [ "$(res)" = '{"v":1,"ok":true,"step":"swap"}' ] && [ -f "$ACO/README.md" ] && ! grep -q -- '--rollback' "$STUBLOG" && ok "swap --archive: the new app reports healthy in time: kept, nothing rolled back" || bad "archive healthy: exit $rc, result $(res), log: $(cat "$STUBLOG")"
afresh; aprep "$GOOD" "$GOODSHA"; echo stale > "$HEALTH_OUT"; : > "$STUBLOG"; ahswap; rc=$?
if [ "$rc" = 22 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"unhealthy","restored":true}' ] && old_intact && [ ! -e "$HEALTH_OUT" ] \
  && grep -q "^install T --rollback --dest $DEST --no-open$" "$STUBLOG" && grep -q "^open $DEST/Talos.app$" "$STUBLOG" && nogit; then
  ok "swap --archive, no health report: the previous app back through the new tree's install.sh --rollback, DIR is the old one again, reopened"
else bad "archive unhealthy: exit $rc, result $(res), ls: $(ls -d "$ACO"* | tr '\n' ' '), log: $(cat "$STUBLOG")"; fi
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"; ROLLBACK_RC=3 ahswap; rc=$?
[ "$rc" = 22 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"rollback_failed","restored":false}' ] && [ -f "$ACO/README.md" ] && [ "$(cat "$ACO.previous/OLD")" = old ] \
  && ok "swap --archive, a rollback that fails: said as rollback_failed, the new DIR stays with the installed app and DIR.previous is kept" || bad "archive rollback failed: exit $rc, result $(res)"
# stopped (TERM) while install.sh runs: the new app is not in place (nothing says so), so only DIR goes back
afresh; aprep "$GOOD" "$GOODSHA"; : > "$STUBLOG"
INSTALL_SLEEP=2 wenv; INSTALL_SLEEP=2 bash -p "$APPLY_A" --swap --archive --checkout "$ACO" --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" --result "$T/result.json" \
  --commit "$B" --version 9.9.9 --tree-sha256 "$TREE" >"$T/out.log" 2>&1 &
SW=$!
for _ in $(seq 1 50); do grep -q "^install T --from-release" "$STUBLOG" 2>/dev/null && break; sleep 0.1; done
kill -TERM "$SW" 2>/dev/null; wait "$SW"; rc=$?
[ "$rc" = 21 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"stopped","restored":true}' ] && old_intact && ok "swap --archive stopped by a signal inside install.sh: DIR is the old one again" || bad "archive TERM: exit $rc, result $(res), ls: $(ls -d "$ACO"* | tr '\n' ' ')"

# restore --archive: DIR.previous must be a release tree (a valid stamp) or a git clone (.git), else it is not put back
afresh; printf '%s\n' '{"v":1,"tag":"mac-v9.9.8","version":"9.9.8","gitSha":"'"$A"'"}' > "$ACO/.talos-source.json"; aprep "$GOOD" "$GOODSHA"; aswap; : > "$STUBLOG"; arestore; rc=$?
if [ "$rc" = 0 ] && [ "$(res)" = '{"v":1,"ok":true,"step":"restore"}' ] && [ "$(cat "$ACO/OLD")" = old ] && [ ! -e "$ACO.next" ] && [ ! -e "$ACO.previous" ] && [ ! -e "$ACO/README.md" ] && [ -z "$(ls -d "$ACO".* 2>/dev/null)" ] && nogit; then
  ok "restore --archive: DIR.previous is DIR again, the current DIR is gone, no git"
else bad "archive restore: exit $rc, result $(res), ls: $(ls -d "$ACO"* | tr '\n' ' ')"; fi
afresh; printf '%s
' '{"v":1,"tag":"mac-v9.9.8","version":"9.9.8","gitSha":"'"$A"'"}' > "$ACO/.talos-source.json"; aprep "$GOOD" "$GOODSHA"; aswap; : > "$STUBLOG"; rm -f "$MVCOUNT"; MV_NEST_AT=2 arestore; rc=$?
[ "$rc" = 21 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"restore","why":"checkout","restored":false}' ] && ok "restore --archive: DIR.previous landing inside a recreated DIR is restored:false, not success" || bad "restore nested: exit $rc, result $(res)"
afresh; aprep "$GOOD" "$GOODSHA"; aswap; : > "$STUBLOG"; arestore; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"restore","why":"checkout"}' ] && [ -f "$ACO/README.md" ] && [ -d "$ACO.previous" ] && ok "restore --archive: a DIR.previous with no stamp and no .git is not put back (checkout)" || bad "restore unstamped previous: exit $rc, result $(res)"
afresh; arestore; rc=$?
[ "$rc" = 20 ] && [ "$(res)" = '{"v":1,"ok":false,"step":"restore","why":"checkout"}' ] && [ "$(cat "$ACO/OLD")" = old ] && ok "restore --archive with no DIR.previous: refused (checkout), DIR untouched" || bad "restore without previous: exit $rc, result $(res)"
afresh; mkdir -p "$T/victim"; echo keep > "$T/victim/KEEP"; ln -s "$T/victim" "$ACO.previous"; arestore; rc=$?
[ "$rc" = 20 ] && [ "$(cat "$ACO/OLD")" = old ] && [ "$(cat "$T/victim/KEEP")" = keep ] && ok "restore --archive with a DIR.previous that is a symlink: refused" || bad "restore symlink: exit $rc, result $(res)"

# a git install converts on its first archive update: the clone simply becomes DIR.previous
fresh; ACO="$T/co"; rm -rf "$ACO.next" "$ACO.previous"; GITHEAD="$(git -C "$ACO" rev-parse HEAD)"; : > "$GITLOG"
aprep "$GOOD" "$GOODSHA"; rc1=$?; : > "$STUBLOG"; aswap; rc2=$?
if [ "$rc1" = 0 ] && [ "$rc2" = 0 ] && [ -f "$ACO/.talos-source.json" ] && [ ! -e "$ACO/.git" ] && [ -d "$ACO.previous/.git" ] \
  && [ "$(git -C "$ACO.previous" rev-parse HEAD)" = "$GITHEAD" ] && nogit; then
  ok "a git checkout converts on its first archive update: it becomes DIR.previous (.git and all), DIR is the release tree, and no git ran"
else bad "git to archive: prepare $rc1, swap $rc2, result $(res), ls: $(ls -A "$ACO" | tr '\n' ' ')"; fi
arestore; rc=$?
[ "$rc" = 0 ] && [ -d "$ACO/.git" ] && [ "$(git -C "$ACO" rev-parse HEAD)" = "$GITHEAD" ] && ok "restore --archive after the conversion: the git clone is DIR again, on the commit it was on" || bad "restore after conversion: exit $rc"
ACO="$T/aco"
nogit && ok "no git process ran on any archive path above (the PATH stub git logged no call)" || bad "git was called: $(cat "$GITLOG")"

# stopped in the middle of install.sh, after its rename: the bundle says the new version is in place, so it is rolled back
mkdir -p "$DEST/Talos.app/Contents"; rm -f "$DEST/Talos.app/Contents/Info.plist"
fresh; prepare; : > "$STUBLOG"
STUB_PLIST="$DEST/Talos.app/Contents/Info.plist" INSTALL_SLEEP=3 bash "$APPLY" --swap --checkout "$T/co" --commit "$B" --to main --zip "$ZIP" \
  --sha256 "$PIN" --team ABCDE12345 --dest "$DEST" --result "$T/result.json" --health-file "$HEALTH_OUT" --health-wait 20 --version 9.9.9 \
  >"$T/out.log" 2>&1 &
SW=$!
for _ in $(seq 1 50); do grep -q "^install B --from-release" "$STUBLOG" 2>/dev/null && break; sleep 0.1; done
sleep 0.5; kill -TERM "$SW" 2>/dev/null; wait "$SW"; rc=$?
if grep -q -- "^install B --rollback" "$STUBLOG" && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"unhealthy","restored":true}' ] && head_is "$A"; then
  ok "stopped inside install.sh after the new app went in: rolled back, never a new app on old code"
else bad "TERM mid-install: exit $rc, result $(res), log: $(cat "$STUBLOG")"; fi
rm -rf "$DEST/Talos.app"; mkdir -p "$DEST/Talos.app"

echo "the health gate's rollback through the REAL install.sh --rollback, with a hung new app"
RB="$T/rbdest"; mkdir -p "$RB"
bundle() {  # bundle <path> <version> <executable source>: a Talos-shaped bundle, signed ad hoc
  mkdir -p "$1/Contents/MacOS"; cp "$3" "$1/Contents/MacOS/Talos"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string app.talos.desktop" -c "Add :CFBundleExecutable string Talos" \
    -c "Add :CFBundlePackageType string APPL" -c "Add :CFBundleShortVersionString string $2" "$1/Contents/Info.plist" >/dev/null
  codesign -s - --force --deep "$1" 2>/dev/null
}
bundle "$RB/.Talos.app.previous" 1.0.0 /usr/bin/true
bundle "$RB/Talos.app" 2.0.0 /bin/bash
# the new app, hung: it ignores TERM
"$RB/Talos.app/Contents/MacOS/Talos" -c "trap '' TERM; while :; do sleep 1; done" </dev/null >/dev/null 2>&1 &
HUNG=$!
sleep 0.5
REL="$R" fresh; REL="$R" prepare; : > "$STUBLOG"
REL="$R" bash "$APPLY" --swap --checkout "$T/co" --commit "$R" --to main --zip "$ZIP" --sha256 "$PIN" --team ABCDE12345 --dest "$RB" \
  --result "$T/result.json" --health-file "$HEALTH_OUT" --health-wait 1 --version 2.0.0 >"$T/out.log" 2>&1; rc=$?
ver() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null; }
if ! kill -0 "$HUNG" 2>/dev/null && [ "$(ver "$RB/Talos.app")" = 1.0.0 ] && [ "$(ver "$RB/.Talos.app.previous")" = 2.0.0 ] \
  && [ "$(res)" = '{"v":1,"ok":false,"step":"swap","why":"unhealthy","restored":true}' ] && head_is "$A" && grep -q "^open $RB/Talos.app$" "$STUBLOG"; then
  ok "a hung new app is stopped by its own path (TERM, then KILL), the real install.sh --rollback puts 1.0.0 back, and it is opened"
else bad "real rollback: exit $rc, hung alive: $(kill -0 "$HUNG" 2>/dev/null && echo yes || echo no), app $(ver "$RB/Talos.app"), kept $(ver "$RB/.Talos.app.previous"), result $(res), out: $(tail -5 "$T/out.log")"; fi
kill -KILL "$HUNG" 2>/dev/null; wait "$HUNG" 2>/dev/null

echo "install.sh --check-only (the real script)"
mkapp() {  # mkapp <dir>: a Talos-shaped bundle around an unsigned copy of /usr/bin/true
  mkdir -p "$1/Talos.app/Contents/MacOS"
  cp /usr/bin/true "$1/Talos.app/Contents/MacOS/Talos"; codesign --remove-signature "$1/Talos.app/Contents/MacOS/Talos" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string app.talos.desktop" -c "Add :CFBundleExecutable string Talos" \
    -c "Add :CFBundlePackageType string APPL" "$1/Talos.app/Contents/Info.plist" >/dev/null
}
check() { HOME="$HOME" PATH="$STUB:$PATH" bash "$INSTALL" --from-release "$1" --sha256 "$2" --team ABCDE12345 --check-only 2>&1; }
mkapp "$T/u"; (cd "$T/u" && ditto -c -k --keepParent Talos.app "$T/unsigned.zip")
mkapp "$T/h"; codesign -s - --force "$T/h/Talos.app" 2>/dev/null; (cd "$T/h" && ditto -c -k --keepParent Talos.app "$T/adhoc.zip")
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
: > "$STUBLOG"
OUT="$(check "$T/unsigned.zip" "$(sha "$T/unsigned.zip")")"; rc=$?
[ "$rc" = 9 ] && case "$OUT" in *"signature does not check out"*) true ;; *) false ;; esac \
  && ok "an unsigned app: refused (exit 9)" || bad "unsigned: exit $rc: $OUT"
OUT="$(check "$T/adhoc.zip" "$(sha "$T/adhoc.zip")")"; rc=$?
[ "$rc" = 9 ] && case "$OUT" in *Gatekeeper*) true ;; *) false ;; esac && ok "an app signed ad hoc: refused by Gatekeeper (exit 9)" || bad "ad hoc: exit $rc: $OUT"
OUT="$(check "$T/adhoc.zip" "$PIN")"; rc=$?
[ "$rc" = 9 ] && case "$OUT" in *sha256*) true ;; *) false ;; esac && ok "a sha256 that is not the zip's: refused (exit 9)" || bad "sha mismatch: exit $rc: $OUT"
if [ ! -s "$STUBLOG" ] && [ ! -e "$HOME/Applications" ] && [ ! -e "$HOME/Library/Application Support/Talos/checkout" ] && [ ! -e "$HOME/Library/Application Support/app.talos.desktop/checkout" ]; then
  ok "--check-only never quits, opens, installs or records anything"
else bad "--check-only touched something: $(cat "$STUBLOG"); $(ls -A "$HOME")"; fi
OUT="$(HOME="$HOME" bash "$INSTALL" --check-only 2>&1)"; rc=$?
[ "$rc" = 64 ] && ok "--check-only without --from-release: exit 64" || bad "--check-only alone: exit $rc"

exit $fail
