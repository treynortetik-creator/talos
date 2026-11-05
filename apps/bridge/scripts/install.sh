#!/usr/bin/env bash
# Installs the Talos app bridge for one agent folder. Idempotent: safe to run again.
#
#   apps/bridge/scripts/install.sh --agent-dir <dir> --relay-url <url> [--config default|five-threads] [--home <dir>]
#                                  [--bin-dir <dir>] [--replace-wrapper] [--dry-run]
#
# - creates $TALOS_APP_HOME (default ~/.config/talos/app, mode 0700), the bridge key and config.json (kept if present)
# - merges a `talos-app` server into <dir>/.mcp.json without touching other servers
# - merges the MCP-apps hooks into <dir>/.claude/settings.local.json (local scope; foreign hooks kept) when a catalog exists
# - puts a real `talos-app` command on your PATH (a small wrapper script, not an alias): next to bun, else ~/.bun/bin or
#   ~/.local/bin; --bin-dir picks the folder. If that folder is not on PATH it prints the exact line to add.
#   An existing talos-app wrapper that points at a different TALOS_APP_HOME, or at a different checkout that still exists,
#   is left alone with a warning, so a test or a second checkout cannot silently repoint your real command;
#   --replace-wrapper says you mean it.
# - never touches ~/.claude (user scope would spawn the bridge in every Claude Code session)
set -euo pipefail

AGENT_DIR=""
RELAY_URL=""
CONFIG="default"
HOME_DIR="${TALOS_APP_HOME:-$HOME/.config/talos/app}"
BIN_DIR=""
DRY_RUN=0
REPLACE_WRAPPER=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="${2:-}"; shift 2 ;;
    --relay-url) RELAY_URL="${2:-}"; shift 2 ;;
    --config) CONFIG="${2:-}"; shift 2 ;;
    --home) HOME_DIR="${2:-}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:-}"; shift 2 ;;
    --replace-wrapper) REPLACE_WRAPPER=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$AGENT_DIR" ] || { echo "--agent-dir is required" >&2; usage >&2; exit 2; }
[ -d "$AGENT_DIR" ] || { echo "agent folder does not exist: $AGENT_DIR" >&2; exit 1; }
case "$CONFIG" in default|five-threads) ;; *) echo "--config must be default or five-threads" >&2; exit 2 ;; esac
if [ -z "$RELAY_URL" ] && [ ! -f "$HOME_DIR/bridge.env" ]; then
  echo "--relay-url is required on the first install" >&2
  exit 2
fi
command -v bun >/dev/null 2>&1 || { echo "bun is not installed (need >= 1.3.11): https://bun.sh" >&2; exit 1; }

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(bun run "$BRIDGE_DIR/src/cli.ts")
export TALOS_APP_HOME="$HOME_DIR"
# The account's real home (from the user database), not $HOME: a run with a fake HOME must not pass for the real default.
REAL_HOME="$(eval "printf '%s' ~$(id -un)" 2>/dev/null || true)"
[ -n "$REAL_HOME" ] && [ "${REAL_HOME#\~}" = "$REAL_HOME" ] || REAL_HOME="$HOME"
DEFAULT_HOME="$REAL_HOME/.config/talos/app"
BUN_PATH="$(command -v bun)"
WRAPPER_MARK="# talos-app-wrapper (written by apps/bridge/scripts/install.sh)"

# Trailing slashes do not matter: /x/bin/ on PATH is the same folder as /x/bin.
strip_slash() { local d="$1"; while [ "${#d}" -gt 1 ] && [ "${d%/}" != "$d" ]; do d="${d%/}"; done; printf '%s' "$d"; }
on_path() {
  local want entry rest="$PATH:"
  want="$(strip_slash "$1")"
  while [ -n "$rest" ]; do
    entry="${rest%%:*}"; rest="${rest#*:}"
    [ -n "$entry" ] || continue
    [ "$(strip_slash "$entry")" = "$want" ] && return 0
  done
  return 1
}

# Where the wrapper goes. Sets WRAP_DIR and WRAP_ON_PATH (1 when a new terminal will find it).
# The folder holding bun is best: bun itself runs from there, so it is on PATH wherever the install worked.
pick_bin_dir() {
  WRAP_DIR=""; WRAP_ON_PATH=0
  if [ -n "$BIN_DIR" ]; then
    WRAP_DIR="$BIN_DIR"
    if on_path "$BIN_DIR"; then WRAP_ON_PATH=1; fi
    return
  fi
  local cand
  for cand in "$(dirname "$BUN_PATH")" "$HOME/.bun/bin" "$HOME/.local/bin"; do
    if on_path "$cand" && { [ -d "$cand" ] && [ -w "$cand" ] || { [ ! -e "$cand" ] && [ -w "$(dirname "$cand")" ]; }; }; then
      WRAP_DIR="$cand"; WRAP_ON_PATH=1; return
    fi
  done
  WRAP_DIR="$HOME/.local/bin"
}

