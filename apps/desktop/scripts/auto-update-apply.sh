#!/usr/bin/env bash
# The last steps of the Mac app's own update, run by the app's `AutoUpdater` from a copy of this file (the checkout it moves may hold
# the original). Three modes, so the app can look at the sessions again between moving the checkout and quitting itself:
#   auto-update-apply.sh --prepare --checkout DIR --commit SHA --result FILE
#       refuses a checkout with changes of its own (tracked or not), then moves it to SHA (the release's PUBLIC commit, which the
#       app fetched while waiting) and installs its packages. Any failure puts the checkout back. The app waits for this one.
#   auto-update-apply.sh --swap --checkout DIR --commit SHA --to REF --zip PATH --sha256 HEX --team TEAM --dest DIR --result FILE
#                        [--health-file FILE --health-wait SECONDS --version X.Y.Z]
#       runs the release commit's own install.sh --from-release --no-relay-wait (it checks the zip again, quits Talos, swaps with
#       the old copy kept and opens the new one). Refused unless the checkout is still on SHA and clean. If install.sh fails, the
#       checkout goes back to REF and the kept Talos is opened again. The app starts this one in a session of its own: it quits the app.
#   auto-update-apply.sh --restore --checkout DIR --to REF --result FILE
#       puts the checkout back on REF (a branch or a commit) and installs its packages: after a prepare when the sessions were no
#       longer quiet, or when an earlier run was stopped before it said how it ended.
# The health gate (--swap with --health-file): after install.sh put the new app in place and opened it, the swap waits up to
# --health-wait seconds (default 300) for the NEW app's own report that it came up healthy, the file it writes once it is (named
# for its version, removed here before the swap so no older one counts). The old app never writes it. No report in time, or the
# swap stopped while it waits: install.sh --rollback puts the kept previous app back, the checkout goes back to REF, the result says
# "unhealthy", and the previous app is opened. This runs in the swap's own session, so it happens whether or not the new app ever
# started. If the rollback itself fails, the checkout stays with the app that is installed, the kept copy (.Talos.app.previous)
# is left where it is, and the result says "rollback_failed".
# The relay is not waited for: a newer bridge talks to an older relay through the features each side lists (features-cap.ts), and
# the relay updates on its own.
# The outcome goes to --result (JSON, 0600) before Talos is opened again: {"v":1,"ok":true,"step":"prepared|swapped|restored"} or
# {"v":1,"ok":false,"step":"...","why":"<AutoUpdate.Failure>","restored":true|false} ("restored" only when the checkout had moved).
# Exit codes: 0 done; 20 refused or failed with nothing moved; 21 failed after the checkout moved (put back, or "restored": false);
# 22 the new app did not report healthy and was rolled back (or the rollback failed: see the result);
# 64 bad arguments. git and pnpm (or bun, when there is no pnpm) come from PATH (the app passes its login shell's); git runs with no prompt and stdin from /dev/null.
set -uo pipefail
MODE="" CHECKOUT="" COMMIT="" ZIP="" PIN="" TEAM="" DEST="" RESULT="" TO="" HEALTH="" HEALTH_WAIT=300 NEWV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout|--commit|--zip|--sha256|--team|--dest|--result|--to|--health-file|--health-wait|--version)
      [ $# -ge 2 ] || { echo "auto-update-apply: $1 needs a value" >&2; exit 64; }
      case "$1" in
        --checkout) CHECKOUT="$2" ;; --commit) COMMIT="$2" ;; --zip) ZIP="$2" ;; --sha256) PIN="$2" ;;
        --team) TEAM="$2" ;; --dest) DEST="$2" ;; --result) RESULT="$2" ;; --to) TO="$2" ;;
        --health-file) HEALTH="$2" ;; --health-wait) HEALTH_WAIT="$2" ;; --version) NEWV="$2" ;;
      esac
      shift 2 ;;
    --prepare|--swap|--restore) [ -z "$MODE" ] || { echo "auto-update-apply: one mode only" >&2; exit 64; }; MODE="${1#--}"; shift ;;
    *) echo "auto-update-apply: unknown argument $1" >&2; exit 64 ;;
  esac
