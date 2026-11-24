#!/usr/bin/env bash
# Talos installer: a working agent from a fresh clone of this repo.
#
#   ./install.sh [--agent-dir PATH] [--no-app] [--no-relay-wait] [--no-tmux] [--dry-run] [--yes] [--apply] [--repoint] [--relay-url URL] [kit flags]
#
#   --agent-dir PATH  where the agent lives (default ~/talos-agent). Must be new, empty, or already a Talos agent.
#                     Any other non-empty folder is refused, and an existing CLAUDE.md is never overwritten.
#   --no-app          terminal only: skip the Mac menu-bar app (the only mode on Linux)
#   --no-relay-wait   install the Mac app without first waiting for a paired relay to serve the same build or a newer one
#                     (passed to apps/desktop/scripts/install.sh, which otherwise waits up to 10 min and stops if it doesn't)
#   --no-tmux         install the Mac app without tmux (the agent then stops when the app quits, and thread sessions are off)
#   --dry-run         print every step and change nothing
#   --apply           for an agent folder from kit 1.x that has no .talos-version: carry it onto this kit (connect it, upgrade
#                     the kit code with a backup, merge the new hooks into .claude/settings.json, add memory search). Without --apply that folder
#                     only gets the plan, and nothing changes. CLAUDE.md, memory/, wiki/, .learnings and .env are never written.
#   --yes             no confirmation prompt (required when there is no terminal to ask on)
#   --repoint         an agent whose .mcp.json or start-talos.sh points at ANOTHER clone of this repo is refused unless you
#                     pass this; it then points both at this clone
#   Chronos, the scheduler, comes with every Mac install, from apps/chronos in this clone (nothing is fetched), with its Claude
#                     jobs off until you enable them; an agent that exists gets it added (kit/install.sh --add-to-existing).
#                     A Chronos you made yourself (or run from a folder of your own) is never taken over: --reinstall-chronos moves it here.
#   --with-chronos    kept for older callers (the Mac app passed it): it adds nothing on a Mac, and never takes over a Chronos of yours.
#   --no-memory-search, --no-reranker: see scripts/install-memory.sh.
#   --relay-url URL   also set up the bridge (its key and settings) for your relay: a bare https origin, https://<host>, no path, query or user name. Without it
#                     the installer prints the exact command to run once the relay exists (docs: SETUP.md).
#
# Kit flags are passed to kit/install.sh unchanged: --with-vault DIR, --with-memory-search, --embed-model base|small,
# --with-reranker, --with-voice, --with-qwen-voice, --with-parakeet, --with-diarize, --global-pointer, --allow-protected-folder,
# --allow-synced-folder, and the Chronos ones: --notify talos|macos|none, --no-jobs, --full-access-jobs, --no-load,
# --no-session-hook, --reinstall-chronos, --set-chronos-workspace, --chronos-path DIR (a Chronos of your own, for development).
# See kit/install.sh --help for what each does.
#
# Steps: prerequisites; JS dependencies of this clone; the agent folder (the kit, default CLAUDE.md); a first git commit
# there; the talos-app MCP server for that folder; a launch script that loads the Talos mod with --plugin-dir; the Mac app
# and, only if the app is not running and the file already exists, its desktop.json (agent folder plus the same --plugin-dir
# and channel flags); otherwise the exact Settings change is printed for you to make. The Mac app is never quit by this script.
# The installer never deletes anything inside an agent folder. A failed kit copy is left for you to move aside.
# Run it twice and the second run changes nothing and says so. A failed step stops and says what was already done.
#
# Exit codes: 0 ok (for a kit 1.x folder without --apply: the plan was printed), 1 a step failed or the folder was refused,
# 2 bad usage or app not possible here, 3 missing or too-old prerequisites (each named with the no-admin way to get it).
# Test hooks (not for normal use): TALOS_INSTALL_OS overrides `uname -s`; TALOS_INSTALL_DESKTOP_SCRIPTS overrides
# apps/desktop/scripts.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$REPO/kit"; . "$REPO/scripts/install-memory.sh"; . "$REPO/scripts/install-js.sh"   # a new agent's memory defaults; how the packages are installed
MOD="$REPO/plugins/talos-app-mod"
CLI=(bun --no-env-file run "$REPO/apps/bridge/src/cli.ts")
DESKTOP="${TALOS_INSTALL_DESKTOP_SCRIPTS:-$REPO/apps/desktop/scripts}"
OS="${TALOS_INSTALL_OS:-$(uname -s)}"

