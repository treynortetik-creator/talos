#!/usr/bin/env bash
# Tests the updater's last step (auto-update-apply.sh) and install.sh --check-only, with temp folders only: a local bare "public repo"
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
T="$(mktemp -d)"
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
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
stub_install A; echo '{}' > "$SRC/package.json"
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
head_is() { [ "$(git -C "$T/co" rev-parse HEAD)" = "$1" ]; }
on_main() { [ "$(git -C "$T/co" symbolic-ref --quiet --short HEAD 2>/dev/null)" = main ]; }
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
