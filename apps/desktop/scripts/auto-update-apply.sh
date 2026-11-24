#!/usr/bin/env bash
# The last steps of the Mac app's own update, run by the app's `AutoUpdater` from a copy of this file (the checkout it moves may hold
# the original). Three moving modes (and a fourth that moves nothing, --preflight), so the app can look at the sessions again between moving the checkout and quitting itself:
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
#   auto-update-apply.sh --preflight --checkout DIR --result FILE
#       runs ONLY the checks below (the plain-clone preflight and the strong clean check): moves nothing, fetches nothing, installs nothing.
#       {"v":1,"ok":true,"step":"preflight"}, or ok:false with why "checkout-config" (not a plain clone), "checkout" (no git checkout) or
#       "dirty". Exit 0 ok, 20 refused, 64 bad arguments. The app calls this before any git call of its own in the checkout.
# RUNNING THE ARCHIVE MODES: the app must start them as `/bin/bash -p /path/to/auto-update-apply.sh --prepare-archive ...` (or --swap/--restore
# --archive). Without -p (bash's privileged mode, which ignores exported functions, BASH_ENV, ENV, SHELLOPTS, PS4 and the like) they exit 64
# before doing anything. They then run themselves again through /usr/bin/env -i with only HOME, USER, LOGNAME, TALOS_JS_RUNTIME, the
# TALOS_APPLY_MAX_* caps and the proxy variables (when set), PATH=<the TOOL_DIRS folders>, LC_ALL=C and LANG=C, and use only those folders for tools. pnpm also
# ignores ~/.npmrc, the global npmrc and its own rc. NOTE (a later Swift item): an app home that is only in the environment (TALOS_APP_HOME)
# no longer reaches install.sh, which then uses the one in desktop.json or the default: the app should pass the resolved app home as an argument.
# The ARCHIVE checkout (no git anywhere on this path: no git call is made, and the git preflight above does not run). A release's
# source tarball (talos-source-mac-v<ver>.tar.gz, byte-stable, its sha256 in the signed manifest) is unpacked beside the checkout and
# swapped in; the checkout it replaces is kept as DIR.previous. DIR.next and DIR.previous are beside DIR (the same folder, so the
# renames are atomic) and are never followed when they are links (a link there is refused, why "checkout"):
#   auto-update-apply.sh --prepare-archive --checkout DIR --tarball FILE --sha256 HEX --commit SHA --tag TAG --version VER --result FILE
#       FILE is copied into a private 0700 folder beside DIR (.apply-tar.XXXXXX, removed on every way out) and ONLY that copy is hashed,
#       listed and unpacked; its sha256 must be HEX (why "sha256", checked again just before unpacking; a missing or unreadable FILE is
#       why "tarball"). It is refused before anything is unpacked (why "archive") when it unpacks to more than 2 GB or has more than
#       200000 entries, or holds an absolute path, a . or .. component, anything outside its single top folder, a device, fifo or socket,
#       or ANY link (the repo has none; soft and hard links are refused outright, in the listing and again on the unpacked files).
#       It is unpacked into a fresh DIR.next (a stale one is removed first) without the top folder, owner or setuid bits (the top folder
#       0755, group and other can not write), DIR.next/.talos-source.json is written ({"v":1,"tag":TAG,"version":VER,"gitSha":SHA},
#       0644), and the packages are installed there, LOCKED DOWN: pnpm install --frozen-lockfile --ignore-scripts (no lifecycle script
#       of anything runs: not the root `prepare`, which would run git, and not a workspace package's), with --config.ignore-pnpmfile=true (the flag --ignore-pnpmfile does not exist for rebuild; a
#       .pnpmfile.cjs is code) and --config.manage-package-manager-versions=false (no other pnpm is fetched for a packageManager pin),
#       then pnpm -r rebuild of exactly the packages in ARCHIVE_BUILD_ALLOW (the same two as package.json's pnpm.onlyBuiltDependencies:
#       better-sqlite3 and esbuild, dependencies of workspace members; a test keeps the lists equal). Without pnpm: bun install
#       --frozen-lockfile --ignore-scripts, which runs NO script at all (so no native build of better-sqlite3, which only the relay
#       uses, and not esbuild's postinstall, which only checks its binary). A packages failure removes DIR.next, why "deps". DIR is
#       never touched. The result carries the digest of the tree (every file's sha256 and mode, every folder, every link,
#       fifo and the like, the stamp and node_modules included, taken after the packages are installed): {"v":1,"ok":true,"step":"prepare-archive","tree_sha256":"HEX"}.
#       Failures: {"v":1,"ok":false,"step":"prepare-archive","why":W} with W: tarball (FILE missing or unreadable), sha256, archive,
#       deps, checkout (DIR.next is a link, or the private folder or DIR.next could not be made). Exit 0 ok; 20 refused (nothing
#       changed); 21 stopped by a signal (stopped, nothing changed: DIR.next and the private copy removed); 64 bad arguments.
#   auto-update-apply.sh --swap --archive --checkout DIR --zip PATH --sha256 HEX --team TEAM --dest DIR --commit SHA --version VER
#                        --tree-sha256 HEX --result FILE [--health-file FILE --health-wait SECONDS] [--to REF: ignored]
#       --commit, --version and --tree-sha256 are required. Refused, nothing moved (exit 20), unless DIR.next holds a tree whose stamp
#       says that commit and version (why "checkout", also for a link in the way) and whose digest, recomputed here before any rename,
#       is the --tree-sha256 prepare printed (why "archive": the stamp is the script's own file and proves nothing alone). Then DIR
#       becomes DIR.previous (an older one is deleted first; a git checkout converts this way on its first archive update) and DIR.next
#       becomes DIR, and the NEW tree's install.sh --from-release runs exactly as in the git swap, with the same health gate. When it
#       fails, or the new app is not healthy, or the swap is stopped, the new tree is removed and DIR.previous is DIR again, undone by how
#       far the swap got ("restored":true|false, as in the git swap). Exits as the git swap: 0, 21 failed (restored or not), 22 not
#       healthy or rollback_failed.
#   auto-update-apply.sh --restore --archive --checkout DIR --result FILE
#       puts DIR.previous back as DIR (the current DIR is removed): the app's way back after a crash. Refused (why "checkout", exit 20)
#       without a DIR.previous that has a valid stamp or a .git folder, or with a link in the way. 21 if a rename failed.
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
# 64 bad arguments. git and pnpm (or bun, when there is no pnpm) come from PATH (the app passes its login shell's) in the git modes.
# The ARCHIVE modes ignore the caller's PATH: every system tool (tar, shasum/sha256sum, find, stat, cp, mv, awk, ...) is resolved by tool() to a
# full path in the TOOL_DIRS folders (/usr/bin /bin /usr/sbin /sbin: ONE assignment near the top, no override at run time, no environment
# variable consulted), and PATH itself, for the children they start, is exactly those folders. pnpm and bun
# are taken by ABSOLUTE path from --pnpm FILE and --bun FILE (each an executable regular file, else exit 64; the git modes ignore them):
# the runtime is bun when TALOS_JS_RUNTIME=bun or there is no --pnpm, else pnpm; with neither given, prepare-archive refuses, why "deps".
# pnpm runs with PATH=<the TOOL_DIRS folders>:<its own folder> (it needs node, found after the system folders). The new tree is trusted once its sha256
# checked out, and some of its code does run before the swap: pnpm reads its .npmrc, bun its bunfig.toml, and the allowlisted packages'
# own install scripts (esbuild's postinstall, better-sqlite3's) run in it; no other script of the tree does (--ignore-scripts, no pnpmfile).
# The checkout is a folder an agent can write to (its .git/config, hooks and refs), so every git call here runs hardened (g below): no
# fsmonitor program and no hook runs, no GIT_* variable from the caller steers it, no system or user git config is read, no prompt,
# stdin from /dev/null. Moving to a commit also needs HEAD (and a --restore REF, and the swap's way back to REF) to be in the release's
# history: a checkout with commits of its own is refused (why "local-commits", exit 20, nothing moved), never moved back to and installed;
# a release older than HEAD is refused as "older-release".
# The checkout's own files steer git as well (config keys, .git/info/attributes, grafts, refs/replace, a .git that is a link), so before
# any other git call preflight() refuses a checkout that is not a plain clone (why "checkout-config"): .git a real folder, every key of
# its own config on a short list, none of those control files, --show-toplevel the checkout itself. The clean check also sees ignored
# files and assume-unchanged / skip-worktree entries. The release's commit is fetched only from --repo-url (an https address the app
# gives), never from the checkout's own remote. This is a TRIPWIRE for the git path: the main protection is the write guard on the
# checkout's folder (kit/hooks/pre-tool-guard.py, apps/bridge/src/guards/rules.ts); the real fix is the sha256-pinned release tarball
# (the archive checkout, which has no .git at all).
# An archive mode must run privileged (bash -p): with the user id unchanged, bash then ignores the caller's exported functions (BASH_FUNC_*),
# BASH_ENV, ENV, SHELLOPTS and BASHOPTS for itself (PS4, CDPATH and GLOBIGNORE are still imported: the clean re-exec below drops them before
# anything uses them, and the exported functions are dropped from the environment of every child the same way). Decided with keywords
# only (for, case: an imported function can not replace them) before any other command runs. The app starts these modes as `/bin/bash -p <script> --prepare-archive ...`.
ARCHIVE_ARGS=0
for a in "$@"; do
  case "$a" in
    --prepare-archive|--archive)
      case $- in *p*) ;; *) echo "auto-update-apply: the archive modes must be run as: /bin/bash -p auto-update-apply.sh ..." >&2; exit 64 ;; esac
      ARCHIVE_ARGS=1; break ;;
  esac