AGENT_DIR="$HOME/talos-agent"; AGENT_DIR_GIVEN=0; VAULT_RAW=""; WANT_APP=1; DRY=0; YES=0; APPLY=0; NO_TMUX=0; CHRONOS=0; NO_CHRONOS=0; REPOINT=0; RELAY_URL=""; NO_MEMSEARCH=0; NO_RERANKER=0
APP_RELAY_FLAG=""     # --no-relay-wait when given here: passed to apps/desktop/scripts/install.sh
KIT_ARGS=()          # kit/install.sh flags given on our command line, passed through unchanged
KIT_CHRONOS_ONLY=()  # the subset that means nothing without Chronos (refused without --with-chronos, never silently dropped)
usage() { awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; }
# A flag's value is never the next flag: `--with-vault --dry-run` must not make "--dry-run" a folder name.
need_value() { { [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ]; } || { echo "$1 needs a value (got '${2-}')" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) need_value "$@"; AGENT_DIR="$2"; AGENT_DIR_GIVEN=1; shift 2 ;;
    --no-app) WANT_APP=0; shift ;;
    --no-relay-wait) APP_RELAY_FLAG=--no-relay-wait; shift ;;
    --dry-run) DRY=1; shift ;;
    --apply) APPLY=1; shift ;;
    --no-tmux) NO_TMUX=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --with-chronos) CHRONOS=1; CHRONOS_ASKED=1; shift ;;
    --no-chronos) NO_CHRONOS=1; shift ;;  --no-memory-search) NO_MEMSEARCH=1; shift ;;  --no-reranker) NO_RERANKER=1; shift ;;
    --repoint) REPOINT=1; shift ;;
    --relay-url) need_value "$@"; RELAY_URL="$2"; shift 2 ;;
    # kit/install.sh flags that take a value
    --with-vault) need_value "$@"; VAULT_RAW="$2"; shift 2 ;;   # resolved and checked below, then passed on
    --embed-model) need_value "$@"; KIT_ARGS+=("$1" "$2"); KIT_OTHER=1; shift 2 ;;
    --notify|--chronos-path)
      need_value "$@"; KIT_ARGS+=("$1" "$2"); KIT_CHRONOS_ONLY+=("$1"); shift 2 ;;
    # kit/install.sh flags without a value
    --with-memory-search|--with-reranker|--with-voice|--with-qwen-voice|--with-parakeet|--with-diarize|--global-pointer|--allow-protected-folder|--allow-synced-folder)
      KIT_ARGS+=("$1"); KIT_OTHER=1; shift ;;
    --no-jobs|--full-access-jobs|--no-load|--no-session-hook|--reinstall-chronos|--set-chronos-workspace)
      KIT_ARGS+=("$1"); KIT_CHRONOS_ONLY+=("$1"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
if [ "$APPLY" = 1 ] && [ "$DRY" = 1 ]; then echo "--apply and --dry-run contradict each other; pick one." >&2; exit 2; fi; memsearch_flags_ok
if [ "$CHRONOS" = 1 ] && [ "$NO_CHRONOS" = 1 ]; then echo "--with-chronos and --no-chronos contradict each other; pick one." >&2; exit 2; fi
# Chronos comes with every Mac install; --no-chronos (not in the help) is the tests' switch for an install without it
[ "$NO_CHRONOS" = 1 ] || [ "${TALOS_INSTALL_OS:-$(uname -s)}" != Darwin ] || CHRONOS=1
if [ "$CHRONOS" != 1 ] && [ ${#KIT_CHRONOS_ONLY[@]} -gt 0 ]; then
  echo "${KIT_CHRONOS_ONLY[*]} only does something with Chronos, which this install leaves out (--no-chronos, or not macOS, where --with-chronos adds it). Drop the flag. Nothing was changed." >&2
  exit 2
fi
if [ -n "$RELAY_URL" ]; then
  # A bare https origin only: no query, fragment, user info, path (one trailing slash is dropped), ';' or space.
  relay_re='^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?/?$'
  [[ "$RELAY_URL" =~ $relay_re ]] || { echo "--relay-url must be a bare https origin, https://<host> or https://<host>:<port>, with no path, query, fragment, user name or ';', and no empty label such as '..' (got '$RELAY_URL')." >&2; exit 2; }
  RELAY_URL="${RELAY_URL%/}"
fi
# The vault is private. Resolve it to an absolute path against where you run this, and refuse anything at or under this clone
# (a clone can be pushed: one `git add -A && git push` from public). kit/install.sh checks other repositories too.
if [ -n "$VAULT_RAW" ]; then
  case "$VAULT_RAW" in "~"|"~/"*) VAULT_RAW="$HOME${VAULT_RAW#\~}" ;; esac
  case "$VAULT_RAW" in /*) ;; *) VAULT_RAW="$PWD/$VAULT_RAW" ;; esac
  _rest=""; _anc="${VAULT_RAW%/}"
  while [ ! -d "$_anc" ] && [ "$_anc" != "/" ] && [ -n "$_anc" ]; do _rest="/$(basename "$_anc")$_rest"; _anc="$(dirname "$_anc")"; done
  case "$_rest/" in */../*|*/./*) echo "--with-vault: '$VAULT_RAW' has a . or .. in a part that does not exist yet; give a plain path." >&2; exit 2 ;; esac
  VAULT_ABS="$(cd "$_anc" 2>/dev/null && pwd -P)$_rest"
  REPO_REAL="$(cd "$REPO" && pwd -P)"
  # macOS volumes ignore letter case, and bash's pwd -P does not fold it, so compare lower-cased there.
  _lc() { if [ "$OS" = Darwin ]; then printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; else printf '%s' "$1"; fi; }
  _va="$(_lc "$VAULT_ABS/")"; _r1="$(_lc "$REPO_REAL/")"; _r2="$(_lc "$REPO/")"
  case "$_va" in "$_r1"*|"$_r2"*)
    echo "--with-vault: $VAULT_ABS is inside this clone ($REPO_REAL). The vault is private and a clone can be pushed to GitHub. Pick a folder outside it, for example ~/private-agent-vault." >&2; exit 2 ;;
  esac
  KIT_ARGS+=(--with-vault "$VAULT_ABS")
fi
# Version 1.x used ~/my-agent as the default. With no --agent-dir, do not quietly start a second agent beside it.
if [ "$AGENT_DIR_GIVEN" = 0 ] && [ -e "$HOME/my-agent" ] && [ ! -e "$HOME/talos-agent" ]; then
  echo "Found an agent at ~/my-agent (the old default folder) and none at ~/talos-agent (the new default). Nothing was changed. Say which you mean:" >&2
  echo "  keep using the old one:   ./install.sh --agent-dir ~/my-agent ..." >&2
  echo "  move it to the new name:  mv ~/my-agent ~/talos-agent, then ./install.sh --repoint ..." >&2
  echo "  start a second, new one:  ./install.sh --agent-dir ~/talos-agent ..." >&2
  exit 1
fi

DONE=()      # steps that changed something
CHANGED=0
CURRENT="starting"
say()  { printf '%s\n' "$*"; }
step() { CURRENT="$1"; printf '\n== %s\n' "$1"; }
plan() { printf '   would: %s\n' "$*"; }
skip() { printf '   ok, already done: %s\n' "$*"; }
did()  { CHANGED=1; DONE+=("$1"); }
fail() {
  local code="$1"; shift
  printf '\nFAILED at "%s": %s\n' "$CURRENT" "$*" >&2
  if [ ${#DONE[@]} -gt 0 ]; then printf 'Already done (left in place): %s\n' "$(IFS=';'; echo "${DONE[*]}")" >&2
  else echo "Nothing had been changed yet." >&2; fi
  echo "Fix the problem and run ./install.sh again; finished steps are skipped." >&2
  exit "$code"
}

case "$AGENT_DIR" in "~"|"~/"*) AGENT_DIR="$HOME${AGENT_DIR#\~}" ;; esac
case "$AGENT_DIR" in /*) ;; *) AGENT_DIR="$PWD/$AGENT_DIR" ;; esac

if [ "$WANT_APP" = 1 ] && [ "$OS" != Darwin ]; then
  echo "The Mac app needs macOS; this is $OS. Run ./install.sh --no-app for the terminal-only install." >&2
  exit 2
fi
[ "$DRY" = 1 ] && say "DRY RUN: nothing will be changed."

# ---------------------------------------------------------------- 1. prerequisites
step "1/7 Prerequisites"
# Every check here only reads. Each problem is one line: what, the version found against the version needed, and the way to
# get it that needs no admin password where there is one. All of them are listed, then the script stops before step 2.
MISSING=()
TMUX_ROUTE=0
# The first dotted number in a version line: "tmux 3.3a" -> 3.3, "tmux next-3.6" -> 3.6, "2.1.323 (Claude Code)" -> 2.1.323.
vnum() { printf '%s\n' "$1" | sed -n 's/^[^0-9]*\([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p' | head -1; }
# ver_ge A B: A is B or newer, compared number by number (three parts; a missing part counts as 0).
ver_ge() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 _ <<EOF
$1
EOF
  IFS=. read -r b1 b2 b3 _ <<EOF
$2
EOF
  for p in "${a1:-0} ${b1:-0}" "${a2:-0} ${b2:-0}" "${a3:-0} ${b3:-0}"; do
    set -- $p
    case "$1$2" in *[!0-9]*) return 1 ;; esac
    [ "$1" -gt "$2" ] && return 0
    [ "$1" -lt "$2" ] && return 1
  done
  return 0
}
# What this clone asks for, read from the files that set it, so a bump there moves the check too.
# (a file that is not there leaves the number this script was written with)
NODE_NEED="$(sed -n 's/.*"node": *">= *\([0-9][0-9]*\).*/\1/p' "$REPO/package.json" 2>/dev/null | head -1 || true)"; NODE_NEED="${NODE_NEED:-24}"
PNPM_NEED="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\).*/\1/p' "$REPO/package.json" 2>/dev/null | head -1 || true)"; PNPM_NEED="${PNPM_NEED:-10.33.0}"
SWIFT_NEED="$(sed -n '1s/.*swift-tools-version: *\([0-9.]*\).*/\1/p' "$REPO/apps/desktop/Package.swift" 2>/dev/null || true)"; SWIFT_NEED="${SWIFT_NEED:-6.2}"
CLAUDE_NEED="$(sed -n "s/.*CLAUDE_CODE_MIN_VERSION = '\([0-9.]*\)'.*/\1/p" "$REPO/packages/protocol/src/session.ts" 2>/dev/null | head -1 || true)"; CLAUDE_NEED="${CLAUDE_NEED:-2.1.304}"
BUN_NEED=1.4.4    # apps/bridge/src/bun-floor.ts holds the same number
TMUX_NEED=3.2
PY_NEED=3.9
# found NAME VERSION PATH / problem LINE: the two outcomes of one check
found()   { say "   found $1 ${2:-(version unknown)}: $3"; }
problem() { say "   PROBLEM $1"; MISSING+=("$1"); }
# check NAME NEED VERSION-COMMAND... : present and at least NEED. Sets VER (empty when missing) for the caller's message.
check() {
  local name="$1" need="$2"; shift 2
  VER=""; WHERE="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$WHERE" ] || return 2
  VER="$(vnum "$("$@" 2>/dev/null || true)")"
  [ -n "$VER" ] || return 3
  ver_ge "$VER" "$need" || return 1
  found "$name" "$VER" "$WHERE"
}
# the words for "found X" in a problem line
got() { case "$1" in 2) echo "not found" ;; 3) echo "found $WHERE, but it did not say its version" ;; *) echo "found $VER" ;; esac; }

