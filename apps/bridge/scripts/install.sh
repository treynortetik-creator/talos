#!/usr/bin/env bash
# Installs the Talos app bridge for one agent folder. Idempotent: safe to run again.
#
#   apps/bridge/scripts/install.sh --agent-dir <dir> --relay-url <url> [--config default|five-threads] [--home <dir>]
#                                  [--bin-dir <dir>] [--replace-wrapper] [--dry-run]
#
# - creates $TALOS_APP_HOME (default ~/.config/talos/app, mode 0700), the bridge key and config.json (kept if present)
# - merges a `talos-app` server into <dir>/.mcp.json without touching other servers
# - merges the MCP-apps hooks into <dir>/.claude/settings.local.json (local scope; foreign hooks kept) when a catalog exists
# - puts a real `talos-app` command on your PATH (a small wrapper script, not an alias), in a folder of YOUR OWN: bun's
#   folder when it is inside your home folder, else ~/.bun/bin or ~/.local/bin (the first one on PATH and writable). Never a
#   machine-wide folder such as /opt/homebrew/bin: another user of this Mac would run your checkout from it. If none is on
#   PATH it uses ~/.local/bin and prints the exact line to add. --bin-dir picks the folder yourself.
#   The wrapper records your user id. Run by another user, it does not run this checkout: it hands over to that user's own
#   talos-app (~/.local/bin or ~/.bun/bin, written by this script), or says so in one line and exits non-zero.
#   After writing, if a new terminal would run a different talos-app (one earlier on PATH), it says which and how to fix it;
#   it never deletes or edits that file.
#   An older unpinned wrapper of yours in a machine-wide folder on PATH (owned by you, writable, with our mark) is pinned in
#   place (nothing else in it changes); --dry-run only reports it. A file of another user is never touched.
#   An existing talos-app wrapper that points at a different TALOS_APP_HOME, at another user, or at a different checkout that
#   still exists, is left alone with a warning, so a test or a second checkout cannot silently repoint your real command;
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
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
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
command -v bun >/dev/null 2>&1 || { echo "bun is not installed: curl -fsSL https://bun.sh/install | bash (Talos needs Bun 1.4.4 or newer)" >&2; exit 1; }

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# too old: the words and the way to upgrade come from src/bun-floor.ts, before anything is written (an empty version, from a
# bun that printed none, makes it check the running bun itself)
bun --no-env-file "$BRIDGE_DIR/src/bun-floor.ts" "$(bun --version 2>/dev/null)" || exit 1
CLI=(bun --no-env-file run "$BRIDGE_DIR/src/cli.ts")
export TALOS_APP_HOME="$HOME_DIR"
# The account's real home (from the user database), not $HOME: a run with a fake HOME must not pass for the real default.
REAL_HOME="$(eval "printf '%s' ~$(id -un)" 2>/dev/null || true)"
[ -n "$REAL_HOME" ] && [ "${REAL_HOME#\~}" = "$REAL_HOME" ] || REAL_HOME="$HOME"
DEFAULT_HOME="$REAL_HOME/.config/talos/app"
BUN_PATH="$(command -v bun)"
# Who is running: /usr/bin/id by absolute path (a PATH folder must not get to say who the user is). TALOS_APP_TEST_ID is
# for tests only: it points at a stub that answers `-u` for a second user.
ID_CMD=/usr/bin/id; [ -x "$ID_CMD" ] || ID_CMD=id
[ -z "${TALOS_APP_TEST_ID:-}" ] || ID_CMD="$TALOS_APP_TEST_ID"
OWNER_UID="$("$ID_CMD" -u)"
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
# Only folders inside the user's own home are chosen by default: a machine-wide folder (Homebrew's /opt/homebrew/bin) is
# shared by every user of the Mac, and a wrapper there would run this user's checkout for all of them.
inside_home() {
  local h d
  h="$(strip_slash "$HOME")"; d="$(strip_slash "$1")"
  [ "$h" != "/" ] || return 1
  case "$d/" in "$h"/*) return 0 ;; esac
  return 1
}
pick_bin_dir() {
  WRAP_DIR=""; WRAP_ON_PATH=0
  if [ -n "$BIN_DIR" ]; then
    WRAP_DIR="$BIN_DIR"
    if on_path "$BIN_DIR"; then WRAP_ON_PATH=1; fi
    return
  fi
  local cand
  for cand in "$(dirname "$BUN_PATH")" "$HOME/.bun/bin" "$HOME/.local/bin"; do
    inside_home "$cand" || continue
    if on_path "$cand" && { [ -d "$cand" ] && [ -w "$cand" ] || { [ ! -e "$cand" ] && [ -w "$(dirname "$cand")" ]; }; }; then
      WRAP_DIR="$cand"; WRAP_ON_PATH=1; return
    fi
  done
  WRAP_DIR="$HOME/.local/bin"
}

# shq only when the text needs it (plain paths print as they are).
shq_if() {
  case "$1" in *[!A-Za-z0-9_./:@%+=,-]*|"") shq "$1" ;; *) printf '%s' "$1" ;; esac
}
# The line that puts a folder first on PATH, as text a shell reads back as exactly that folder.
path_line() {
  local d="$1" bs='\' dq='"' dl='$' bt='`'
  d="${d//"$bs"/"$bs$bs"}"; d="${d//"$dq"/"$bs$dq"}"; d="${d//"$dl"/"$bs$dl"}"; d="${d//"$bt"/"$bs$bt"}"
  printf 'export PATH="%s:$PATH"' "$d"
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

# The user id an existing wrapper of ours is pinned to (empty for one from before the pin existed).
wrapper_uid() {
  local line
  line="$(grep -m1 '^TALOS_APP_OWNER_UID=' "$1" 2>/dev/null || true)"
  printf '%s' "${line#TALOS_APP_OWNER_UID=}"
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

# The lines that pin a wrapper to the installing user (also inserted into an older wrapper by pin_old_wrappers).
# Another user (a second account on this Mac) must never run this checkout through a shared folder: hand over to their
# own wrapper, once (TALOS_APP_HOP stops A -> B -> A), or say so and stop. The owner side clears the mark again, so it
# does not travel into bun or whatever `talos-app start` launches.
emit_pin_block() {
  echo "TALOS_APP_OWNER_UID=$OWNER_UID"
  echo 'TALOS_APP_ID=/usr/bin/id; [ -x "$TALOS_APP_ID" ] || TALOS_APP_ID=id'
  echo '[ -z "${TALOS_APP_TEST_ID:-}" ] || TALOS_APP_ID=$TALOS_APP_TEST_ID'
  echo 'if [ "$("$TALOS_APP_ID" -u)" != "$TALOS_APP_OWNER_UID" ]; then'
  echo '  if [ -z "${TALOS_APP_HOP:-}" ] && [ -n "${HOME:-}" ]; then'
  echo '    for w in "$HOME/.local/bin/talos-app" "$HOME/.bun/bin/talos-app"; do'
  echo '      if [ -f "$w" ] && [ -x "$w" ] && [ ! "$w" -ef "$0" ] && grep -q "talos-app-wrapper" "$w" 2>/dev/null; then'
  echo '        TALOS_APP_HOP=1; export TALOS_APP_HOP'
  echo '        exec "$w" "$@"'
  echo '      fi'
  echo '    done'
  echo '  fi'
  echo "  echo \"talos-app: this command belongs to another user's Talos. Install your own: run apps/bridge/scripts/install.sh from your Talos folder.\" >&2"
  echo '  exit 1'
  echo 'fi'
  echo 'unset TALOS_APP_HOP'
}

# An older wrapper of ours (no user pin) in a machine-wide folder on PATH still runs the installer's checkout for every
# user of the Mac. When this user owns it and can write it, add the pin block in place; BUN, home and cli target stay as
# they were. A file of another user, a read-only one, one without our mark, one inside $HOME is never touched.
# $1 = write | report (dry run: say, write nothing).
pin_old_wrappers() {
  local rest="$PATH:" entry f tmp line
  while [ -n "$rest" ]; do
    entry="${rest%%:*}"; rest="${rest#*:}"
    [ -n "$entry" ] || continue
    f="$entry/talos-app"
    inside_home "$entry" && continue
    { [ -f "$f" ] && [ -O "$f" ] && [ -w "$f" ] && [ -w "$entry" ]; } || continue
    grep -q "talos-app-wrapper" "$f" 2>/dev/null || continue
    ! grep -q '^TALOS_APP_OWNER_UID=' "$f" 2>/dev/null || continue
    if [ "$1" = report ]; then
      echo "would pin $f to your user id (an older wrapper of yours in a machine-wide folder; other users of this Mac would otherwise run your checkout from it)"
      continue
    fi
    tmp="$entry/talos-app.tmp.$$"
    if {
      while IFS= read -r line || [ -n "$line" ]; do
        printf '%s\n' "$line"
        case "$line" in "$WRAPPER_MARK"*) emit_pin_block ;; esac
      done < "$f"
    } > "$tmp" 2>/dev/null && chmod 755 "$tmp" 2>/dev/null && mv "$tmp" "$f" 2>/dev/null; then
      echo "pinned $f to your user id (an older wrapper of yours in a machine-wide folder; other users of this Mac no longer run your checkout from it)"
    else
      rm -f "$tmp" 2>/dev/null || true
      echo "WARNING: could not pin $f (an older wrapper of yours in a machine-wide folder); it still runs your checkout for any user of this Mac." >&2
    fi
  done
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
    WRAP_OLD_UID="$(wrapper_uid "$target")"
    if [ -n "$WRAP_OLD_UID" ] && [ "$WRAP_OLD_UID" != "$OWNER_UID" ]; then WRAP_STATE="kept"; WRAP_WHY="user"; return; fi
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
    emit_pin_block
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
  pin_old_wrappers report
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
    if "$WRAP_DIR/talos-app" help >/dev/null 2>&1; then echo "checked: $WRAP_DIR/talos-app runs"; else echo "WARNING: $WRAP_DIR/talos-app did not run; try: bun --no-env-file run $BRIDGE_DIR/src/cli.ts help" >&2; fi
    if [ "$WRAP_ON_PATH" != 1 ]; then
      echo "$WRAP_DIR is not on your PATH, so a new terminal will say 'command not found'. Add it once:"
      echo "  echo $(shq "$(path_line "$WRAP_DIR")") >> $(shq_if "$(shell_profile)")"
      echo "then open a new terminal (or run: $(path_line "$WRAP_DIR"))."
    fi
    # What a new terminal would really run: the first talos-app on this PATH, which may be another file.
    FOUND="$(command -v talos-app 2>/dev/null || true)"
    if [ -n "$FOUND" ] && [ -f "$FOUND" ] && [ ! "$FOUND" -ef "$WRAP_DIR/talos-app" ]; then
      echo "NOTE: a new terminal will run $FOUND, not the one just written ($WRAP_DIR/talos-app), because its folder comes earlier on your PATH."
      if grep -q "talos-app-wrapper" "$FOUND" 2>/dev/null; then
        echo "  $FOUND is a wrapper from an older install (it was written by this script, so it is a machine-wide or shared command)."
      else
        echo "  $FOUND was not written by this script."
      fi
      echo "  To use the new one: put $WRAP_DIR first on your PATH ($(path_line "$WRAP_DIR") in $(shq_if "$(shell_profile)")), or run this again with --bin-dir $(shq_if "$(dirname "$FOUND")") to write there instead."
      echo "  That file was not changed or removed."
    fi
    ;;
  kept)
    if [ "$WRAP_WHY" = user ]; then
      echo "WARNING: $WRAP_DIR/talos-app belongs to another user's Talos (user id $WRAP_OLD_UID), so it was left alone." >&2
    elif [ "$WRAP_WHY" = checkout ]; then
      echo "WARNING: $WRAP_DIR/talos-app already runs a different checkout ($WRAP_OLD_CLI), so it was left alone." >&2
    else
      echo "WARNING: $WRAP_DIR/talos-app already points at a different TALOS_APP_HOME ($WRAP_OLD_HOME), so it was left alone." >&2
    fi
    echo "NOT changed: your talos-app command. This install uses $HOME_DIR from $BRIDGE_DIR. To repoint the command here, run this again with --replace-wrapper."
    echo "Run the CLI for this install with: TALOS_APP_HOME=$(shq "$HOME_DIR") bun --no-env-file run $BRIDGE_DIR/src/cli.ts <command>"
    ;;
  unwritable)
    echo "NOT installed: could not write $WRAP_DIR/talos-app (is $WRAP_DIR writable?). Everything else was set up."
    echo "Run the CLI with: TALOS_APP_HOME=$(shq "$HOME_DIR") bun --no-env-file run $BRIDGE_DIR/src/cli.ts <command>   or pass --bin-dir <a folder you can write to> and run this again."
    ;;
  blocked)
    echo "NOT installed: $WRAP_DIR/talos-app already exists and was not written by this script (left alone)."
    echo "Run the CLI with: TALOS_APP_HOME=$(shq "$HOME_DIR") bun --no-env-file run $BRIDGE_DIR/src/cli.ts <command>   or pass --bin-dir <another folder> and run this again."
    ;;
esac

pin_old_wrappers write

# When the wrapper is not there (blocked or unwritable), the steps below use the long form so they still work.
if [ "$WRAP_STATE" = written ]; then TA="talos-app"; else TA="TALOS_APP_HOME=$(shq "$HOME_DIR") bun --no-env-file run $BRIDGE_DIR/src/cli.ts"; fi
# A folder without the Talos kit (the kit-marker.ts test: CLAUDE.md with .talos-version, or the kit 1.x shape) is a plain
# Claude Code folder: start refuses it unless told --no-kit once (the bridge then remembers it, and doctor only warns).
NOKIT=" --no-kit"
if [ -f "$AGENT_DIR/CLAUDE.md" ] && { [ -f "$AGENT_DIR/.talos-version" ] || { [ -d "$AGENT_DIR/memory" ] && [ -d "$AGENT_DIR/hooks" ] && [ -d "$AGENT_DIR/scripts" ]; }; }; then NOKIT=""; fi
cat <<MSG

Next:
  1. Put the BRIDGE_PUBKEY line above into the relay's environment and press Deploy in Railway.
  2. Start your agent (keep your existing flags after the --):
       $TA start --agent-dir $AGENT_DIR$NOKIT -- <your existing claude flags>
     That runs: TALOS_APP_BRIDGE=1 MCP_PROTOCOL_NEGOTIATION=legacy claude <your flags> --dangerously-load-development-channels server:talos-app
  3. Then run: $TA doctor --agent-dir $AGENT_DIR, and $TA enroll to add your phone.
MSG