done
set -uo pipefail
# The folders every system tool comes from, the ONE list (tool() below resolves each command to a full path in them, and the PATH of the archive
# modes and of every child they start is exactly these folders): never the PATH the app passes (a login shell's PATH may start with folders anyone
# can write to). Nothing overrides it at run time (no environment variable is read for it); the test runs a copy of the script with this one line
# rewritten.
TOOL_DIRS="/usr/bin /bin /usr/sbin /sbin"
TOOL_PATH="${TOOL_DIRS// /:}"
# The archive modes start over with a CLEAN environment: the script runs itself again through `/usr/bin/env -i` with only the variables below,
# so nothing the caller exported reaches any child of the archive path (pnpm, bun, the new tree's install.sh, open, osascript, tar, ...):
# not exported functions (BASH_FUNC_x%%, which bash -p ignores for THIS shell but which stay in the environment for every child bash),
# not SHELLOPTS, TAR_OPTIONS, GZIP, NODE_OPTIONS, npm_config_*, PERL5OPT, PERL5LIB, TMPDIR, PS4, CDPATH, GLOBIGNORE, ... What is passed:
# PATH=<the TOOL_DIRS folders>, LC_ALL=C, LANG=C, and (when set) HOME, USER, LOGNAME, TALOS_JS_RUNTIME, the two TALOS_APPLY_MAX_* caps, and the proxy
# variables the packages' download may need. install.sh needs nothing else (it reads TMPDIR, defaulting to /tmp, and TALOS_APP_HOME, see
# below). The second run is told by its first argument, --env-cleaned, which only the app (whoever builds the argument list) could add.
if [ "$ARCHIVE_ARGS" = 1 ] && [ "${1:-}" != --env-cleaned ]; then
  clean=(PATH="$TOOL_PATH" LC_ALL=C LANG=C)
  for v in HOME USER LOGNAME TALOS_JS_RUNTIME TALOS_APPLY_MAX_BYTES TALOS_APPLY_MAX_ENTRIES HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    [ -z "${!v+x}" ] || clean+=("$v=${!v}")
  done
  exec /usr/bin/env -i "${clean[@]}" "$BASH" -p "$0" --env-cleaned "$@"
fi
if [ "$ARCHIVE_ARGS" = 1 ]; then
  # --env-cleaned is not taken on trust: this run's environment must be exactly the kept list (plus what bash itself adds) and PATH the system folders
  extra="$(/usr/bin/env | /usr/bin/grep -vE '^(PATH|LC_ALL|LANG|HOME|USER|LOGNAME|TALOS_JS_RUNTIME|TALOS_APPLY_MAX_(BYTES|ENTRIES)|(HTTP|HTTPS|NO)_PROXY|(http|https|no)_proxy|PWD|SHLVL|_|OLDPWD|__CF_USER_TEXT_ENCODING)=')"
  if [ -n "$extra" ] || [ "$PATH" != "$TOOL_PATH" ]; then
    echo "auto-update-apply: --env-cleaned is only for the script's own clean re-run: the environment holds more than the kept variables, or PATH is not the system folders" >&2
    exit 64
  fi
  shift