done
[ -n "$MODE" ] && [ -n "$CHECKOUT" ] && [ -n "$RESULT" ] || { echo "auto-update-apply: a mode, --checkout and --result are required" >&2; exit 64; }
case "$MODE" in
  restore) [ -n "$TO" ] || { echo "auto-update-apply: --restore needs --to" >&2; exit 64; } ;;
  prepare) [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "auto-update-apply: --commit needs a full commit id" >&2; exit 64; } ;;
  swap)
    [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] && [ -n "$TO" ] && [[ "$PIN" =~ ^[0-9a-f]{64}$ ]] && [[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] && [ -f "$ZIP" ] && [ -n "$DEST" ] \
      || { echo "auto-update-apply: --swap needs --commit, --to, --zip, --sha256, --team and --dest" >&2; exit 64; }
    [[ "$HEALTH_WAIT" =~ ^[0-9]{1,5}$ ]] || { echo "auto-update-apply: --health-wait is whole seconds" >&2; exit 64; } ;;
esac
export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
g() { git -C "$CHECKOUT" "$@" </dev/null; }
say() { echo "auto-update-apply: $*"; }

# The outcome, written whole (temp file, then rename) so a reader never sees half of it.
result() {  # result <ok true|false> [why] [restored true|false]
  local body tmp
  if [ "$1" = true ]; then body="{\"v\":1,\"ok\":true,\"step\":\"$MODE\"}"
  elif [ -n "${3:-}" ]; then body="{\"v\":1,\"ok\":false,\"step\":\"$MODE\",\"why\":\"$2\",\"restored\":$3}"
  else body="{\"v\":1,\"ok\":false,\"step\":\"$MODE\",\"why\":\"$2\"}"; fi
  tmp="$RESULT.$$.tmp"
  ( umask 077; printf '%s\n' "$body" > "$tmp" ) && mv -f "$tmp" "$RESULT"
}

# The packages: pnpm when the Mac has it, else bun (the app's own, last on the PATH it passes): the same choice the app made when it first
# installed this clone (scripts/install-js.sh), with the same flags. TALOS_JS_RUNTIME=bun forces bun.
deps() {
  ( cd "$CHECKOUT" || exit 1
    if [ "${TALOS_JS_RUNTIME:-}" = bun ] || ! command -v pnpm >/dev/null 2>&1; then TALOS_NO_HOOKS=1 bun install --frozen-lockfile --ignore-scripts </dev/null
    else pnpm install --frozen-lockfile </dev/null; fi )
}
clean() { [ -z "$(g status --porcelain 2>/dev/null)" ] && g status --porcelain >/dev/null 2>&1; }

# Back to REF: a branch name is checked out as that branch, anything else as a detached commit.
move_back() {
  local ref="$1"
  if g show-ref --verify --quiet "refs/heads/$ref"; then g checkout --quiet "$ref" || return 1
  else g checkout --quiet --detach "$ref" || return 1; fi
  deps >/dev/null 2>&1 || say "warning: the packages of $ref could not be installed again"
  return 0
}

[ -n "$(g rev-parse --show-toplevel 2>/dev/null)" ] || { result false checkout; say "$CHECKOUT is not a git checkout" >&2; exit 20; }

if [ "$MODE" = restore ]; then
  if move_back "$TO"; then result true; say "the checkout is back on $TO"; exit 0; fi
  result false checkout false; say "could not put the checkout back on $TO" >&2; exit 21
fi

if [ "$MODE" = prepare ]; then
  # A checkout with nothing of its own changed: an edited install.sh would decide the swap.
  clean || { result false dirty; say "the checkout has changes of its own; nothing was changed" >&2; exit 20; }
  OLD_REF="$(g symbolic-ref --quiet --short HEAD 2>/dev/null || g rev-parse HEAD)"
  # The release's commit, from the public repo (fetched while the app waited; once more here if it is not there).
  if ! g cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
    g fetch --quiet origin "$COMMIT" >/dev/null 2>&1 || g fetch --quiet --tags origin >/dev/null 2>&1 || true
    g cat-file -e "$COMMIT^{commit}" 2>/dev/null || { result false checkout; say "commit $COMMIT is not in the public repo" >&2; exit 20; }
  fi
  # From here the checkout moves: any way out but success puts it back (a SIGKILL cannot be caught; the app restores then).
  DONE=0
  undo() {
    DONE=1
    if move_back "$OLD_REF"; then result false "$1" true; else result false "$1" false; fi
    exit 21
  }
  trap '[ "$DONE" = 1 ] || undo stopped' EXIT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  trap 'exit 130' INT
  g checkout --quiet --detach "$COMMIT" || undo checkout
  [ "$(g rev-parse HEAD)" = "$COMMIT" ] || undo checkout
  say "the checkout is on $COMMIT (it was on $OLD_REF)"
  deps || undo deps
  DONE=1
  result true
  exit 0
fi

# swap: still the prepared commit, still clean, or nothing is swapped (the checkout goes back to REF).
DONE=0
fail_back() {
  DONE=1
  if move_back "$TO"; then result false "$1" true; else result false "$1" false; fi
}
trap '[ "$DONE" = 1 ] || { fail_back stopped; exit 21; }' EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
if [ "$(g rev-parse HEAD 2>/dev/null)" != "$COMMIT" ] || ! clean; then
  fail_back checkout; say "the checkout is no longer the prepared commit, or has changes of its own" >&2; exit 21
fi
# The release's own install.sh: it checks the zip again (sha256, codesign, Gatekeeper, the team), quits Talos, swaps with the old
# copy kept, and opens the new one. A failure there leaves the old app in place (install.sh's own rule).
[ -z "$HEALTH" ] || rm -f "$HEALTH"
INSTALLED=0
plist_version() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null || true; }
BEFORE_VERSION="$(plist_version "$DEST/Talos.app")"
# Whether the new app is in place: known from the bundle itself, so a swap stopped in the middle of install.sh (after its rename,
# before it returned) is still rolled back, never left as a new app on old code.
installed_new() {
  [ "$INSTALLED" = 1 ] && return 0
  local now; now="$(plist_version "$DEST/Talos.app")"
  [ -n "$NEWV" ] && [ "$now" = "$NEWV" ] && [ "$now" != "$BEFORE_VERSION" ]
}
# Every process running from the installed app's own executable, by its full path: nothing else is ever signalled.
app_pids() {
  local exe="$DEST/Talos.app/Contents/MacOS/Talos"
  ps -axo pid=,comm= 2>/dev/null | awk -v e="$exe" '{ p = $1; sub(/^[ \t]*[0-9]+[ \t]+/, ""); if ($0 == e) print p }'
}
# A new app that hangs would not quit when install.sh --rollback asks it to: it is stopped first (TERM, 10 s, then KILL).
stop_new_app() {
  local pids i
  pids="$(app_pids)"
  [ -n "$pids" ] || return 0
  say "stopping the new app (pid $(echo $pids))"
  kill -TERM $pids 2>/dev/null || true
  for i in $(seq 1 20); do [ -z "$(app_pids)" ] && return 0; sleep 0.5; done
  pids="$(app_pids)"
  [ -z "$pids" ] || kill -KILL $pids 2>/dev/null || true
  for i in $(seq 1 10); do [ -z "$(app_pids)" ] && return 0; sleep 0.5; done
  return 0
}
# After the swap: the new app stopped, the kept previous app back (install.sh --rollback), the checkout back, the result, then the
# previous app opened (it posts the line). A rollback that fails leaves the checkout with the installed app and the kept copy.
roll_back() {
  local rb
  DONE=1
  say "the new app did not report healthy ($1); putting the previous one back" >&2
  stop_new_app
  bash "$CHECKOUT/apps/desktop/scripts/install.sh" --rollback --dest "$DEST" --no-open </dev/null
  rb=$?
  if [ "$rb" != 0 ]; then
    result false rollback_failed false
    say "install.sh --rollback failed (exit $rb); the previous app is still kept beside it" >&2
  elif move_back "$TO"; then result false unhealthy true
  else result false unhealthy false; fi
  open "$DEST/Talos.app" || true
}
# Stopped at any point: a report already written means the new app came up (never rolled back then); a new app in place without
# one is rolled back; otherwise nothing was swapped and only the checkout goes back.
on_stop() {
  [ "$DONE" = 1 ] && return 0
  if installed_new && [ -n "$HEALTH" ] && [ -s "$HEALTH" ]; then DONE=1; result true; return 0; fi
  if installed_new; then roll_back stopped; else fail_back stopped; fi
  exit 21
}
trap on_stop EXIT
bash "$CHECKOUT/apps/desktop/scripts/install.sh" --from-release "$ZIP" --sha256 "$PIN" --team "$TEAM" --dest "$DEST" --no-relay-wait </dev/null
rc=$?
if [ "$rc" = 0 ]; then
  INSTALLED=1
  if [ -n "$HEALTH" ]; then
    waited=0
    until [ -s "$HEALTH" ]; do
      if [ "$waited" -ge "$HEALTH_WAIT" ]; then roll_back "no report in ${HEALTH_WAIT}s"; exit 22; fi
      sleep 1
      waited=$((waited + 1))
    done
  fi
  DONE=1
  result true
  say "updated"
  exit 0
fi
case "$rc" in 2) why=location ;; 3|6) why=not_quit ;; 8) why=relay ;; 9) why=app_check ;; 10) why=identity ;; *) why=install ;; esac
say "install.sh stopped (exit $rc); putting the checkout back" >&2
fail_back "$why"
# install.sh may have quit Talos before it failed: the old copy is in place, so open it again (the result is already written).
running="$(osascript -e 'application id "app.talos.desktop" is running' 2>/dev/null || echo false)"
if [ -d "$DEST/Talos.app" ] && [ "$running" != true ]; then open "$DEST/Talos.app" || true; fi
exit 21