shell_profile() {
  case "$(basename "${SHELL:-zsh}")" in
    zsh) echo "$HOME/.zshrc" ;;
    bash) if [ -f "$HOME/.bash_profile" ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
    *) echo "$HOME/.profile" ;;
  esac
}

# POSIX single-quote escape: every ' becomes '\'' (done in bash itself; a sed script here lost its backslash).
shq() {
  local s="$1" out="" sq="'"
  while [ "${s#*"$sq"}" != "$s" ]; do
    out="$out${s%%"$sq"*}'\\''"
    s="${s#*"$sq"}"
  done
  printf "'%s'" "$out$s"
}

# The TALOS_APP_HOME an existing wrapper of ours uses: the pinned folder, or the default when it pins none.
wrapper_home() {
  local line v sq="'" pat
  line="$(grep -F '|| TALOS_APP_HOME=' "$1" 2>/dev/null | head -n 1 || true)"
  if [ -z "$line" ]; then printf '%s' "$DEFAULT_HOME"; return; fi
  v="${line#*|| TALOS_APP_HOME=}"
  v="${v#"$sq"}"; v="${v%"$sq"}"
  pat="$sq\\$sq$sq"
  printf '%s' "${v//"$pat"/$sq}"
}

# The cli.ts an existing wrapper of ours runs.
wrapper_cli() {
  local line v sq="'" pat
  line="$(grep -F 'exec "$BUN"' "$1" 2>/dev/null | head -n 1 || true)"
  [ -n "$line" ] || return 0
  v="${line#*run }"; v="${v%% \"\$@\"*}"
  v="${v#"$sq"}"; v="${v%"$sq"}"
  pat="$sq\\$sq$sq"
  printf '%s' "${v//"$pat"/$sq}"
}

# Writes <dir>/talos-app. Never replaces a file of that name that this script did not write.
# A folder we cannot write to is reported (WRAP_STATE=unwritable) instead of aborting the install: the steps after this
# one (BRIDGE_PUBKEY on Railway) must still be printed.
install_wrapper() {
  local target="$WRAP_DIR/talos-app" tmp="$WRAP_DIR/talos-app.tmp.$$"
  if [ -e "$target" ] && ! grep -q "talos-app-wrapper" "$target" 2>/dev/null; then
    WRAP_STATE="blocked"; return
  fi
  if [ -e "$target" ] && [ "$REPLACE_WRAPPER" != 1 ]; then
    WRAP_OLD_HOME="$(wrapper_home "$target")"
    WRAP_OLD_CLI="$(wrapper_cli "$target")"
    if [ "$WRAP_OLD_HOME" != "$HOME_DIR" ]; then WRAP_STATE="kept"; WRAP_WHY="home"; return; fi
    # same home, another checkout: keep it while that checkout still exists (a deleted one is a broken command: replace it)
    if [ -n "$WRAP_OLD_CLI" ] && [ "$WRAP_OLD_CLI" != "$BRIDGE_DIR/src/cli.ts" ] && [ -e "$WRAP_OLD_CLI" ]; then
      WRAP_STATE="kept"; WRAP_WHY="checkout"; return
    fi
  fi
  if ! mkdir -p "$WRAP_DIR" 2>/dev/null || [ ! -w "$WRAP_DIR" ]; then
    WRAP_STATE="unwritable"; return
  fi
  if ! {
    echo "#!/bin/sh"
    echo "$WRAPPER_MARK"
    echo "BUN=$(shq "$BUN_PATH")"
    echo '[ -x "$BUN" ] || BUN=bun'
    # The bridge folder's own settings come from its config file, never from whichever folder you run this in:
    # bun would otherwise load that folder's .env into the CLI (and into the claude that `start` launches).
    # A custom --home is pinned here so a new terminal reads the same folder the .mcp.json entry uses.
    if [ "$HOME_DIR" != "$DEFAULT_HOME" ]; then
      echo "[ -n \"\${TALOS_APP_HOME:-}\" ] || TALOS_APP_HOME=$(shq "$HOME_DIR")"
      echo "export TALOS_APP_HOME"
    fi
    echo "exec \"\$BUN\" --no-env-file run $(shq "$BRIDGE_DIR/src/cli.ts") \"\$@\""
  } > "$tmp" 2>/dev/null || ! chmod 755 "$tmp" 2>/dev/null || ! mv "$tmp" "$target" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    WRAP_STATE="unwritable"; return
  fi
  WRAP_STATE="written"
}

pick_bin_dir