fi
MODE="" CHECKOUT="" COMMIT="" ZIP="" PIN="" TEAM="" DEST="" RESULT="" TO="" HEALTH="" HEALTH_WAIT=300 NEWV="" REPO_URL="" ARCHIVE=0 TARBALL="" TAG="" TREE="" PNPM_BIN="" BUN_BIN="" GIT_BIN=git
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout|--commit|--zip|--sha256|--team|--dest|--result|--to|--health-file|--health-wait|--version|--repo-url|--tarball|--tag|--tree-sha256|--git|--pnpm|--bun)
      [ $# -ge 2 ] || { echo "auto-update-apply: $1 needs a value" >&2; exit 64; }
      case "$1" in
        --checkout) CHECKOUT="$2" ;; --commit) COMMIT="$2" ;; --zip) ZIP="$2" ;; --sha256) PIN="$2" ;;
        --team) TEAM="$2" ;; --dest) DEST="$2" ;; --result) RESULT="$2" ;; --to) TO="$2" ;;
        --health-file) HEALTH="$2" ;; --health-wait) HEALTH_WAIT="$2" ;; --version) NEWV="$2" ;; --repo-url) REPO_URL="$2" ;;
        --tarball) TARBALL="$2" ;; --tag) TAG="$2" ;; --tree-sha256) TREE="$2" ;; --pnpm) PNPM_BIN="$2" ;; --bun) BUN_BIN="$2" ;;
        --git) case "$2" in /*) [ -x "$2" ] || { echo "auto-update-apply: --git is not an executable file" >&2; exit 64; }; GIT_BIN="$2" ;; *) echo "auto-update-apply: --git needs a full path" >&2; exit 64 ;; esac ;;
      esac
      shift 2 ;;
    --archive) ARCHIVE=1; shift ;;
    --prepare|--swap|--restore|--preflight|--prepare-archive) [ -z "$MODE" ] || { echo "auto-update-apply: one mode only" >&2; exit 64; }; MODE="${1#--}"; shift ;;
    *) echo "auto-update-apply: unknown argument $1" >&2; exit 64 ;;
  esac
done
[ -n "$MODE" ] && [ -n "$CHECKOUT" ] && [ -n "$RESULT" ] || { echo "auto-update-apply: a mode, --checkout and --result are required" >&2; exit 64; }
SEMVER_RE='^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
if [ "$ARCHIVE" = 1 ]; then
  case "$MODE" in swap|restore) ;; *) echo "auto-update-apply: --archive goes with --swap or --restore" >&2; exit 64 ;; esac
fi
if [ "$ARCHIVE" = 1 ] || [ "$MODE" = prepare-archive ]; then
  while [ "${CHECKOUT%/}" != "$CHECKOUT" ]; do CHECKOUT="${CHECKOUT%/}"; done
  [ -n "$CHECKOUT" ] || { echo "auto-update-apply: --checkout is not a folder" >&2; exit 64; }
  # pnpm and bun live outside the system folders: by absolute path, an executable regular file, or not at all
  for tool in "$PNPM_BIN" "$BUN_BIN"; do
    [ -z "$tool" ] || { [[ "$tool" = /* ]] && [ -f "$tool" ] && [ -x "$tool" ]; } \
      || { echo "auto-update-apply: --pnpm and --bun need an absolute path to an executable file" >&2; exit 64; }
  done
fi
case "$MODE" in
  restore) [ "$ARCHIVE" = 1 ] || [ -n "$TO" ] || { echo "auto-update-apply: --restore needs --to" >&2; exit 64; }
    [ -z "$COMMIT" ] || [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "auto-update-apply: --commit needs a full commit id" >&2; exit 64; } ;;
  prepare) [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "auto-update-apply: --commit needs a full commit id" >&2; exit 64; } ;;
  prepare-archive)
    [ -n "$TARBALL" ] && [[ "$PIN" =~ ^[0-9a-f]{64}$ ]] && [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] && [[ "$NEWV" =~ $SEMVER_RE ]] \
      && { [ "$TAG" = "$NEWV" ] || [ "$TAG" = "v$NEWV" ] || [ "$TAG" = "mac-v$NEWV" ]; } \
      || { echo "auto-update-apply: --prepare-archive needs --tarball, --sha256, --commit (a full id), --version (X.Y.Z) and --tag (that, v<that> or mac-v<that>)" >&2; exit 64; } ;;
  swap)
    if [ "$ARCHIVE" = 1 ]; then
      [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] && [[ "$NEWV" =~ $SEMVER_RE ]] && [[ "$TREE" =~ ^[0-9a-f]{64}$ ]] \
        || { echo "auto-update-apply: --swap --archive needs --commit (a full id), --version (X.Y.Z) and --tree-sha256 (what --prepare-archive printed)" >&2; exit 64; }
      [[ "$PIN" =~ ^[0-9a-f]{64}$ ]] && [[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] && [ -f "$ZIP" ] && [ -n "$DEST" ] \
        || { echo "auto-update-apply: --swap --archive needs --zip, --sha256, --team and --dest" >&2; exit 64; }
    else
    [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] && [ -n "$TO" ] && [[ "$PIN" =~ ^[0-9a-f]{64}$ ]] && [[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] && [ -f "$ZIP" ] && [ -n "$DEST" ] \
      || { echo "auto-update-apply: --swap needs --commit, --to, --zip, --sha256, --team and --dest" >&2; exit 64; }
    fi
    [[ "$HEALTH_WAIT" =~ ^[0-9]{1,5}$ ]] || { echo "auto-update-apply: --health-wait is whole seconds" >&2; exit 64; } ;;
esac
# System tools by full path, from the TOOL_DIRS folders only (never through PATH, which may lead with a user-writable folder, and no variable of the
# environment names a folder). A tool in none of them is left as its /usr/bin name, so it fails loudly instead of being found somewhere else.
tool() { local d; for d in $TOOL_DIRS; do [ -x "$d/$1" ] && { printf '%s' "$d/$1"; return 0; }; done; printf '%s' "/usr/bin/$1"; }
LS="$(tool ls)" GREP="$(tool grep)" MKTEMP="$(tool mktemp)" RM="$(tool rm)" MV="$(tool mv)" AWK="$(tool awk)" PS="$(tool ps)" SLEEP="$(tool sleep)" SEQ="$(tool seq)" BASH_BIN="$(tool bash)" OPEN="$(tool open)" OSASCRIPT="$(tool osascript)"
TAR="$(tool tar)" SHASUM="$(tool shasum)" SHA256SUM="$(tool sha256sum)" FIND="$(tool find)" STAT="$(tool stat)" CP="$(tool cp)" GZIP="$(tool gzip)" CHMOD="$(tool chmod)" MKDIR="$(tool mkdir)"
HEAD="$(tool head)" WC="$(tool wc)" TR="$(tool tr)" SED="$(tool sed)" SORT="$(tool sort)" DIRNAME="$(tool dirname)" PRINTF="$(tool printf)"
GIT_RUN=(/usr/bin/env -i GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1)
for v in PATH HOME LANG LC_ALL TMPDIR http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
  [ -z "${!v:-}" ] || GIT_RUN+=("$v=${!v}")
done
# (--git-dir and --work-tree are given outright, so a core.worktree or a GIT_DIR cannot move them; no commit graph, no replace objects)
g() {
  "${GIT_RUN[@]}" "$GIT_BIN" -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.commitGraph=false \
    -c core.alternateRefsCommand= -c maintenance.auto=false -c gc.auto=0 \
    --git-dir="$CHECKOUT/.git" --work-tree="$CHECKOUT" -C "$CHECKOUT" "$@" </dev/null
}
# What a plain clone (and a developer's) has in its own config. A fresh clone writes the first eight; branch.* and remote.*.url/fetch
# are for more branches and remotes (a fork has an upstream remote); user.name and user.email are a developer's. Anything else (a
# program: core.fsmonitor, core.sshCommand, core.pager, filter.*, alias.*, include.*, ...) refuses the checkout.
config_allowed() {  # config_allowed <key> <value>
  # scripts/install-hooks.sh (run by the checkout's own pnpm install) sets core.hooksPath to the checkout's own .githooks: that value only
  [ "$1" = core.hookspath ] && [ "$2" = .githooks ] && return 0
  case "$1" in
    core.repositoryformatversion|core.filemode|core.bare|core.logallrefupdates|core.ignorecase|core.precomposeunicode) return 0 ;;
    remote.*.url|remote.*.fetch|branch.*.remote|branch.*.merge|branch.*.rebase|user.name|user.email|talos.nohooks) return 0 ;;
  esac
  return 1
}
# 0 when the checkout is a plain clone git can be trusted to read; else 1, and PF_WHY says which word to answer with.
PF_WHY=checkout-config
preflight() {
  local gd="$CHECKOUT/.git" f ent keys top
  if [ ! -e "$gd" ] && [ ! -L "$gd" ]; then PF_WHY=checkout; return 1; fi
  [ -d "$gd" ] && [ ! -L "$gd" ] || return 1
  # (commondir and gitdir make git read its config, refs, grafts, shallow and alternates from ANOTHER folder)
  for f in info/attributes info/grafts shallow objects/info/alternates config.worktree commondir gitdir; do
    if [ -e "$gd/$f" ] || [ -L "$gd/$f" ]; then return 1; fi
  done
  [ -z "$("$LS" -A "$gd/refs/replace" 2>/dev/null)" ] || return 1
  if "$GREP" -qs ' refs/replace/' "$gd/packed-refs"; then return 1; fi
  # (-z: each entry is "key", a newline, the value, a NUL; read through a file so a NUL survives)
  keys="$("$MKTEMP" "${TMPDIR:-/tmp}/apply-cfg.XXXXXX")" || return 1
  if ! g config --local --no-includes --list -z > "$keys" 2>/dev/null; then "$RM" -f "$keys"; return 1; fi
  while IFS= read -r -d '' ent; do
    config_allowed "${ent%%$'\n'*}" "${ent#*$'\n'}" || { "$RM" -f "$keys"; return 1; }
  done < "$keys"
  "$RM" -f "$keys"
  top="$(g rev-parse --show-toplevel 2>/dev/null)" || { PF_WHY=checkout; return 1; }
  [ -n "$top" ] && [ "$(cd "$top" 2>/dev/null && pwd -P)" = "$(cd "$CHECKOUT" 2>/dev/null && pwd -P)" ] || { PF_WHY=checkout; return 1; }
  return 0
}
# The commit from the explicit address the app gave (https; a local path or file:// only for tests), never from the checkout's remote.
fetch_release() {  # fetch_release <what to fetch>...
  local scheme=https
  case "$REPO_URL" in https://*) ;; file://*|/*) scheme=file ;; *) return 1 ;; esac
  g -c protocol.allow=never -c "protocol.$scheme.allow=always" -c credential.helper= -c core.askPass=/bin/false -c core.sshCommand=/bin/false \
    fetch --quiet "$REPO_URL" "$@"
}
say() { echo "auto-update-apply: $*"; }

# The outcome, written whole (temp file, then rename) so a reader never sees half of it.
result() {  # result <ok true|false> [why] [restored true|false]
  local body tmp
  if [ "$1" = true ]; then body="{\"v\":1,\"ok\":true,\"step\":\"$MODE\"${RESULT_EXTRA:-}}"
  elif [ -n "${3:-}" ]; then body="{\"v\":1,\"ok\":false,\"step\":\"$MODE\",\"why\":\"$2\",\"restored\":$3}"
  else body="{\"v\":1,\"ok\":false,\"step\":\"$MODE\",\"why\":\"$2\"}"; fi
  tmp="$RESULT.$$.tmp"
  ( umask 077; printf '%s\n' "$body" > "$tmp" ) && "$MV" -f "$tmp" "$RESULT"
}

# The packages: pnpm when the Mac has it, else bun (the app's own, last on the PATH it passes): the same choice the app made when it first
# installed this clone (scripts/install-js.sh), with the same flags. TALOS_JS_RUNTIME=bun forces bun.
deps() {
  ( cd "$CHECKOUT" || exit 1
    if [ "${TALOS_JS_RUNTIME:-}" = bun ] || ! command -v pnpm >/dev/null 2>&1; then TALOS_NO_HOOKS=1 bun install --frozen-lockfile --ignore-scripts </dev/null
    else pnpm install --frozen-lockfile </dev/null; fi )
}
# Clean: no change, no untracked file, no ignored file but node_modules (what the install makes), and no entry git was told to skip
# (assume-unchanged shows as a lower-case tag in ls-files -v, skip-worktree as S).
clean() {
  local out
  out="$(g -c core.untrackedCache=false status --porcelain --untracked-files=all --ignored --ignore-submodules=all 2>/dev/null)" || return 1
  [ -z "$(printf '%s\n' "$out" | "$GREP" -v -E '^!! (.*/)?node_modules(/|$)')" ] || return 1
  out="$(g ls-files -v 2>/dev/null)" || return 1
  ! printf '%s\n' "$out" | "$GREP" -q -E '^[a-zS] '
}