ADMIN_FREE_NODE="curl -fsSL https://fnm.vercel.app/install | bash -s -- --force-install, open a new terminal, then fnm install $NODE_NEED && fnm default $NODE_NEED"
# the file a chain of links ends at (bash alone: no realpath on an older macOS)
link_end() {
  local p="$1" l n=0
  while [ -L "$p" ] && [ "$n" -lt 20 ]; do
    l="$(readlink "$p")"; case "$l" in /*) p="$l" ;; *) p="$(dirname "$p")/$l" ;; esac; n=$((n + 1))
  done
  printf '%s' "$p"
}
# Are the developer tools there: `xcode-select -p` says, by its exit code (it fails on a Mac without them, and names the selected
# folder, the Command Line Tools or a full Xcode, on one with them). Only a failure means "not installed": then /usr/bin/git,
# /usr/bin/python3 and /usr/bin/swift are Apple's stubs, and running one opens the "install the command line developer tools?"
# dialog, so they are not run. Nothing here reads HOME. (Every Mac has xcode-select; with none on the PATH: XS=none.)
DEVDIR=""; XS=none
if command -v xcode-select >/dev/null 2>&1; then
  if DEVDIR="$(xcode-select -p 2>/dev/null)"; then XS=ok; else XS=missing; DEVDIR=""; fi
fi
clt_stub() { [ "$OS" = Darwin ] && [ "$XS" = missing ] && [ "$(link_end "$(command -v "$1")")" = "/usr/bin/$1" ]; }
CLT_FIX="It comes with the Xcode Command Line Tools: ask IT for them (with admin: xcode-select --install; Linux: your package manager)."
if ! command -v git >/dev/null 2>&1; then problem "git: not found. $CLT_FIX"
elif clt_stub git; then problem "git: only Apple's stub (the Command Line Tools are not installed). $CLT_FIX"
else found git "$(vnum "$(git --version 2>/dev/null)")" "$(command -v git)"; fi
rc=0
if command -v python3 >/dev/null 2>&1 && clt_stub python3; then
  problem "python3 $PY_NEED or newer: only Apple's stub (the Command Line Tools are not installed). $CLT_FIX"
else
  check python3 "$PY_NEED" python3 --version || rc=$?
  [ "$rc" = 0 ] || problem "python3 $PY_NEED or newer: $(got $rc). $CLT_FIX"
fi
check_node_pnpm   # node and pnpm, unless TALOS_JS_RUNTIME=bun (scripts/install-js.sh)
rc=0; check bun "$BUN_NEED" bun --version || rc=$?
[ "$rc" = 0 ] && bun_runs_or_problem || problem "Bun $BUN_NEED or newer: $(got $rc). No admin needed: curl -fsSL https://bun.sh/install | bash (it installs into ~/.bun; an older Bun: bun upgrade)."
rc=0; check claude "$CLAUDE_NEED" claude --version || rc=$?
# Claude Code's installer puts claude in ~/.local/bin and leaves the PATH alone: installed but not found is common, so say how.
LOCAL_BIN_LINE="echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile"
[ "$rc" = 2 ] && [ -x "$HOME/.local/bin/claude" ] && { problem "Claude Code is installed ($HOME/.local/bin/claude) but ~/.local/bin is not on your PATH. Run: $LOCAL_BIN_LINE, then open a new terminal."; rc=0; }
[ "$rc" = 0 ] || problem "Claude Code $CLAUDE_NEED or newer: $(got $rc). No admin needed: curl -fsSL https://claude.ai/install.sh | bash (it installs into ~/.local/bin and does not change your PATH: then run $LOCAL_BIN_LINE and open a new terminal; an older one: claude update), then run claude once to sign in. More: https://claude.com/claude-code"

# The Mac app is built here from source (apps/desktop/Package.swift asks for Swift tools $SWIFT_NEED): the developer tools (the
# Command Line Tools or a full Xcode, whichever xcode-select names) have to be there, with a swift that says $SWIFT_NEED or newer.
# swift is asked only when xcode-select did not fail, since the /usr/bin/swift stub on a Mac without the tools opens the dialog.
if [ "$WANT_APP" = 1 ]; then
  if [ "$XS" != ok ]; then
    problem "Xcode Command Line Tools with Swift $SWIFT_NEED or newer: not installed. Ask IT for the Xcode Command Line Tools with Swift $SWIFT_NEED+ (with admin: xcode-select --install, then accept the dialog; it can take 15 to 40 minutes)."
  else
    CLT_VER=""
    if command -v pkgutil >/dev/null 2>&1; then
      CLT_VER="$(pkgutil --pkg-info=com.apple.pkg.CLTools_Executables 2>/dev/null | sed -n 's/^version: *//p' | head -1 || true)"
    fi
    SWIFT_LINE=""; command -v swift >/dev/null 2>&1 && SWIFT_LINE="$(swift --version 2>&1 || true)"
    SWIFT_VER="$(printf '%s\n' "$SWIFT_LINE" | sed -n 's/.*Swift version \([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p' | head -1)"
    FROM="${DEVDIR:-the folder xcode-select selects}${CLT_VER:+, Command Line Tools $CLT_VER}"
    if [ -n "$SWIFT_VER" ] && ver_ge "$SWIFT_VER" "$SWIFT_NEED"; then found swift "$SWIFT_VER" "$FROM"
    elif [ -n "$SWIFT_VER" ]; then
      problem "Swift $SWIFT_NEED or newer: found $SWIFT_VER ($FROM). Ask IT for the Xcode Command Line Tools with Swift $SWIFT_NEED+ (Command Line Tools or Xcode 26 or newer)."
    else
      problem "Swift $SWIFT_NEED or newer: $( [ -n "$SWIFT_LINE" ] && echo "swift did not say its version" || echo "no swift") in $FROM. Ask IT for the Xcode Command Line Tools with Swift $SWIFT_NEED+ (with admin: xcode-select --install)."
    fi
  fi
fi

# tmux keeps the agent running after the Mac app quits, and runs thread sessions. Homebrew is looked at only when tmux is
# missing or old, since that is the one thing here it would be used for.
tmux_fix() {
  if command -v brew >/dev/null 2>&1; then echo "brew install tmux (Homebrew is at $(command -v brew)), or the no-admin route below"
  else echo "No Homebrew here (installing it needs admin). No admin needed: the micromamba route below puts tmux in ~/.local; or ask IT for tmux (or Homebrew)"; fi
}
if [ "$WANT_APP" = 1 ] && [ "$NO_TMUX" != 1 ]; then
  rc=0; check tmux "$TMUX_NEED" tmux -V || rc=$?
  if [ "$rc" != 0 ]; then
    TMUX_ROUTE=1
    problem "tmux $TMUX_NEED or newer: $(got $rc). $(tmux_fix). Or pass --no-tmux to go on without it (the agent then stops when the app quits, and thread sessions are off)."
  fi
elif [ "$WANT_APP" = 1 ]; then say "   tmux not checked (--no-tmux): the agent stops when the app quits, and thread sessions are off"
else
  rc=0; check tmux "$TMUX_NEED" tmux -V || rc=$?
  [ "$rc" = 0 ] || say "   note: tmux $TMUX_NEED or newer: $(got $rc). Not needed for this terminal install; thread sessions (SETUP.md, step 9.6) need it."
fi
[ -d "$MOD" ] || MISSING+=("the Talos mod folder $MOD is not in this clone: re-clone the repo")
[ -d "$KIT" ] || MISSING+=("the kit folder $KIT is not in this clone: re-clone the repo")
if [ ${#MISSING[@]} -gt 0 ]; then
  printf '\nCannot continue. Missing or too old:\n' >&2
  for m in "${MISSING[@]}"; do printf '  - %s\n' "$m" >&2; done
  if [ "$TMUX_ROUTE" = 1 ]; then
    # micromamba and tmux are pinned. The micromamba binary is the release's own file, checked against the SHA-256 that
    # release publishes (micromamba-<platform>.sha256, mamba-org/micromamba-releases 2.10.0-0), copied here.
    MM_VER=2.10.0-0; TMUX_PIN=3.8_
    case "${TALOS_FORCE_ARCH:-$(uname -m)}" in
      x86_64) MM_PLAT=osx-64; MM_SHA=8421462a1ef1df9f7acd114f9e2a24c1332ce4f4e29f44465b4acb44e2755172 ;;
      *) MM_PLAT=osx-arm64; MM_SHA=c547639f5caf742236641c362746abb4a3505774753ecd08fe341643670c4c01 ;;
    esac
    cat >&2 <<EOF

tmux with no admin password (micromamba $MM_VER and conda-forge's tmux $TMUX_PIN, all under ~/.local; about 30 MB; tested on Apple Silicon).
Each line is safe to run again: nothing that is already there is replaced.
  mkdir -p ~/.local/bin ~/.local/talos-tmux-tools
  curl -fsSL -o ~/.local/talos-tmux-tools/micromamba.download https://github.com/mamba-org/micromamba-releases/releases/download/$MM_VER/micromamba-$MM_PLAT
  echo "$MM_SHA  \$HOME/.local/talos-tmux-tools/micromamba.download" | shasum -a 256 -c - && mv ~/.local/talos-tmux-tools/micromamba.download ~/.local/talos-tmux-tools/micromamba && chmod +x ~/.local/talos-tmux-tools/micromamba
  ~/.local/talos-tmux-tools/micromamba create -y -r ~/.local/micromamba -p ~/.local/talos-tmux -c conda-forge --override-channels 'tmux=$TMUX_PIN'
  if [ -e ~/.local/bin/tmux ] || [ -L ~/.local/bin/tmux ]; then echo "~/.local/bin/tmux is already there and was left alone (the Mac app also looks in ~/.local/talos-tmux/bin)"; else ln -s ~/.local/talos-tmux/bin/tmux ~/.local/bin/tmux; fi
  grep -qxF 'export PATH="\$HOME/.local/bin:\$PATH"' ~/.zprofile 2>/dev/null || echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.zprofile
Then open a new terminal and check: tmux -V
EOF
  fi
  echo "Install what is listed, then run ./install.sh again. Nothing was changed." >&2
  exit 3
fi

# ---------------------------------------------------------------- 2. the agent folder is safe to use
step "2/7 Agent folder"
say "   $AGENT_DIR"
PARENT="$(dirname "$AGENT_DIR")"
# The folder as the disk has it: the nearest part that exists, with its links resolved, and the rest as given. Compared as
# text alone, a path that reaches the clone through a link would pass.
physical() {
  local p="$1" rest="" base
  while [ ! -d "$p" ]; do rest="/$(basename "$p")$rest"; p="$(dirname "$p")"; done
  base="$(cd "$p" && pwd -P)" || base="$p"
  [ "$base" = / ] && base=""
  printf '%s%s' "$base" "$rest"
  # a . or .. in a part that does not exist yet is resolved only by the mkdir, after this check: refused
  case "$rest/" in */../*|*/./*) return 1 ;; esac
}
AGENT_PHYS="$(physical "$AGENT_DIR")" || fail 1 "the agent folder $AGENT_DIR has a . or .. in a part that does not exist yet; give a plain path."
REPO_PHYS="$(cd "$REPO" && pwd -P)"
# macOS volumes ignore letter case, and pwd -P does not fold it: compared lower-cased there, as the vault check does
_fold() { if [ "$OS" = Darwin ]; then printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'; else printf '%s' "$1"; fi; }
for _r in "$(_fold "$REPO")" "$(_fold "$REPO_PHYS")"; do for _a in "$(_fold "$AGENT_DIR")" "$(_fold "$AGENT_PHYS")"; do
  case "$_a/" in "$_r"/*) fail 1 "the agent folder cannot be inside this clone ($REPO); memory must not live in a git checkout with a remote." ;; esac
  case "$_r/" in "$_a"/*) fail 1 "the agent folder cannot contain this clone." ;; esac
done; done
ALREADY=0; UNFINISHED=0; VERIFY_WARNED=0; V1=0; V1_FINISH=0
MERGE=(python3 "$KIT/scripts/settings-merge.py" --agent-dir "$AGENT_DIR" --template "$KIT/templates/dot-claude/settings.json")
# A carry onto this kit that this installer started and did not finish: it writes .talos-carry into the folder before its first
# write and removes it after its last, so the state is never guessed from hooks (a kit 1.x folder carried earlier, or one a
# later kit adds a hook to, has no such file and is an agent like any other). Once upgrade.sh has stamped the folder, the next
# run finishes the carry; before the stamp, the folder is still unstamped and the carry simply starts again.
CARRY_FILE="$AGENT_DIR/.talos-carry"
v1_unfinished() { [ -f "$1/.talos-carry" ] && [ ! -L "$1/.talos-carry" ] && [ -f "$1/.talos-version" ] && [ ! -L "$1/.talos-version" ]; }
carry_get() { sed -n "s/^$1=//p" "$CARRY_FILE" 2>/dev/null | tail -1; }
# A kit 1.x agent from before versions were stamped: the kit's own files (CLAUDE.md, memory/, hooks/, scripts/) and no
# .talos-version that leads anywhere. A link (hooks/ or scripts/ into somewhere else, a .talos-version link that leads nowhere)
# still counts, so the carry step below can name it and refuse: it never writes through a link.
is_v1_kit() {
  [ ! -e "$1/.talos-version" ] && [ -f "$1/CLAUDE.md" ] && [ -d "$1/memory" ] && [ -d "$1/hooks" ] && [ -d "$1/scripts" ]
}
if [ -e "$AGENT_DIR" ]; then
  [ -d "$AGENT_DIR" ] || fail 1 "$AGENT_DIR exists and is not a folder."
  # An install that stopped after the kit stamped .talos-version but before the default CLAUDE.md was rendered is not an
  # agent yet: this run finishes it, and its checks stay strict (never warnings over a placeholder).
  # The same test render-default.py makes: only the shipped placeholder, byte for byte (a CLAUDE.md the owner wrote in, even
  # one that quotes the marker, is theirs: the agent counts as installed).
  if [ -f "$AGENT_DIR/.talos-version" ] && cmp -s "$AGENT_DIR/CLAUDE.md" "$KIT/CLAUDE.md"; then
    UNFINISHED=1; say "   a Talos agent whose install did not finish (CLAUDE.md is still the placeholder): this run finishes it."
  elif v1_unfinished "$AGENT_DIR"; then
    V1=1; V1_FINISH=1; say "   a kit 1.x agent with a carry onto this kit that did not finish (.talos-carry is there): this run finishes it."
  elif [ -f "$AGENT_DIR/.talos-version" ]; then ALREADY=1; say "   already a Talos agent (.talos-version found); it will not be reinstalled and CLAUDE.md is left as it is."
  elif is_v1_kit "$AGENT_DIR"; then
    V1=1; say "   an agent from kit 1.x with no .talos-version (made before versions were stamped): it is carried onto this kit, not reinstalled."
  elif [ -n "$(ls -A "$AGENT_DIR" 2>/dev/null | grep -v '^\.DS_Store$' || true)" ]; then
    # Never resumed and never cleared: a half-copied folder looks exactly like somebody's own, so the owner moves it aside.
    fail 1 "$AGENT_DIR exists, is not empty and is not a Talos agent. Nothing was touched. Pick a new folder with --agent-dir. If it is a partial copy from an earlier run of this script, move it aside (for example: mv $AGENT_DIR $AGENT_DIR.partial) and run ./install.sh again. If it is a Claude Code folder you already use, connect it instead: talos-app adopt --agent-dir $AGENT_DIR (docs/desktop.md)."
  else say "   exists and is empty"; fi
else say "   does not exist yet"; fi

# An existing agent that points at ANOTHER clone of this repo is not silently moved to this one. Fails closed: if either
# file is there but cannot be read or understood, that counts as "unknown" and is refused too, unless --repoint is given.
if [ "$ALREADY" = 1 ] && [ "$REPOINT" != 1 ]; then
  OTHER="$(AGENT_DIR="$AGENT_DIR" REPO="$REPO" python3 - <<'PYEOF' || echo "check: the clone check itself crashed"
import json, os
agent, repo = os.environ["AGENT_DIR"], os.environ["REPO"]
real = os.path.realpath
mine = real(os.path.join(repo, "apps", "bridge"))
out = []
# .mcp.json: the talos-app server --cwd argument. No file, or no talos-app entry, means nothing points anywhere yet.
f = os.path.join(agent, ".mcp.json")
if os.path.lexists(f):
    try:
        entry = json.load(open(f))["mcpServers"].get("talos-app")
        if entry is not None:
            a = entry["args"]
            if not isinstance(a, list):
                raise ValueError("args is not a list")
            conf = [x for x in a if isinstance(x, str) and x.startswith("--config=")]
            if conf:
                cwd = os.path.dirname(conf[0][len("--config="):])
            else:
                i = a.index("--cwd")
                cwd = a[i + 1]
            if not isinstance(cwd, str) or not cwd:
                raise ValueError("the entry names no clone folder")
            if real(cwd) != mine:
                out.append(".mcp.json: " + cwd)
    except Exception as e:
        out.append(".mcp.json: cannot tell which clone it points at (" + type(e).__name__ + ")")
# start-talos.sh: the "# talos-clone: <path>" comment this installer writes. A launch script that is not ours is not checked.
f = os.path.join(agent, "start-talos.sh")
if os.path.lexists(f):
    try:
        text = open(f).read()
        if "Written by the Talos install.sh." in text:
            lines = [l[len("# talos-clone: "):] for l in text.split("\n") if l.startswith("# talos-clone: ")]
            if len(lines) != 1 or not lines[0]:
                raise ValueError("no single talos-clone line")
            if real(lines[0]) != real(repo):
                out.append("start-talos.sh: " + lines[0])
    except Exception as e:
        out.append("start-talos.sh: cannot tell which clone it points at (" + type(e).__name__ + ")")
for l in out:
    print(l)
PYEOF
)"
  if [ -n "$OTHER" ]; then
    printf '%s\n' "$OTHER" >&2
    fail 1 "this agent is set up from a different clone of the repo, or this installer cannot tell which (listed above). This clone is $REPO. Nothing was changed. To point the agent at this clone, run ./install.sh --repoint; otherwise run the install.sh in the clone it points at."
  fi
fi

# ---------------------------------------------------------------- 2b. a kit 1.x agent with no .talos-version
# Carried onto this kit with the tools that already exist for it: kit/scripts/upgrade.sh (the kit code, after a full backup,
# with its own check that no protected file moved, and its gate; it stamps .talos-version), kit/scripts/settings-merge.py (adds
# missing hook registrations to .claude/settings.json, after its own backup), and talos-app adopt (the talos-app server in
# .mcp.json, and the MCP-apps hooks in .claude/settings.local.json when a catalog exists).
# Everything that can be checked is checked before anything is written: the folder's place (the kit's Desktop, Documents,
# Downloads and synced-folder rules), links on any path a step writes, upgrade.sh's own dry run, settings-merge.py's dry run (it
# fails on a settings.json that is not valid JSON) and .mcp.json. upgrade.sh runs first so its backup holds the folder as it
# was; .mcp.json and .claude/settings.json are then added to its receipt before they are written, so its --rollback puts them
# back too. .talos-carry marks the carry as under way from before the first write to after the last (v1_unfinished above).
# The gate (the kit's self-test in the upgraded folder, as upgrade.sh would run it) is run by this installer, after upgrade.sh
# --no-gate, so its result is recorded in .talos-carry: a carry is not done until it passes, and a run that finds a carry whose
# gate did not pass runs it again before anything else.
# Without --apply this prints each tool's own plan and changes nothing. Test hooks (not for normal use): TALOS_INSTALL_GATE_CMD is
# run in the folder instead of the self-test (the output says so); TALOS_INSTALL_MEMSEARCH_CMD instead of setup.sh.
if [ "$V1" = 1 ]; then
  step "2b/7 Carry this kit 1.x agent onto this kit"
  # no .pyc files in the clone's kit/: upgrade.sh would copy them into the agent as kit files
  export PYTHONDONTWRITEBYTECODE=1
  Q_AGENT="$(printf '%q' "$AGENT_DIR")"
  # the kit's own refusals of where an agent folder lives (kit/install.sh), with the same flags to override them
  ALLOW_SYNCED=0; ALLOW_PROTECTED=0
  for _f in ${KIT_ARGS[@]+"${KIT_ARGS[@]}"}; do
    case "$_f" in --allow-synced-folder) ALLOW_SYNCED=1 ;; --allow-protected-folder) ALLOW_PROTECTED=1 ;; esac
  done
  for _a in "$AGENT_DIR" "$AGENT_PHYS"; do
    case "$_a" in *CloudStorage*|*"Google Drive"*|*OneDrive*|*Dropbox*|*"Mobile Documents"*)
      [ "$ALLOW_SYNCED" = 1 ] || fail 1 "$AGENT_DIR looks like cloud-synced storage. A sync client mid-upgrade can bring old files back, and two processes editing memory/ mid-sync corrupt it. Move the folder to a plain folder in your home (mv $Q_AGENT ~/agent), or pass --allow-synced-folder if you know why. Nothing was changed." ;;
    esac
    # without letter case on a Mac, as its file system compares names (_fold, as the clone check above)
    case "$(_fold "$_a")" in "$(_fold "$HOME/Desktop")"/*|"$(_fold "$HOME/Documents")"/*|"$(_fold "$HOME/Downloads")"/*)
      [ "$ALLOW_PROTECTED" = 1 ] || fail 1 "$AGENT_DIR is inside Desktop, Documents or Downloads. macOS asks for access to those after every Claude Code update, and until you click Allow, background runs are silently blocked. Move it first (mv $Q_AGENT ~/agent, then --agent-dir ~/agent), or pass --allow-protected-folder. Nothing was changed." ;;
    esac
  done
  # Links: a step writes through a link to wherever it points (outside the folder), and upgrade.sh's rollback cannot undo that.
  LINKS=()
  add_link() { local x; for x in ${LINKS[@]+"${LINKS[@]}"}; do [ "$x" = "$1" ] && return 0; done; LINKS+=("$1"); }
  check_path() { # every part of a relative path, from the top; a link anywhere on it is recorded
    local pre="" part rest="$1"
    while [ -n "$rest" ]; do
      part="${rest%%/*}"
      if [ "$part" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
      pre="${pre:+$pre/}$part"
      if [ -L "$AGENT_DIR/$pre" ]; then add_link "$pre"; return 0; fi
      [ -e "$AGENT_DIR/$pre" ] || return 0
    done
  }
  link_refusal() {
    local l msg="these are links, and a step here would write through them to files outside the folder (a rollback could not put those back):"
    for l in "${LINKS[@]}"; do msg="$msg $l -> $(readlink "$AGENT_DIR/$l" 2>/dev/null || echo '?');"; done
    fail 1 "$msg Replace each link with the file or folder itself (or delete a link that leads nowhere), then run this again. Nothing was changed."
  }
  for _p in .talos-version .talos-carry hooks scripts .mcp.json .claude/settings.json .claude/settings.local.json; do check_path "$_p"; done
  [ ${#LINKS[@]} -eq 0 ] || link_refusal
  UPGRADE=(env TALOS_HOOKS_MERGE_NEXT=1 bash "$KIT/scripts/upgrade.sh" --into "$AGENT_DIR")
  # The gate: what upgrade.sh runs after it writes (scripts/self-test.sh in the upgraded folder, tested against the new kit).
  run_gate() {
    local log rc=0
    printf '\n== the gate: the kit self-test in the upgraded folder (a few minutes)\n'
    log="$(mktemp)" || fail 1 "mktemp failed, so the gate could not run."
    if [ -n "${TALOS_INSTALL_GATE_CMD:-}" ]; then
      say "   the test hook TALOS_INSTALL_GATE_CMD runs instead of scripts/self-test.sh (not for normal use)"
      (cd "$AGENT_DIR" && bash -c "$TALOS_INSTALL_GATE_CMD") >"$log" 2>&1 || rc=$?
    else
      (cd "$AGENT_DIR" && TALOS_SELF_TEST_SUITES=run TALOS_PLACEHOLDER_SRC="$KIT/CLAUDE.md" bash scripts/self-test.sh) >"$log" 2>&1 || rc=$?
    fi
    sed $'s/\x1b\\[[0-9;]*m//g' "$log" | grep -E 'FAIL|ALL .* CHECKS PASSED|passed,' | sed 's/^/   /' || true
    # each FAIL line's kit script, whatever the wording, or "-" when it names none (her folder, this Mac): whose problem it is
    GATE_FAILS="$(sed $'s/\x1b\\[[0-9;]*m//g' "$log" | grep -E '^[[:space:]]*FAIL[[:space:]]' | sed -E -e 's/.*(scripts\/[A-Za-z0-9._-]+\.sh).*/\1/' -e t -e 's/.*/-/' | sort -u || true)"
    rm -f "$log"
    return "$rc"
  }
  UP_OUT=""; WRITES=""
  if [ "$V1_FINISH" != 1 ]; then
    UP_OUT="$("${UPGRADE[@]}" --dry-run 2>&1)" || { printf '%s\n' "$UP_OUT" | sed 's/^/      /' >&2; fail 1 "kit/scripts/upgrade.sh refused this folder in its dry run (its output is above). Nothing was changed."; }
    # every file its plan would write (NEW +, UPDATED ~), part by part
    WRITES="$(printf '%s\n' "$UP_OUT" | sed $'s/\x1b\\[[0-9;]*m//g' | sed -n 's/^[[:space:]]*[+~] \(.*\)$/\1/p')"
    while IFS= read -r _w; do if [ -n "$_w" ]; then check_path "$_w"; fi; done <<< "$WRITES"
    [ ${#LINKS[@]} -eq 0 ] || link_refusal
  fi
  MG_OUT="$("${MERGE[@]}" 2>&1)" || { printf '%s\n' "$MG_OUT" | sed 's/^/      /' >&2; fail 1 "kit/scripts/settings-merge.py cannot merge into this folder's .claude/settings.json (its line is above). Fix that file first. Nothing was changed."; }
  # settings-merge.py looks at the folder as it is now, before the upgrade: a hook script the upgrade is about to add is not
  # stale, so that line is left out of the plan (a registered script that is really gone still shows)
  MG_SHOW="$MG_OUT"
  while IFS= read -r _w; do
    case "$_w" in hooks/*) MG_SHOW="$(printf '%s\n' "$MG_SHOW" | grep -vF "  STALE: ${_w#hooks/} on " || true)" ;; esac
  done <<< "$WRITES"
  ADOPT=(adopt --agent-dir "$AGENT_DIR"); RP=""
  if [ "$REPOINT" = 1 ]; then ADOPT+=(--repoint); RP=" --repoint"; fi
  ADOPT_TYPED="bun --no-env-file run $(printf '%q' "$REPO/apps/bridge/src/cli.ts") adopt --agent-dir $Q_AGENT$RP"
  TTY=0; { [ -t 0 ] && [ -t 1 ]; } && TTY=1
  # adopt is this clone's own CLI, so it needs the clone's JS dependencies (step 3 installs them on a normal run). With --apply
  # they are installed first, into this clone only, so adopt's own checks run before anything in the folder is written.
  DEPS=0; { [ -f "$REPO/node_modules/.modules.yaml" ] && [ -d "$REPO/apps/bridge/node_modules" ]; } && DEPS=1
  if [ "$APPLY" = 1 ]; then  # every --apply, a rerun too (KIT-8: a pulled fix must not run adopt on old packages)
    CURRENT="2b/7 dependencies of this clone"
    js_install || fail 1 "$JS_INSTALL_WORDS failed in $REPO. Nothing in $AGENT_DIR was changed."
    did "installed dependencies"; DEPS=1
  fi
  # adopt's own refusals (another clone's talos-app server, an mcpServers that is not an object, a catalog that does not parse,
  # a folder it cannot write), from its dry run, which writes nothing and runs without a terminal
  AD_OUT=""
  if [ "$DEPS" = 1 ]; then
    # (bun's transpiler cache off: a plan writes nothing, in the home folder either)
    AD_OUT="$(BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "${CLI[@]}" "${ADOPT[@]}" --dry-run 2>&1)" || { printf '%s\n' "$AD_OUT" | sed 's/^/      /' >&2; fail 1 "talos-app adopt would refuse this folder (its line is above), so nothing was done. Fix what it names${RP:-, or pass --repoint if it names another clone and this is the clone to use}, then run this again. Nothing was changed."; }
  fi
  if [ -e "$AGENT_DIR/.mcp.json" ]; then
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d, dict)' "$AGENT_DIR/.mcp.json" 2>/dev/null \
      || fail 1 "$AGENT_DIR/.mcp.json is not a JSON object, so talos-app adopt could not add the talos-app server to it. Fix that file first. Nothing was changed."
  fi
  say "   Never written by any step: CLAUDE.md, memory/, wiki/, .learnings/, .env, and .claude/settings.json beyond the hook"
  say "   entries settings-merge lists. Nothing is deleted."
  if [ "$APPLY" != 1 ]; then
    if [ "$V1_FINISH" = 1 ] && [ "$(carry_get gate)" != passed ]; then
      say ""
      say "   the gate runs again first: the earlier run did not pass it (the kit self-test in the upgraded folder)"
    fi
    if [ "$V1_FINISH" != 1 ]; then
      say ""
      say "   a) the kit code: kit/scripts/upgrade.sh --dry-run (this installer then runs the gate itself and records it)"
      printf '%s\n' "$UP_OUT" | sed 's/^/      /'
    fi
    say ""
    say "   b) the hook registrations in .claude/settings.json: kit/scripts/settings-merge.py (dry run)"
    printf '%s\n' "$MG_SHOW" | sed 's/^/      /'
    say ""
    say "   c) connect the folder: talos-app adopt (the talos-app server in .mcp.json; other servers are kept)"
    if [ "$DEPS" != 1 ]; then say "      not checked yet: this clone has no node_modules (--apply installs them first and checks it then): $ADOPT_TYPED"
    else
      printf '%s\n' "$AD_OUT" | sed 's/^/      /'
      [ "$TTY" = 1 ] || say "      (with --apply it runs only when you type it in Terminal; from here it is printed for you: $ADOPT_TYPED)"
    fi
    carry_memsearch_step; printf '\n== Plan only\n'
    say "Nothing was changed. To do it (upgrade.sh takes a full backup first, and .mcp.json and settings.json go into it):"
    say "  ./install.sh --agent-dir $Q_AGENT --apply"
    exit 0
  fi
  if [ "$YES" != 1 ]; then
    if [ "$TTY" = 1 ]; then
      printf '\nCarry %s onto this kit (a full backup is taken first)? [y/N] ' "$AGENT_DIR"
      read -r reply || reply=n
      case "$reply" in y|Y|yes|YES) ;; *) echo "Stopped. Nothing was changed."; exit 1 ;; esac
    else
      echo "There is no terminal to ask on, so this will not go ahead silently. Run ./install.sh --agent-dir $Q_AGENT --apply --yes to confirm. Nothing was changed." >&2
      exit 2
    fi
  fi
  ADOPT_LEFT=0
  BACKUP=""
  if [ "$V1_FINISH" != 1 ]; then
    # first write: the carry is under way until this file is removed at the end
    printf 'started=%s\nkit=%s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$KIT" > "$CARRY_FILE" || fail 1 "could not write $CARRY_FILE. Nothing was changed."
    CURRENT="2b/7 a) kit/scripts/upgrade.sh"
    BACKUP="$(dirname "$AGENT_DIR")/$(basename "$AGENT_DIR")-backup-$(date +%Y%m%d-%H%M%S)"
    say "   upgrade.sh runs with --no-gate: this installer runs the same gate right after it and records the result."
    "${UPGRADE[@]}" --no-gate --backup-dir "$BACKUP" || fail 1 "kit/scripts/upgrade.sh stopped (its output is above, with the backup folder and the rollback command). Fix what it names, then run ./install.sh --agent-dir $Q_AGENT --apply again."
    did "upgraded the kit code in $AGENT_DIR (backup: $BACKUP)"
    printf 'backup=%s\n' "$BACKUP" >> "$CARRY_FILE"
    # the two files the next steps write go into the same backup's receipt, so upgrade.sh --rollback restores them as well
    { for _f in .mcp.json .claude/settings.json; do
        if [ -f "$BACKUP/tree/$_f" ]; then printf 'UPDATED\t%s\n' "$_f"; else printf 'NEW\t%s\n' "$_f"; fi
      done; } >> "$BACKUP/_upgrade-receipt.txt" \
      || fail 1 "could not add .mcp.json and settings.json to the receipt in $BACKUP, so neither was written. Run ./install.sh --agent-dir $Q_AGENT --apply again: it finishes from here."
    printf 'receipt=done\n' >> "$CARRY_FILE"
  else
    # finishing an earlier carry: its backup is the one to restore from, and .mcp.json and settings.json go into its receipt
    # now if that earlier run stopped before it got there
    BACKUP="$(carry_get backup)"
    [ -n "$BACKUP" ] && [ -d "$BACKUP" ] || BACKUP=""
    if [ -n "$BACKUP" ] && [ "$(carry_get receipt)" != done ]; then
      { for _f in .mcp.json .claude/settings.json; do
          if [ -f "$BACKUP/tree/$_f" ]; then printf 'UPDATED\t%s\n' "$_f"; else printf 'NEW\t%s\n' "$_f"; fi
        done; } >> "$BACKUP/_upgrade-receipt.txt" || fail 1 "could not add .mcp.json and settings.json to the receipt in $BACKUP."
      printf 'receipt=done\n' >> "$CARRY_FILE"
    elif [ -z "$BACKUP" ] && [ -e "$AGENT_DIR/.mcp.json" ]; then
      # no backup to put it in: .mcp.json is kept beside itself before adopt writes it
      cp -p "$AGENT_DIR/.mcp.json" "$AGENT_DIR/.mcp.json.bak-$(date +%Y%m%d-%H%M%S)" || fail 1 "could not back up $AGENT_DIR/.mcp.json."
    fi
  fi
  if [ "$(carry_get gate)" != passed ]; then
    CURRENT="2b/7 the gate"
    if ! run_gate; then
      # The kit's problem only when every FAIL line names a kit test whose copy in the folder is the kit's own, byte for byte.
      WHOSE="it may be this Mac's tools or something in your folder"; NEXT="fix what the FAIL lines name"; KITS=1
      for f in ${GATE_FAILS:--}; do [ "$f" != - ] && cmp -s "$KIT/$f" "$AGENT_DIR/$f" 2>/dev/null || KITS=0; done
      [ "$KITS" = 1 ] && WHOSE="the failing tests are the kit's own ($(printf '%s' "$GATE_FAILS" | tr '\n' ' ' | sed 's/ $//')), unchanged in your folder: a problem in this kit or this Mac's tools, not in your notes" \
        && NEXT="update the kit: git -C $(printf '%q' "$REPO") pull (if that brings nothing new, the fix is not out yet: report the FAIL lines and wait)"
      fail 1 "THE GATE FAILED (the FAIL lines are above): $WHOSE. The carry is not done and nothing after the upgrade was written. What to do: 1) roll back: bash $(printf '%q' "$KIT/scripts/upgrade.sh") --rollback $(printf '%q' "${BACKUP:-<the backup folder upgrade.sh printed>}") --into $Q_AGENT; 2) $NEXT; 3) run ./install.sh --agent-dir $Q_AGENT --apply again. Without the rollback a new run tests the same copies in your folder, so a fixed kit does not reach them."
    fi
    printf 'gate=passed\n' >> "$CARRY_FILE"
    did "the gate passed (the kit self-test in $AGENT_DIR)"
  fi
  CURRENT="2b/7 b) kit/scripts/settings-merge.py --apply"
  UNDO=""; [ -z "$BACKUP" ] || UNDO=" To go back instead: bash $(printf '%q' "$KIT/scripts/upgrade.sh") --rollback $(printf '%q' "$BACKUP") --into $Q_AGENT"
  "${MERGE[@]}" --apply || fail 1 "kit/scripts/settings-merge.py --apply failed (its output is above). Run ./install.sh --agent-dir $Q_AGENT --apply again: it finishes the merge.$UNDO"
  did "merged the new hook registrations into $AGENT_DIR/.claude/settings.json"
  CURRENT="2b/7 c) talos-app adopt"
  if [ "$TTY" = 1 ]; then
    "${CLI[@]}" "${ADOPT[@]}" --yes || fail 1 "talos-app adopt failed (its line is above)."
    did "connected $AGENT_DIR (talos-app adopt)"
  else
    ADOPT_LEFT=1
    say "   c) left for you: adopt runs only when you type it in Terminal. Run: $ADOPT_TYPED"
  fi
  # last write: the carry is done
  rm -f "$CARRY_FILE" || fail 1 "everything is done, but $CARRY_FILE could not be removed; delete it, or the next run tries to finish again."
  printf '\n== Carried onto this kit\n'
  say "Done: $(IFS=';'; echo "${DONE[*]}")"
  [ -z "$BACKUP" ] || say "Undo all of it: bash $(printf '%q' "$KIT/scripts/upgrade.sh") --rollback $(printf '%q' "$BACKUP") --into $Q_AGENT"
  [ "$ADOPT_LEFT" = 0 ] || say "Still to do, typed by you in Terminal: $ADOPT_TYPED"
  carry_memsearch_step   # the carry is done and its summary printed: a slow or failed search changes neither
  say "Next: ./install.sh --agent-dir $Q_AGENT   (it now finds a Talos agent and adds the launch script, the MCP server and the Mac app)"; exit 0
fi
[ "$APPLY" = 1 ] && say "   note: --apply only does something for a kit 1.x folder with no .talos-version; this one is not, so it is ignored."

if [ "$DRY" != 1 ] && [ "$YES" != 1 ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\nInstall Talos into %s? [y/N] ' "$AGENT_DIR"
    read -r reply || reply=n
    case "$reply" in y|Y|yes|YES) ;; *) echo "Stopped. Nothing was changed."; exit 1 ;; esac
  else
    echo "There is no terminal to ask on, so this will not go ahead silently. Run ./install.sh --yes to confirm, or --dry-run to preview. Nothing was changed." >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------- 3. dependencies of this clone
step "3/7 Dependencies of this clone"
# every run, a rerun too: after a `git pull` the lockfile may name new packages, and a fix must not run on the old ones (when
# nothing changed pnpm says so in a second). A moved pnpm store makes pnpm rebuild this clone's node_modules, terminal or not.
if [ "$DRY" = 1 ]; then plan "$JS_INSTALL_WORDS in $REPO"
else
  js_install || fail 1 "$JS_INSTALL_WORDS failed in $REPO."
  say "   dependencies are as the lockfile says ($JS_INSTALL_WORDS)"
fi

# ---------------------------------------------------------------- 4. the kit
step "4/7 The agent (kit, default CLAUDE.md, first commit)"
KARGS=(--agent-dir "$AGENT_DIR") # for kit/install.sh: everything else you passed goes through unchanged
# Whose Chronos is on this Mac decides what the kit may do to it: a Chronos that is not Talos's own is never taken over (kit/scripts/install-chronos-scope.sh)
. "$REPO/kit/scripts/install-chronos-scope.sh"; chronos_scope
KARGS+=(${KIT_ARGS[@]+"${KIT_ARGS[@]}"}); memsearch_default
DRYARGS=(--dry-run); [ -e "$PARENT" ] || DRYARGS+=(--parent-will-exist)   # a plan of an install that would create the parent first
if [ "$ALREADY" = 1 ]; then
  # An agent that exists is left alone, unless you asked for something the first install can still add later:
  # Chronos, or one of the kit's opt-in extras. That runs the kit installer in its add-only mode (no copy, no overwrite).
  if [ "$CHRONOS_ADD" = 1 ] || [ "${KIT_OTHER:-0}" = 1 ] || [ -n "$VAULT_RAW" ] || [ ${#KIT_CHRONOS_ONLY[@]} -gt 0 ]; then
    KARGS+=(--add-to-existing)
    if [ "$DRY" = 1 ]; then
      plan "bash kit/install.sh ${KARGS[*]} --dry-run   (adds only what you asked for to the existing agent: no copy, CLAUDE.md untouched)"
      # Run the kit's own dry run so its refusals (a bad --notify, a vault that is not empty) fail this dry run too.
      bash "$KIT/install.sh" "${KARGS[@]}" "${DRYARGS[@]}" || fail 1 "the kit refused this combination in its dry run (its message is above). Nothing was changed."
    else
      bash "$KIT/install.sh" "${KARGS[@]}" || fail 1 "kit/install.sh --add-to-existing failed (its output is above). It does not copy or overwrite anything in the agent folder; fix the problem and run ./install.sh again with the same flags."
      did "added to the existing agent: ${KIT_ARGS[*]-} $([ "$CHRONOS_ADD" = 1 ] && echo 'Chronos')"
    fi
  else skip "the kit is installed in $AGENT_DIR"; fi
elif [ "$UNFINISHED" = 1 ]; then
  # the agent's own scripts (its scripts/ link into the release): without them it cannot be finished, only installed again
  RENDER="$AGENT_DIR/scripts/render-default.py"
  [ -f "$RENDER" ] && [ -f "$AGENT_DIR/scripts/verify-install.sh" ] \
    || fail 1 "$AGENT_DIR is an unfinished install whose scripts/ link into the Talos release is missing or broken. Move it aside (for example: mv $AGENT_DIR $AGENT_DIR.partial) and run ./install.sh again."
  if [ "$DRY" = 1 ]; then plan "python3 $RENDER --into $AGENT_DIR   (finishes the earlier install)"
  else
    python3 "$RENDER" --into "$AGENT_DIR" >/dev/null \
      || fail 1 "could not render the default CLAUDE.md in $AGENT_DIR (the earlier install stopped there too). Fix the problem and run ./install.sh again."
    # the kit stamps the migration marker after .talos-version: an install stopped in between records it now (migrations are
    # idempotent, so a marker written late is safe)
    if ! grep -q '^migration=' "$AGENT_DIR/.talos-version" 2>/dev/null; then
      # the version the kit stamped stays: `current` may have moved since
      _ver="$(sed -n 's/^version=//p' "$AGENT_DIR/.talos-version" | head -1)"
      python3 "$AGENT_DIR/scripts/talos-migrate.py" mark --agent "$AGENT_DIR" ${_ver:+--version "$_ver"} || fail 1 "could not record the migration marker in $AGENT_DIR/.talos-version."
    fi
    did "rendered the default CLAUDE.md and the memory files the earlier install did not"
  fi
  # what was asked for this run (Chronos, the kit's extras) is added the way it would be to any existing agent
  if [ "$CHRONOS_ADD" = 1 ] || [ "${KIT_OTHER:-0}" = 1 ] || [ -n "$VAULT_RAW" ] || [ ${#KIT_CHRONOS_ONLY[@]} -gt 0 ]; then
    KARGS+=(--add-to-existing)
    if [ "$DRY" = 1 ]; then
      plan "bash kit/install.sh ${KARGS[*]}   (adds what you asked for)"
      bash "$KIT/install.sh" "${KARGS[@]}" "${DRYARGS[@]}" || fail 1 "the kit refused this combination in its dry run (its message is above). Nothing was changed."
    else
      bash "$KIT/install.sh" "${KARGS[@]}" || fail 1 "kit/install.sh --add-to-existing failed (its output is above). Fix the problem and run ./install.sh again with the same flags."
      did "added to the agent: ${KIT_ARGS[*]-} $([ "$CHRONOS_ADD" = 1 ] && echo 'Chronos')"
    fi
  fi
elif [ "$DRY" = 1 ]; then
  plan "bash kit/install.sh ${KARGS[*]}   (builds the Talos plugin release under ~/.local/share/talos/kit, copies the data and docs, renders the default CLAUDE.md)"
  bash "$KIT/install.sh" "${KARGS[@]}" "${DRYARGS[@]}" || fail 1 "the kit refused this combination in its dry run (its message is above). Nothing was changed."
else
  mkdir -p "$PARENT" || fail 1 "could not create $PARENT."
  if ! bash "$KIT/install.sh" "${KARGS[@]}"; then
    if [ -n "$(ls -A "$AGENT_DIR" 2>/dev/null || true)" ]; then
      did "started copying the kit into $AGENT_DIR (it holds a partial copy)"
      fail 1 "The kit copy stopped part-way. $AGENT_DIR now holds a partial copy. Move it aside (for example: mv $AGENT_DIR $AGENT_DIR.partial) and run ./install.sh again."
    fi
    fail 1 "the kit installer failed before copying anything (its output is above). Fix that, then run ./install.sh again."
  fi
  did "installed the kit into $AGENT_DIR"
fi
HAS_COMMIT=0
if [ "$DRY" != 1 ] && [ -d "$AGENT_DIR/.git" ] && git -C "$AGENT_DIR" rev-parse --verify -q HEAD >/dev/null 2>&1; then HAS_COMMIT=1; fi
# The day-zero commit made over the placeholder (an install that stopped before the render): once the files are rendered they
# are committed, on this run or, if this one stopped before here, on the next.
RECOMMIT=0
# Only over the installer's own commit: HEAD is still "day zero", never a commit the owner made.
if [ "$HAS_COMMIT" = 1 ] && [ "$(git -C "$AGENT_DIR" log -1 --format=%s 2>/dev/null)" = "day zero" ] \
  && git -C "$AGENT_DIR" show HEAD:CLAUDE.md 2>/dev/null | cmp -s - "$KIT/CLAUDE.md" \
  && ! cmp -s "$AGENT_DIR/CLAUDE.md" "$KIT/CLAUDE.md"; then RECOMMIT=1; fi
if [ "$RECOMMIT" = 1 ]; then
  GIT_ID=()
  [ -n "$(git -C "$AGENT_DIR" config user.name 2>/dev/null)" ] || GIT_ID+=(-c user.name=Talos)
  [ -n "$(git -C "$AGENT_DIR" config user.email 2>/dev/null)" ] || GIT_ID+=(-c user.email=talos@example.com)
  ( cd "$AGENT_DIR" && git add memory wiki .claude CLAUDE.md && { git diff --cached --quiet || git ${GIT_ID[@]+"${GIT_ID[@]}"} commit -qm "day zero: the default CLAUDE.md and memory files"; } ) \
    || fail 1 "committing the rendered CLAUDE.md failed in $AGENT_DIR. Fix git, then commit them yourself (git add -A && git commit)."
  did "committed the rendered CLAUDE.md and memory files in $AGENT_DIR"
elif [ "$HAS_COMMIT" = 1 ]; then skip "git repository with a first commit in the agent folder"
elif [ "$DRY" = 1 ]; then plan "git init + a first commit in $AGENT_DIR (the kit's verify-install asks for it)"
else
  if [ ! -d "$AGENT_DIR/.git" ]; then
    ( cd "$AGENT_DIR" && git init -q ) || fail 1 "git init failed in $AGENT_DIR."
    did "ran git init in $AGENT_DIR"
  fi
  # asked where the commit is made: an identity set only for another repository (repo-local, includeIf) is none here
  GIT_ID=()
  [ -n "$(git -C "$AGENT_DIR" config user.name 2>/dev/null)" ] || GIT_ID+=(-c user.name=Talos)
  [ -n "$(git -C "$AGENT_DIR" config user.email 2>/dev/null)" ] || GIT_ID+=(-c user.email=talos@example.com)
  ( cd "$AGENT_DIR" && git add memory wiki .claude CLAUDE.md && git ${GIT_ID[@]+"${GIT_ID[@]}"} commit -qm "day zero" ) \
    || fail 1 "the first commit failed in $AGENT_DIR (git init had already run there; the folder has no commits yet). Fix git, then run ./install.sh again: it retries the commit."
  did "first git commit in $AGENT_DIR"
fi
# A fresh install must pass verify-install. An agent that existed before this run may have been tuned by its owner
# (a rewritten CLAUDE.md, an edited hook): its failures are reported as warnings and do not stop the install.
if [ "$DRY" = 1 ]; then plan "bash $AGENT_DIR/scripts/verify-install.sh$([ "$ALREADY" = 1 ] && echo '   (warnings only: the agent already existed)')"
else
  VLOG="$(mktemp)" || fail 1 "mktemp failed, so verify-install.sh could not be run."
  if ! bash "$AGENT_DIR/scripts/verify-install.sh" >"$VLOG" 2>&1; then
    if [ "$ALREADY" = 1 ]; then
      VNOTES="$(sed $'s/\x1b\\[[0-9;]*m//g' "$VLOG" | sed -n 's/^[[:space:]]*FAIL[[:space:]][[:space:]]*/note: /p')"
      VNOTES="${VNOTES:-note: verify-install.sh did not pass and named no check}"; VERIFY_WARNED="$(printf '%s\n' "$VNOTES" | grep -c . || true)"
      { printf '   %s about your own files, not part of the install (the kit'"'"'s verify-install.sh; this agent existed before, so they are yours to tidy when you like):\n' \
          "$([ "$VERIFY_WARNED" = 1 ] && echo "1 note" || echo "$VERIFY_WARNED notes")"
        printf '%s\n' "$VNOTES" | sed 's/^/     /'
        echo "     the detail: bash $AGENT_DIR/scripts/verify-install.sh"; } >&2
    else
      sed $'s/\x1b\\[[0-9;]*m//g' "$VLOG" | grep FAIL >&2 || true; rm -f "$VLOG"
      fail 1 "the kit's verify-install.sh reports problems in $AGENT_DIR."
    fi
  else say "   verify-install.sh: all checks pass"; fi
  rm -f "$VLOG"
fi

# ---------------------------------------------------------------- 5. MCP server
step "5/7 The talos-app MCP server for this folder (and the bridge, with --relay-url)"
BRIDGE_HOME="${TALOS_APP_HOME:-$HOME/.config/talos/app}"; [ "${BRIDGE_HOME#/}" != "$BRIDGE_HOME" ] || BRIDGE_HOME="$PWD/$BRIDGE_HOME"
# the agent folder shell-quoted: pasted as printed, a path with a space stays one argument
BRIDGE_CMD="apps/bridge/scripts/install.sh --agent-dir $(printf '%q' "$AGENT_DIR") --relay-url https://<your relay host>"
if [ "$DRY" = 1 ]; then
  plan "talos-app install-mcp --agent-dir $AGENT_DIR   (writes $AGENT_DIR/.mcp.json)"
  if [ -n "$RELAY_URL" ]; then plan "bash apps/bridge/scripts/install.sh --agent-dir $AGENT_DIR --relay-url $RELAY_URL   (creates the bridge key and settings in $BRIDGE_HOME; prints the BRIDGE_PUBKEY= line for Railway)"
  else plan "print the bridge command to run once your relay exists: $BRIDGE_CMD"; fi
else
  OUT="$("${CLI[@]}" install-mcp --agent-dir "$AGENT_DIR" 2>&1)" || { printf '%s\n' "$OUT" >&2; fail 1 "talos-app install-mcp failed."; }
  case "$OUT" in
    "already up to date"*) skip "$OUT" ;;
    *) say "   $OUT"; did "registered the talos-app MCP server" ;;
  esac
  if [ -n "$RELAY_URL" ]; then
    BOUT="$(bash "$REPO/apps/bridge/scripts/install.sh" --agent-dir "$AGENT_DIR" --relay-url "$RELAY_URL" 2>&1)" || { printf '%s\n' "$BOUT" >&2; fail 1 "the bridge installer (apps/bridge/scripts/install.sh) failed."; }
    printf '%s\n' "$BOUT" | sed 's/^/   bridge: /'
    did "set up the bridge for $RELAY_URL"
  elif [ -f "$BRIDGE_HOME/bridge.env" ]; then skip "the bridge is already configured ($BRIDGE_HOME/bridge.env)"
  else
    say "   the bridge is not set up yet: it needs your relay address, so it waits for the Railway step (SETUP.md, step 4)."
    say "   Once the relay exists, run:  $BRIDGE_CMD"
  fi
fi

memory_browser_step
# ---------------------------------------------------------------- 6. launch script with the Talos mod
step "6/7 Launch script (the Talos mod via --plugin-dir)"
LAUNCH="$AGENT_DIR/start-talos.sh"
MARK="# Written by the Talos install.sh."
launch_text() {
  printf '#!/usr/bin/env bash\n%s Re-run ./install.sh to refresh it; delete it any time.\n# talos-clone: %s\n%s\n' "$MARK" "$REPO" '# Starts the agent with the talos-app channel and the Talos mod (--plugin-dir). Extra arguments go to claude.'
  [ "$BRIDGE_HOME" = "$HOME/.config/talos/app" ] || printf 'export TALOS_APP_HOME=%q\n' "$BRIDGE_HOME"
  [ -z "${TALOS_INBOX_ROOT:-}" ] || { IB="$TALOS_INBOX_ROOT"; [ "${IB#/}" != "$IB" ] || IB="$PWD/$IB"; printf 'export TALOS_INBOX_ROOT=%q\n' "$IB"; }
  # exports: this install's homes, for a shell without them; --no-env-file: bun would load the agent's .env (secrets) into claude
  printf 'exec bun --no-env-file run %q start --agent-dir %q -- --plugin-dir %q "$@"\n' "$REPO/apps/bridge/src/cli.ts" "$AGENT_DIR" "$MOD"
}
if [ "$DRY" = 1 ]; then plan "write $LAUNCH: talos-app start --agent-dir $AGENT_DIR -- --plugin-dir $MOD"
elif [ -f "$LAUNCH" ] && [ "$(launch_text)" = "$(cat "$LAUNCH")" ]; then skip "$LAUNCH"
elif [ -f "$LAUNCH" ] && ! grep -qF "$MARK" "$LAUNCH"; then say "   $LAUNCH exists and is not ours; left alone."
else
  if [ -f "$LAUNCH" ]; then  # ours but changed since: keep the old copy before refreshing it
    BAK="$LAUNCH.bak-$(date +%Y%m%d%H%M%S)"
    cp -p "$LAUNCH" "$BAK" || fail 1 "could not back up $LAUNCH before refreshing it."
    say "   kept the previous $LAUNCH as $BAK"
  fi
  launch_text > "$LAUNCH" && chmod +x "$LAUNCH" || fail 1 "could not write $LAUNCH."
  did "wrote $LAUNCH"
  say "   wrote $LAUNCH"
fi

# ---------------------------------------------------------------- 7. Mac app
step "7/7 Mac app"
APP_DEST="$HOME/Applications/Talos.app"
APP_ID="app.talos.desktop"
DESKTOP_JSON="$HOME/Library/Application Support/Talos/desktop.json"
# The mod and channel flags the Mac app has to start claude with (it reads desktop.json, not start-talos.sh).
APP_FLAGS=(--plugin-dir "$MOD" --dangerously-load-development-channels server:talos-app)

# Is a Talos running, and from where? Asked of the system by bundle id; nothing is started or quit.
APP_RUNNING=0; APP_RUNNING_PATH=""
if [ "$WANT_APP" = 1 ] && command -v osascript >/dev/null 2>&1 \
   && [ "$(osascript -e "application id \"$APP_ID\" is running" 2>/dev/null || echo false)" = true ]; then
  APP_RUNNING=1
  if command -v lsappinfo >/dev/null 2>&1; then
    APP_RUNNING_PATH="$(lsappinfo info -only bundlepath -app "$APP_ID" 2>/dev/null | sed -n 's/.*="\(.*\)"$/\1/p' | head -1 || true)"
  fi
  [ -n "$APP_RUNNING_PATH" ] || APP_RUNNING_PATH="(path unknown)"
fi

APP_NOTE=""
if [ "$WANT_APP" != 1 ]; then say "   skipped (--no-app)"
else
  if [ "$APP_RUNNING" = 1 ]; then
    APP_NOTE="Talos is running from $APP_RUNNING_PATH. It was not quit: an update will apply on the next app start."
    say "   $APP_NOTE"
  fi
  if [ -d "$APP_DEST" ]; then skip "$APP_DEST is installed (to update it later run talos-app update, then re-run the two scripts in apps/desktop/scripts)"
  elif [ "$DRY" = 1 ]; then plan "$DESKTOP/build-app.sh --release, then $DESKTOP/install.sh --no-open --no-quit${APP_RELAY_FLAG:+ $APP_RELAY_FLAG} (into ~/Applications)"
  else
    bash "$DESKTOP/build-app.sh" --release || fail 1 "the Mac app build failed (output above)."
    did "built the Mac app"
    # --no-quit always: this script never asks a running Talos to quit.
    # Exit 8: it stopped for the relay (its own line above says which version is where); that is not a broken install.
    APP_RC=0
    bash "$DESKTOP/install.sh" --no-open --no-quit ${APP_RELAY_FLAG:+"$APP_RELAY_FLAG"} || APP_RC=$?
    if [ "$APP_RC" = 8 ]; then
      fail 1 "the Mac app was built but not installed: the relay does not serve this build yet, or couldn't be checked (the line above says which). Run this again later, or pass --no-relay-wait to install anyway."
    elif [ "$APP_RC" != 0 ]; then fail 1 "installing the Mac app failed (output above)."; fi
    did "installed $APP_DEST"
    [ "$APP_RUNNING" = 1 ] && say "   the new build is on disk; it takes effect on the next app start (quit it from its menu when you like)."
  fi

  # desktop.json: the file the app reads to decide which agent to start and with what arguments. Written only when the app is
  # not running (a running app rewrites the file from memory) and the file already exists (a missing file means the app uses
  # its pre-setup values, which a new file holding only these keys would wipe). Otherwise the Settings change is printed.
  if [ "$DRY" = 1 ]; then plan "if Talos is not running and $DESKTOP_JSON exists: merge agent_dir=$AGENT_DIR and ${APP_FLAGS[*]} into it (old file backed up first); otherwise print the Settings change to make by hand"
  else
    DJ_OUT="$(DJ="$DESKTOP_JSON" AGENT_DIR="$AGENT_DIR" MOD="$MOD" REPOINT="$REPOINT" RUNNING="$APP_RUNNING" python3 - <<'PYEOF'
import json, os, shutil, sys, tempfile, time
dj, agent, mod, repoint = os.environ["DJ"], os.environ["AGENT_DIR"], os.environ["MOD"], os.environ["REPOINT"] == "1"
running = os.environ["RUNNING"] == "1"
real = lambda p: os.path.realpath(os.path.expanduser(p))
CH, SRV = "--dangerously-load-development-channels", "server:talos-app"
want = ["--plugin-dir", mod, CH, SRV]
def instructions(why):
    print("MANUAL " + why)
    print("MANUAL In Talos > Settings, set the agent folder to " + agent + " and add these launch arguments:")
    print("MANUAL   --plugin-dir " + mod + " " + CH + " " + SRV)
if running:
    instructions("Talos is running, and a running app overwrites desktop.json from memory, so a file edit now would be lost. desktop.json was not touched.")
    sys.exit(0)
if not os.path.exists(dj):
    instructions(dj + " does not exist yet. A new file holding only these keys would wipe the pre-setup values of the app, so none was created.")
    sys.exit(0)
# A symlinked file is updated through to its target; the link itself is never replaced.
target = os.path.realpath(dj)
try:
    with open(target) as f:
        cfg = json.load(f)
except Exception:
    instructions(dj + " is not valid JSON, so it was left alone.")
    sys.exit(0)
if not isinstance(cfg, dict):
    instructions(dj + " is not a JSON object, so it was left alone.")
    sys.exit(0)
cur = cfg.get("agent_dir")
if cur is not None and not isinstance(cur, str):
    instructions(dj + " has an agent_dir that is not text, so it was left alone.")
    sys.exit(0)
if cur is not None and real(cur) != real(agent):
    instructions(dj + " points the app at a different agent folder (" + cur + "), so it was left alone.")
    sys.exit(0)
args = cfg.get("args", [])
if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
    instructions(dj + " has an args value that is not a list of strings, so it was left alone.")
    sys.exit(0)
new_args = list(args)
# a --plugin-dir for the Talos mod from another clone: replaced only with --repoint, otherwise reported
for i, a in enumerate(new_args):
    if a == "--plugin-dir" and i + 1 < len(new_args) and new_args[i + 1].rstrip("/").endswith("/plugins/talos-app-mod") and real(new_args[i + 1]) != real(mod):
        if repoint:
            new_args[i + 1] = mod
        else:
            instructions(dj + " loads the Talos mod from another clone (" + new_args[i + 1] + "); it was left alone. Re-run with --repoint to move it.")
            sys.exit(0)
has_mod = any(a == "--plugin-dir" and i + 1 < len(new_args) and real(new_args[i + 1]) == real(mod) for i, a in enumerate(new_args)) \
    or any(a.startswith("--plugin-dir=") and real(a.split("=", 1)[1]) == real(mod) for a in new_args)
has_ch = any(a == CH and i + 1 < len(new_args) and new_args[i + 1] == SRV for i, a in enumerate(new_args)) or (CH + "=" + SRV) in new_args
if not has_mod:
    new_args += ["--plugin-dir", mod]
if not has_ch:
    new_args += [CH, SRV]
if cur is None:
    cfg["agent_dir"] = agent
cfg["args"] = new_args
if new_args == args and cur is not None:
    print("SAME")
    sys.exit(0)
stamp = time.strftime("%Y%m%d-%H%M%S")
bak = target + ".bak-" + stamp
n = 0
while os.path.exists(bak):
    n += 1
    bak = target + ".bak-" + stamp + "-" + str(n)
shutil.copy2(target, bak)
print("BACKUP " + bak)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".desktop.json.")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
print("WROTE")
PYEOF
)" || fail 1 "could not update $DESKTOP_JSON (nothing in it was changed unless a backup is listed next to it)."
    DJ_STATE=SAME
    while IFS= read -r line; do
      case "$line" in
        SAME) ;;
        WROTE) DJ_STATE=WROTE ;;
        BACKUP\ *) say "   backed up the old file to ${line#BACKUP }" ;;
        MANUAL\ *) printf '   %s\n' "${line#MANUAL }" ;;
      esac
    done <<EOF