if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: nothing will be written"
  echo "would create $HOME_DIR (0700), its bridge key and config.json (existing files are kept)"
  [ -z "$RELAY_URL" ] || echo "would set TALOS_APP_RELAY_URL=$RELAY_URL in $HOME_DIR/bridge.env"
  echo "would put a talos-app command in $WRAP_DIR/talos-app$([ "$WRAP_ON_PATH" = 1 ] || echo " (that folder is not on your PATH; the exact line to add would be printed)")"
  "${CLI[@]}" install-mcp --agent-dir "$AGENT_DIR" --dry-run
  "${CLI[@]}" install-app-hooks --agent-dir "$AGENT_DIR" --dry-run
  exit 0
fi

if [ -n "$RELAY_URL" ]; then
  "${CLI[@]}" init --relay-url "$RELAY_URL" --config "$CONFIG"
else
  # relay URL already in bridge.env: init reads it and keeps everything that exists
  "${CLI[@]}" init --config "$CONFIG"
fi
"${CLI[@]}" install-mcp --agent-dir "$AGENT_DIR"
# MCP apps: (re)writes the hook entries for catalogued servers into <dir>/.claude/settings.local.json; a no-op without a catalog
"${CLI[@]}" install-app-hooks --agent-dir "$AGENT_DIR"

install_wrapper
echo
case "$WRAP_STATE" in
  written)
    echo "put a talos-app command at $WRAP_DIR/talos-app"
    if "$WRAP_DIR/talos-app" help >/dev/null 2>&1; then echo "checked: $WRAP_DIR/talos-app runs"; else echo "WARNING: $WRAP_DIR/talos-app did not run; try: bun run $BRIDGE_DIR/src/cli.ts help" >&2; fi
    if [ "$WRAP_ON_PATH" = 1 ]; then
      FOUND="$(command -v talos-app || true)"
      if [ -n "$FOUND" ] && [ "$FOUND" != "$WRAP_DIR/talos-app" ]; then
        echo "NOTE: another talos-app comes first on your PATH: $FOUND"
      fi
    else
      echo "$WRAP_DIR is not on your PATH, so a new terminal will say 'command not found'. Add it once:"
      echo "  echo 'export PATH=\"$WRAP_DIR:\$PATH\"' >> $(shell_profile)"
      echo "then open a new terminal (or run: export PATH=\"$WRAP_DIR:\$PATH\")."
    fi
    ;;
  kept)
    if [ "$WRAP_WHY" = checkout ]; then
      echo "WARNING: $WRAP_DIR/talos-app already runs a different checkout ($WRAP_OLD_CLI), so it was left alone." >&2
    else
      echo "WARNING: $WRAP_DIR/talos-app already points at a different TALOS_APP_HOME ($WRAP_OLD_HOME), so it was left alone." >&2
    fi
    echo "NOT changed: your talos-app command. This install uses $HOME_DIR from $BRIDGE_DIR. To repoint the command here, run this again with --replace-wrapper."
    echo "Run the CLI for this install with: TALOS_APP_HOME=$(shq "$HOME_DIR") bun run $BRIDGE_DIR/src/cli.ts <command>"
    ;;
  unwritable)
    echo "NOT installed: could not write $WRAP_DIR/talos-app (is $WRAP_DIR writable?). Everything else was set up."
    echo "Run the CLI with: TALOS_APP_HOME=$(shq "$HOME_DIR") bun run $BRIDGE_DIR/src/cli.ts <command>   or pass --bin-dir <a folder you can write to> and run this again."
    ;;
  blocked)
    echo "NOT installed: $WRAP_DIR/talos-app already exists and was not written by this script (left alone)."
    echo "Run the CLI with: TALOS_APP_HOME=$(shq "$HOME_DIR") bun run $BRIDGE_DIR/src/cli.ts <command>   or pass --bin-dir <another folder> and run this again."
    ;;
esac

# When the wrapper is not there (blocked or unwritable), the steps below use the long form so they still work.
if [ "$WRAP_STATE" = written ]; then TA="talos-app"; else TA="TALOS_APP_HOME=$(shq "$HOME_DIR") bun run $BRIDGE_DIR/src/cli.ts"; fi
cat <<MSG

Next:
  1. Put the BRIDGE_PUBKEY line above into the relay's environment and press Deploy in Railway.
  2. Start your agent (keep your existing flags after the --):
       $TA start --agent-dir $AGENT_DIR -- <your existing claude flags>
     That runs: TALOS_APP_BRIDGE=1 MCP_PROTOCOL_NEGOTIATION=legacy claude <your flags> --dangerously-load-development-channels server:talos-app
  3. Then run: $TA doctor --agent-dir $AGENT_DIR, and $TA enroll to add your phone.
MSG