# Whether REF (a branch, or a commit) is the release's commit or in its history. With no --commit there is nothing to compare with.
in_release() {
  local c
  [ -n "$COMMIT" ] || return 0
  if g show-ref --verify --quiet "refs/heads/$1"; then c="$(g rev-parse --verify --quiet "refs/heads/$1^{commit}")"
  else c="$(g rev-parse --verify --quiet "$1^{commit}")"; fi
  [ -n "$c" ] && g merge-base --is-ancestor "$c" "$COMMIT"
}

# Back to REF: a branch name is checked out as that branch, anything else as a detached commit. Never to a REF outside the release's history.
move_back() {
  local ref="$1"
  preflight || return 1
  in_release "$ref" || return 1
  if g show-ref --verify --quiet "refs/heads/$ref"; then g checkout --quiet "$ref" || return 1
  else g checkout --quiet --detach "$ref" || return 1; fi
  deps >/dev/null 2>&1 || say "warning: the packages of $ref could not be installed again"
  return 0
}


# ---- the archive checkout: no git on any of this ----
NEXT="$CHECKOUT.next" PREV="$CHECKOUT.previous" FAILED="$CHECKOUT.failed.$$"
# The packages whose own install scripts may run in an archive checkout: package.json's pnpm.onlyBuiltDependencies (a test keeps them equal).
ARCHIVE_BUILD_ALLOW="better-sqlite3 esbuild"
# pnpm must not run a .pnpmfile.cjs of the tree (it is code, and runs even with --ignore-scripts), fetch another pnpm for a packageManager pin, or
# read ~/.npmrc (agent-writable: store-dir, script settings) or the global npmrc (userconfig and globalconfig are /dev/null).
PNPM_SAFE=(--config.ignore-pnpmfile=true --config.manage-package-manager-versions=false --config.userconfig=/dev/null --config.globalconfig=/dev/null)
# Caps on what an archive may unpack to (the environment may only LOWER them: a test does).
MAX_BYTES=2147483648 MAX_ENTRIES=200000
[[ "${TALOS_APPLY_MAX_BYTES:-}" =~ ^[0-9]{1,18}$ ]] && [ "$TALOS_APPLY_MAX_BYTES" -lt "$MAX_BYTES" ] && MAX_BYTES="$TALOS_APPLY_MAX_BYTES"
[[ "${TALOS_APPLY_MAX_ENTRIES:-}" =~ ^[0-9]{1,18}$ ]] && [ "$TALOS_APPLY_MAX_ENTRIES" -lt "$MAX_ENTRIES" ] && MAX_ENTRIES="$TALOS_APPLY_MAX_ENTRIES"
# The hash tool is chosen the same way every time: shasum -a 256 when the system folders have a shasum (macOS: /usr/bin/shasum; macOS 14+ also has a
# /sbin/sha256sum, which is not preferred), else sha256sum. Both print "<hex>  <name>" ("<hex> *<name>" in binary mode); only the hex is used.
set_sha256() { if [ -x "$SHASUM" ]; then SHA256=("$SHASUM" -a 256); else SHA256=("$SHA256SUM"); fi; }
sha256_of() { set_sha256; "${SHA256[@]}" "$1" | "$AWK" '{print $1}'; }
sha256_stdin() { set_sha256; "${SHA256[@]}" | "$AWK" '{print $1}'; }
# Remove a folder, never through a link (a link is not removed, nor followed: the caller refuses it first); read-only folders first made writable.
rm_tree() {
  [ -L "$1" ] && return 1
  [ -e "$1" ] || return 0
  [ -d "$1" ] && "$CHMOD" -R u+rwX "$1" 2>/dev/null
  "$RM" -rf -- "$1"
}
# The digest of a tree: sha256 over the sorted lines "d <path>" (a folder), "f <path> <sha256>" (a file), "m <path> <mode>" (the mode of
# each file and folder) and "o <path> <type> <target>" (anything else: a symlink "l" with its target, a fifo "p", a socket "s", a device
# "c" or "b"), for EVERY entry, node_modules included (prepare takes it after the packages are installed; the swap takes it again). The
# stamp is IN it. find does not follow links (no -L). A path with a line break in it makes the digest fail (no forged lines).
# Prepare prints it (tree_sha256) and the swap recomputes it on DIR.next before any rename: a tree changed in between does not go in.
tree_digest() {
  ( cd "$1" || exit 1
    export LC_ALL=C
    set_sha256
    unset QUOTING_STYLE   # (GNU stat's %N follows it)
    [ -z "$("$FIND" . \( -name $'*\n*' -o -lname $'*\n*' \) -print 2>/dev/null | "$HEAD" -n 1)" ] || exit 1
    {
      "$FIND" . -type d -print | "$SED" 's/^/d /'
      "$FIND" . -type f -exec "${SHA256[@]}" {} + | "$SED" -E 's/^([0-9a-f]{64}) [ *](.*)$/f \2 \1/'
      if "$STAT" -c %a . >/dev/null 2>&1; then
        "$FIND" . \( -type f -o -type d \) -exec "$STAT" -c '%a %n' {} +
        "$FIND" . -type l -exec "$STAT" -c 'o %n l %N' {} +
      else
        "$FIND" . \( -type f -o -type d \) -exec "$STAT" -f '%Lp %N' {} +
        "$FIND" . -type l -exec "$STAT" -f 'o %N l %Y' {} +
      fi | "$SED" -E 's/^([0-7]+) (.*)$/m \2 \1/'
      "$FIND" . \( -type p -exec "$PRINTF" 'o %s p\n' {} + \) -o \( -type s -exec "$PRINTF" 'o %s s\n' {} + \) \
        -o \( -type c -exec "$PRINTF" 'o %s c\n' {} + \) -o \( -type b -exec "$PRINTF" 'o %s b\n' {} + \)
    } | "$SORT" | sha256_stdin )
}
# Says why (and returns 0) when the tarball must not be unpacked: judged from its listing, before anything is written. The names come from
# `tar -tzf` (one per line) and the entry types from `tar -tzvf` (only each line's first letter is read); the two lists must have as
# many lines (a name with a line break would not). The repo has no link of any kind, so EVERY symlink and hard link is refused, which
# also leaves nothing for a clever link target (chains, ./ or case variants) to get past.
archive_unsafe() {
  local names verbose why count
  names="$("$MKTEMP" "${TMPDIR:-/tmp}/apply-names.XXXXXX")" || { echo "no temporary file"; return 0; }
  verbose="$names.v"
  if ! "$TAR" -tzf "$1" >"$names" 2>/dev/null || ! "$TAR" -tzvf "$1" >"$verbose" 2>/dev/null; then
    "$RM" -f "$names" "$verbose"; echo "not a readable gzip tar"; return 0
  fi
  count="$("$WC" -l <"$names" | "$TR" -d ' ')"
  if [ "$count" = 0 ] || [ "$count" != "$("$WC" -l <"$verbose" | "$TR" -d ' ')" ]; then
    "$RM" -f "$names" "$verbose"; echo "an empty archive, or a name with a line break in it"; return 0
  fi
  if [ "$count" -gt "$MAX_ENTRIES" ]; then "$RM" -f "$names" "$verbose"; echo "more than $MAX_ENTRIES entries"; return 0; fi
  if why="$("$AWK" '
    function bad(msg) { print msg; exit 1 }
    NR == FNR { nm[NR] = $0; next }
    {
      name = nm[FNR]; t = substr($0, 1, 1)
      if (name == "") bad("an empty name")
      if (substr(name, 1, 1) == "/") bad("an absolute path: " name)
      m = split(name, p, "/")
      for (k = 1; k <= m; k++) {
        if (p[k] == ".." || p[k] == ".") bad("a . or .. component: " name)
        if (p[k] == "" && k < m) bad("an empty component: " name)
      }
      if (index(name, "\\") > 0) bad("a backslash in a name (tar escapes odd names that way): " name)
      if (p[1] == "") bad("outside the single top folder: " name)
      if (top == "") top = p[1]
      if (p[1] != top) bad("outside the single top folder: " name)
      if (m < 2 && t != "d") bad("a file outside the top folder: " name)
      if (t == "l" || t == "h") bad("a link: " name)
      if (t !~ /^[-d]$/) bad("an entry that is not a file or a folder: " name)
    }' "$names" "$verbose")"; then "$RM" -f "$names" "$verbose"; return 1; fi
  "$RM" -f "$names" "$verbose"; echo "$why"; return 0
}
# After unpacking, the same judged from the files themselves (a second look, in case a listing was read wrongly): nothing but files and
# folders, no file with more than one name. 0 (and a reason) when unsafe.
tree_unsafe() {
  local odd
  odd="$("$FIND" "$1" ! -type f ! -type d -print 2>/dev/null | "$HEAD" -n 1)"
  [ -z "$odd" ] || { echo "not a plain file or folder: $odd"; return 0; }
  odd="$("$FIND" "$1" -type f -links +1 -print 2>/dev/null | "$HEAD" -n 1)"
  [ -z "$odd" ] || { echo "a file with more than one name: $odd"; return 0; }
  return 1
}
# The packages of an archive checkout, locked down: the lockfile must match (frozen), no install script runs but the allowlist's, no
# .pnpmfile.cjs loads and no other pnpm is fetched. pnpm: --ignore-scripts for the install (the root `prepare` would run git), then
# `pnpm -r rebuild` of exactly the allowlist (the packages are dependencies of workspace members, not of the root, and -r runs only
# those packages' own scripts, never the root's or a member's). bun: --frozen-lockfile --ignore-scripts, which runs no script of any package.
archive_deps() {
  ( cd "$NEXT" || exit 1
    umask 022
    if [ "${TALOS_JS_RUNTIME:-}" = bun ] || [ -z "$PNPM_BIN" ]; then
      [ -n "$BUN_BIN" ] || exit 1   # neither given (or bun wanted and not given): no fallback to a PATH
      TALOS_NO_HOOKS=1 "$BUN_BIN" install --frozen-lockfile --ignore-scripts </dev/null
    else
      # pnpm is a node script: node is looked for after the system folders, then beside pnpm itself
      PATH="$TOOL_PATH:${PNPM_BIN%/*}"; export PATH
      # pnpm's own global rc (~/.config/pnpm/rc, ~/Library/Preferences/pnpm/rc) is not read: pnpm looks at XDG_CONFIG_HOME first on every
      # platform (its getConfigDir), and here that is an empty folder inside the private one
      "$MKDIR" -p "$SNAPDIR/xdg-config" && XDG_CONFIG_HOME="$SNAPDIR/xdg-config" && export XDG_CONFIG_HOME || exit 1
      TALOS_NO_HOOKS=1 "$PNPM_BIN" install --frozen-lockfile --ignore-scripts "${PNPM_SAFE[@]}" </dev/null || exit 1
      # shellcheck disable=SC2086
      TALOS_NO_HOOKS=1 "$PNPM_BIN" -r rebuild "${PNPM_SAFE[@]}" $ARCHIVE_BUILD_ALLOW </dev/null
    fi )
}
# 0 when DIR holds a valid stamp (a regular file, never a link, in the shape the bridge reads: source-stamp.ts), and says the version
# and commit given (when they are).
stamp_ok() {
  local f="$1/.talos-source.json" line re
  re='^\{"v":1,"tag":"([^"]+)","version":"([^"]+)","gitSha":"([0-9a-f]{40})"\}$'
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  [ "$("$WC" -c <"$f" | "$TR" -d ' ')" -le 4096 ] || return 1
  line="$("$HEAD" -n 1 "$f")"
  [[ "$line" =~ $re ]] || return 1
  local tag="${BASH_REMATCH[1]}" ver="${BASH_REMATCH[2]}" sha="${BASH_REMATCH[3]}"
  [[ "$ver" =~ $SEMVER_RE ]] || return 1
  [ "$tag" = "$ver" ] || [ "$tag" = "v$ver" ] || [ "$tag" = "mac-v$ver" ] || return 1
  [ -z "$NEWV" ] || [ "$NEWV" = "$ver" ] || return 1
  [ -z "$COMMIT" ] || [ "$COMMIT" = "$sha" ] || return 1
  return 0
}
# STAGE says how far the swap got, and the way back follows it: 0 nothing moved, 1 DIR is DIR.previous (HAD_OLD: there was a DIR), 2 DIR.next
# is DIR as well.
STAGE=0 HAD_OLD=0
# 0 moved in; 1 refused with nothing moved (why checkout); 3 refused, the tree is not the one prepare digested (why archive); 2 a rename failed or
# did not leave what it should (archive_put_back undoes it by STAGE).
archive_move_in() {
  local p digest
  for p in "$CHECKOUT" "$NEXT" "$PREV" "$FAILED"; do [ ! -L "$p" ] || return 1; done
  [ -d "$NEXT" ] && stamp_ok "$NEXT" || return 1
  [ ! -e "$CHECKOUT" ] || [ -d "$CHECKOUT" ] || return 1
  [ ! -e "$PREV" ] || [ -d "$PREV" ] || return 1
  { [ ! -e "$FAILED" ] && [ ! -L "$FAILED" ]; } || return 1
  digest="$(tree_digest "$NEXT")" && [ "$digest" = "$TREE" ] || return 3
  rm_tree "$PREV" || return 1
  [ ! -e "$PREV" ] || return 2
  if [ -e "$CHECKOUT" ]; then
    "$MV" "$CHECKOUT" "$PREV" || return 2
    HAD_OLD=1
    [ ! -e "$CHECKOUT" ] && [ -d "$PREV" ] || { STAGE=1; return 2; }
  fi
  STAGE=1
  "$MV" "$NEXT" "$CHECKOUT" || return 2
  STAGE=2
  [ ! -e "$NEXT" ] && stamp_ok "$CHECKOUT" && [ ! -e "$CHECKOUT/${NEXT##*/}" ] || return 2
  return 0
}
# After a rename of DIR.previous to DIR: it is gone from where it was, DIR is a real folder, and it did not land INSIDE a DIR that was
# recreated meanwhile.
put_back_landed() { [ ! -e "$PREV" ] && [ ! -L "$PREV" ] && [ -d "$CHECKOUT" ] && [ ! -L "$CHECKOUT" ] && [ ! -e "$CHECKOUT/${PREV##*/}" ]; }
# Every way out of a swap that began, by STAGE: the new tree is moved aside, DIR.previous is DIR again, and only then is the new tree
# deleted. 0 when DIR is back (or there was none).
archive_put_back() {
  [ "$STAGE" != 0 ] || return 0
  if [ "$STAGE" = 2 ]; then
    [ ! -L "$FAILED" ] && [ ! -e "$FAILED" ] || return 1
    "$MV" "$CHECKOUT" "$FAILED" || return 1
    [ ! -e "$CHECKOUT" ] && [ ! -L "$CHECKOUT" ] && [ -d "$FAILED" ] && [ ! -L "$FAILED" ] || return 1
    STAGE=1
  fi
  if [ "$HAD_OLD" = 1 ]; then
    "$MV" "$PREV" "$CHECKOUT" || return 1
    put_back_landed || return 1
  fi
  STAGE=0
  [ ! -e "$FAILED" ] || rm_tree "$FAILED" || true
  return 0
}