$DJ_OUT
EOF
    case "$DJ_STATE" in
      WROTE) did "set the Mac app to start $AGENT_DIR with the Talos mod and channel (desktop.json)"; say "   updated $DESKTOP_JSON" ;;
      *) case "$DJ_OUT" in *MANUAL*) ;; *) skip "$DESKTOP_JSON" ;; esac ;;
    esac
  fi
fi

# ---------------------------------------------------------------- done
printf '\n== Done\n'
if [ "$DRY" = 1 ]; then say "Dry run finished. Nothing was changed."
elif [ "$CHANGED" = 0 ]; then say "Nothing to change: everything was already set up."
else say "Set up: $(IFS=';'; echo "${DONE[*]}")"; fi
if [ "${VERIFY_WARNED:-0}" -gt 0 ] 2>/dev/null; then say "Also: $([ "$VERIFY_WARNED" = 1 ] && echo "1 note" || echo "$VERIFY_WARNED notes") about your own files (above); the install itself is done."; fi
[ -z "$APP_NOTE" ] || say "$APP_NOTE"
cat <<EOF

What next:
  Start:     $LAUNCH      (the way to start it: it loads the Talos mod and the channel)
EOF
if [ "$WANT_APP" = 1 ]; then
  printf '  Mac app:   open ~/Applications/Talos.app   (the same agent; it keeps it running and can start at login)\n'
  if [ -f "$DESKTOP/make-signing-identity.sh" ] && ! bash "$DESKTOP/make-signing-identity.sh" --status >/dev/null 2>&1; then
    printf '  Optional:  bash %q   (one password prompt; then rebuild the app so macOS privacy grants survive rebuilds)\n' "$DESKTOP/make-signing-identity.sh"
  fi
fi
cat <<EOF
  First run: tell the agent "Read BOOTSTRAP.md and set me up." The interview is optional.
  Phone:     SETUP.md, steps 4 to 7 (relay, bridge, start, pair the phone)$([ -n "$RELAY_URL" ] || printf '; the bridge command comes first: %s' "$BRIDGE_CMD")
  Chronos:   $(chronos_closing_line)
  Update:    bun --no-env-file run $(printf '%q' "$REPO/apps/bridge/src/cli.ts") update   (then SETUP.md, "Updating")
EOF
exit 0