if [ "$MODE" = prepare-archive ]; then
  SNAPDIR="" DONE=0
  prep_exit() {
    [ -z "$SNAPDIR" ] || "$RM" -rf -- "$SNAPDIR"
    [ "$DONE" = 1 ] && return 0
    rm_tree "$NEXT"; result false stopped; exit 21
  }
  # refuse <why> <text>: DIR is never touched; DIR.next is removed again when this came after it was made
  refuse() { DONE=1; rm_tree "$NEXT"; result false "$1"; say "$2; nothing was changed" >&2; exit 20; }
  early() { DONE=1; result false "$1"; say "$2; nothing was changed" >&2; exit 20; }
  trap prep_exit EXIT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  trap 'exit 130' INT
  [ ! -L "$NEXT" ] || early checkout "$NEXT is a link"
  # leftovers of a prepare that was killed: real folders of ours with that name, never through a link
  for leftover in "$("$DIRNAME" "$CHECKOUT")"/.apply-tar.*; do
    if [ -d "$leftover" ] && [ ! -L "$leftover" ] && [ -O "$leftover" ]; then rm_tree "$leftover" || true; fi
  done
  # A private copy, in a 0700 folder beside the checkout (nobody else can write there): hashed, listed and unpacked from THAT file only,
  # so the file the app downloaded can not be swapped between the check and the unpacking.
  SNAPDIR="$("$MKTEMP" -d "$("$DIRNAME" "$CHECKOUT")/.apply-tar.XXXXXX")" || early checkout "could not make a private folder beside $CHECKOUT"
  SNAP="$SNAPDIR/t.tgz"
  { [ -f "$TARBALL" ] && "$CP" "$TARBALL" "$SNAP" 2>/dev/null && "$CHMOD" 600 "$SNAP"; } || early tarball "could not read $TARBALL"
  [ "$(sha256_of "$SNAP")" = "$PIN" ] || early sha256 "$TARBALL is not the file with sha256 $PIN; nothing was unpacked"
  # what it unpacks to (the size of the uncompressed stream, read no further than the cap) and how many entries it has
  USIZE="$("$GZIP" -dc <"$SNAP" 2>/dev/null | "$HEAD" -c "$((MAX_BYTES + 1))" | "$WC" -c | "$TR" -d ' ')"
  [ "${USIZE:-0}" -le "$MAX_BYTES" ] || early archive "the archive unpacks to more than $MAX_BYTES bytes"
  if why="$(archive_unsafe "$SNAP")"; then early archive "the archive is refused: $why"; fi
  [ "$(sha256_of "$SNAP")" = "$PIN" ] || early sha256 "the private copy of $TARBALL changed; nothing was unpacked"
  rm_tree "$NEXT" || refuse checkout "could not clear $NEXT"
  "$MKDIR" -m 700 "$NEXT" || early checkout "could not make $NEXT"
  ( umask 022; "$TAR" -xzf "$SNAP" -C "$NEXT" --strip-components 1 --no-same-owner </dev/null ) >/dev/null 2>&1 || refuse archive "the archive could not be unpacked"
  "$CHMOD" -R u+rwX,go-w,u-s,g-s "$NEXT" 2>/dev/null
  "$CHMOD" 755 "$NEXT"
  if why="$(tree_unsafe "$NEXT")"; then refuse archive "the unpacked archive is refused: $why"; fi
  "$RM" -rf -- "$NEXT/.talos-source.json"
  stamp_tmp="$NEXT/.talos-source.json.$$.tmp"
  ( umask 022; printf '{"v":1,"tag":"%s","version":"%s","gitSha":"%s"}\n' "$TAG" "$NEWV" "$COMMIT" >"$stamp_tmp" ) \
    && "$CHMOD" 644 "$stamp_tmp" && "$MV" -f "$stamp_tmp" "$NEXT/.talos-source.json" || refuse archive "could not write the stamp"
  say "unpacked $TAG into $NEXT"
  archive_deps || refuse deps "the packages could not be installed"
  TREE_NOW="$(tree_digest "$NEXT")" && [[ "$TREE_NOW" =~ ^[0-9a-f]{64}$ ]] || refuse archive "could not digest the tree"
  DONE=1
  RESULT_EXTRA=",\"tree_sha256\":\"$TREE_NOW\""
  result true
  exit 0
fi
if [ "$ARCHIVE" = 1 ] && [ "$MODE" = restore ]; then
  # only a release tree (a valid stamp) or a git clone (a .git folder) is put back as DIR
  if [ -L "$CHECKOUT" ] || [ -L "$PREV" ] || [ ! -d "$PREV" ] || { ! stamp_ok "$PREV" && { [ -L "$PREV/.git" ] || [ ! -d "$PREV/.git" ]; }; }; then
    result false checkout; say "there is no $PREV (with a release stamp or a .git) to put back, or a link is in the way; nothing was changed" >&2; exit 20
  fi
  aside="$CHECKOUT.discard.$$"
  if [ -e "$CHECKOUT" ]; then "$MV" "$CHECKOUT" "$aside" || { result false checkout true; exit 21; }; fi
  if "$MV" "$PREV" "$CHECKOUT"; then
    if put_back_landed; then rm_tree "$aside" || true; result true; say "$PREV is $CHECKOUT again"; exit 0; fi
    result false checkout false; say "$PREV did not land as $CHECKOUT; look at $CHECKOUT and $aside" >&2; exit 21
  fi
  [ ! -e "$aside" ] || "$MV" "$aside" "$CHECKOUT"
  if [ -e "$CHECKOUT" ]; then result false checkout true; else result false checkout false; fi
  say "could not put $PREV back" >&2; exit 21
fi

if [ "$ARCHIVE" != 1 ] && ! preflight; then
  say "$CHECKOUT is not a plain git clone ($PF_WHY); nothing was changed" >&2
  # a swap runs after the checkout moved: nothing here can put it back safely, and the result says so
  if [ "$MODE" = swap ]; then result false "$PF_WHY" false; exit 21; fi
  result false "$PF_WHY"; exit 20
fi

if [ "$MODE" = preflight ]; then
  clean || { result false dirty; say "the checkout has changes of its own (or hides some); nothing was changed" >&2; exit 20; }
  result true; say "the checkout is a plain clone with no changes of its own"; exit 0
fi

if [ "$MODE" = restore ]; then
  in_release "$TO" || { result false local-commits; say "$TO is not in the history of $COMMIT; nothing was changed" >&2; exit 20; }
  if move_back "$TO"; then result true; say "the checkout is back on $TO"; exit 0; fi
  result false checkout false; say "could not put the checkout back on $TO" >&2; exit 21
fi

if [ "$MODE" = prepare ]; then
  # A checkout with nothing of its own changed: an edited install.sh would decide the swap.
  clean || { result false dirty; say "the checkout has changes of its own; nothing was changed" >&2; exit 20; }
  OLD_REF="$(g symbolic-ref --quiet --short HEAD 2>/dev/null || g rev-parse HEAD)"
  # The release's commit, from the public repo (fetched while the app waited; once more here if it is not there).
  if ! g cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
    fetch_release "$COMMIT" >/dev/null 2>&1 || fetch_release --tags >/dev/null 2>&1 || true
    g cat-file -e "$COMMIT^{commit}" 2>/dev/null || { result false checkout; say "commit $COMMIT is not in the public repo" >&2; exit 20; }
  fi
  # HEAD must be in the release's history: a checkout with commits of its own is not moved (and so never moved back to and installed).
  # A release that is OLDER than HEAD (the commit is in HEAD's history) is its own refusal: the app decides what to do about it.
  HEAD_NOW="$(g rev-parse --verify --quiet 'HEAD^{commit}')"
  if ! g merge-base --is-ancestor "$HEAD_NOW" "$COMMIT" 2>/dev/null; then
    if g merge-base --is-ancestor "$COMMIT" "$HEAD_NOW" 2>/dev/null; then
      result false older-release; say "the release is older than the checkout; nothing was changed" >&2; exit 20
    fi
    result false local-commits; say "the checkout has commits that are not in the release's history; nothing was changed" >&2; exit 20
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

# swap: still the prepared commit, still clean, or nothing is swapped (the checkout goes back to REF). With --archive: the prepared
# DIR.next goes in place of DIR (DIR becomes DIR.previous), and a way out puts them back.
DONE=0
put_back() { if [ "$ARCHIVE" = 1 ]; then archive_put_back; else move_back "$TO"; fi; }
fail_back() {
  DONE=1
  if put_back; then result false "$1" true; else result false "$1" false; fi
}
trap '[ "$DONE" = 1 ] || { fail_back stopped; exit 21; }' EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
if [ "$ARCHIVE" = 1 ]; then
  archive_move_in; rc=$?
  if [ "$rc" = 1 ]; then DONE=1; result false checkout; say "$NEXT is not a prepared release (or a link is in the way); nothing was changed" >&2; exit 20; fi
  if [ "$rc" = 3 ]; then DONE=1; result false archive; say "$NEXT is not the tree --prepare-archive digested; nothing was changed" >&2; exit 20; fi
  if [ "$rc" != 0 ]; then fail_back checkout; say "could not move $NEXT into place" >&2; exit 21; fi
  say "$NEXT is now $CHECKOUT (the one before is $PREV)"
elif [ "$(g rev-parse HEAD 2>/dev/null)" != "$COMMIT" ] || ! clean; then
  fail_back checkout; say "the checkout is no longer the prepared commit, or has changes of its own" >&2; exit 21
fi
# The release's own install.sh: it checks the zip again (sha256, codesign, Gatekeeper, the team), quits Talos, swaps with the old
# copy kept, and opens the new one. A failure there leaves the old app in place (install.sh's own rule).
[ -z "$HEALTH" ] || "$RM" -f "$HEALTH"
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
  "$PS" -axo pid=,comm= 2>/dev/null | "$AWK" -v e="$exe" '{ p = $1; sub(/^[ \t]*[0-9]+[ \t]+/, ""); if ($0 == e) print p }'
}
# A new app that hangs would not quit when install.sh --rollback asks it to: it is stopped first (TERM, 10 s, then KILL).
stop_new_app() {
  local pids i
  pids="$(app_pids)"
  [ -n "$pids" ] || return 0
  say "stopping the new app (pid $(echo $pids))"
  kill -TERM $pids 2>/dev/null || true
  for i in $("$SEQ" 1 20); do [ -z "$(app_pids)" ] && return 0; "$SLEEP" 0.5; done
  pids="$(app_pids)"
  [ -z "$pids" ] || kill -KILL $pids 2>/dev/null || true
  for i in $("$SEQ" 1 10); do [ -z "$(app_pids)" ] && return 0; "$SLEEP" 0.5; done
  return 0
}
# After the swap: the new app stopped, the kept previous app back (install.sh --rollback), the checkout back, the result, then the
# previous app opened (it posts the line). A rollback that fails leaves the checkout with the installed app and the kept copy.
roll_back() {
  local rb
  DONE=1
  say "the new app did not report healthy ($1); putting the previous one back" >&2
  stop_new_app
  "$BASH_BIN" "$CHECKOUT/apps/desktop/scripts/install.sh" --rollback --dest "$DEST" --no-open </dev/null
  rb=$?
  if [ "$rb" != 0 ]; then
    result false rollback_failed false
    say "install.sh --rollback failed (exit $rb); the previous app is still kept beside it" >&2
  elif put_back; then result false unhealthy true
  else result false unhealthy false; fi
  "$OPEN" "$DEST/Talos.app" || true
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
"$BASH_BIN" "$CHECKOUT/apps/desktop/scripts/install.sh" --from-release "$ZIP" --sha256 "$PIN" --team "$TEAM" --dest "$DEST" --no-relay-wait </dev/null
rc=$?
if [ "$rc" = 0 ]; then
  INSTALLED=1
  if [ -n "$HEALTH" ]; then
    waited=0
    until [ -s "$HEALTH" ]; do
      if [ "$waited" -ge "$HEALTH_WAIT" ]; then roll_back "no report in ${HEALTH_WAIT}s"; exit 22; fi
      "$SLEEP" 1
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
running="$("$OSASCRIPT" -e 'application id "app.talos.desktop" is running' 2>/dev/null || echo false)"
if [ -d "$DEST/Talos.app" ] && [ "$running" != true ]; then "$OPEN" "$DEST/Talos.app" || true; fi
exit 21
